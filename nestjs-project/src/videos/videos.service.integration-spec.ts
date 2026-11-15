import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  VideoInvalidStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import * as publicIdUtil from './public-id.util';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let moduleRef: TestingModule;
  let service: VideosService;
  let owner: { user: User; channel: Channel };

  const createOwner = async (email: string, nickname: string) => {
    const user = await dataSource
      .getRepository(User)
      .save({ email, password: 'hash' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: nickname, nickname, user_id: user.id });
    return { user, channel };
  };

  const draftInput = (channelId: string) => {
    const id = randomUUID();
    return {
      id,
      channelId,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
      sourceKey: `videos/${id}/source.mp4`,
      uploadId: 'upload-1',
    };
  };

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: dataSource.getRepository(Video),
        },
      ],
    }).compile();
    service = moduleRef.get(VideosService);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    owner = await createOwner('owner@test.dev', 'owner');
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  describe('createDraft', () => {
    it('should store a draft with an 11-character public id', async () => {
      const video = await service.createDraft(draftInput(owner.channel.id));

      expect(video.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.title).toBeNull();
      expect(video.upload_id).toBe('upload-1');
    });

    it('should retry with a new public id after a collision', async () => {
      const first = await service.createDraft(draftInput(owner.channel.id));
      jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValueOnce(first.public_id)
        .mockReturnValueOnce('freshpub_1x');

      const second = await service.createDraft(draftInput(owner.channel.id));

      expect(second.public_id).toBe('freshpub_1x');
    });

    it('should give up after 5 colliding attempts', async () => {
      const first = await service.createDraft(draftInput(owner.channel.id));
      const spy = jest
        .spyOn(publicIdUtil, 'generatePublicId')
        .mockReturnValue(first.public_id);

      await expect(
        service.createDraft(draftInput(owner.channel.id)),
      ).rejects.toBeInstanceOf(QueryFailedError);
      expect(spy).toHaveBeenCalledTimes(5);
    });
  });

  describe('findOwnedByPublicId', () => {
    it('should return the video to its owner', async () => {
      const video = await service.createDraft(draftInput(owner.channel.id));

      const found = await service.findOwnedByPublicId(
        video.public_id,
        owner.user.id,
      );

      expect(found.id).toBe(video.id);
    });

    it('should answer not found for another user', async () => {
      const video = await service.createDraft(draftInput(owner.channel.id));
      const other = await createOwner('other@test.dev', 'other');

      await expect(
        service.findOwnedByPublicId(video.public_id, other.user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should answer not found for unknown and malformed ids', async () => {
      await expect(
        service.findOwnedByPublicId('doesnotexis', owner.user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.findOwnedByPublicId("x'; DROP TABLE videos;--", owner.user.id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('countOpenDrafts', () => {
    it('should count only the unfinished uploads of that channel', async () => {
      await service.createDraft(draftInput(owner.channel.id));
      await service.createDraft(draftInput(owner.channel.id));
      const processing = await service.createDraft(
        draftInput(owner.channel.id),
      );
      await service.markProcessing(processing.id);
      const other = await createOwner('other-drafts@test.dev', 'otherdrafts');
      await service.createDraft(draftInput(other.channel.id));

      await expect(service.countOpenDrafts(owner.channel.id)).resolves.toBe(2);
      await expect(service.countOpenDrafts(other.channel.id)).resolves.toBe(1);
    });
  });

  describe('markProcessing', () => {
    it('should move a draft to processing, stamp the start time and clear the upload id', async () => {
      const video = await service.createDraft(draftInput(owner.channel.id));

      await service.markProcessing(video.id);

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.processing_started_at).toBeInstanceOf(Date);
      expect(row.upload_id).toBeNull();
    });

    it('should refuse a video that is no longer a draft', async () => {
      const video = await service.createDraft(draftInput(owner.channel.id));
      await service.markProcessing(video.id);

      await expect(service.markProcessing(video.id)).rejects.toBeInstanceOf(
        VideoInvalidStateException,
      );
    });

    it('should let exactly one of two concurrent calls win', async () => {
      const video = await service.createDraft(draftInput(owner.channel.id));

      const results = await Promise.allSettled([
        service.markProcessing(video.id),
        service.markProcessing(video.id),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
  });
});
