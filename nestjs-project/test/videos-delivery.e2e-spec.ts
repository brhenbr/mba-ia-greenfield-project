import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { bodyOf, errorBodyOf } from '../src/test/body-of';
import { cleanStorage } from '../src/test/clean-storage';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import type { VideoStatusResponseDto } from '../src/videos/dto/video-status-response.dto';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';

describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let s3: S3Client;
  let storageCfg: ConfigType<typeof storageConfig>;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let channel: Channel;

  const SOURCE = Buffer.alloc(2048, 5);
  const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

  const createUser = async (email: string, nickname: string) => {
    const user = await dataSource
      .getRepository(User)
      .save({ email, password: 'hash', is_confirmed: true });
    const ch = await dataSource
      .getRepository(Channel)
      .save({ name: nickname, nickname, user_id: user.id });
    const jwt = app.get(JwtService, { strict: false });
    return { token: jwt.sign({ sub: user.id, email }), channel: ch };
  };

  /** Inserts a video row (and its objects) in the requested status. */
  const seedVideo = async (
    status: VideoStatus,
    overrides: Partial<Video> = {},
    withObjects = status === VideoStatus.READY,
  ) => {
    const id = randomUUID();
    const sourceKey = `videos/${id}/source.mp4`;
    const thumbnailKey = `thumbnails/${id}/default.jpg`;
    if (withObjects) {
      await storage.putObject(sourceKey, SOURCE, 'video/mp4');
      await storage.putObject(thumbnailKey, THUMB, 'image/jpeg');
    }
    const publicId = id.replace(/-/g, '').slice(0, 11);
    await dataSource.getRepository(Video).insert({
      id,
      public_id: publicId,
      channel_id: channel.id,
      status,
      source_key: sourceKey,
      thumbnail_key: status === VideoStatus.READY ? thumbnailKey : null,
      original_filename: 'clip.mp4',
      duration_seconds: status === VideoStatus.READY ? 2 : null,
      metadata:
        status === VideoStatus.READY
          ? {
              container: 'mov,mp4',
              videoCodec: 'h264',
              audioCodec: null,
              width: 320,
              height: 240,
              bitrate: 28000,
              sizeBytes: SOURCE.length,
            }
          : null,
      ...overrides,
    });
    return publicId;
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService, { strict: false });
    s3 = moduleFixture.get<S3Client>(S3_INTERNAL_CLIENT, { strict: false });
    storageCfg = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
      { strict: false },
    );
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  const clean = async () => {
    await cleanAllTables(dataSource);
    await cleanStorage(s3, storageCfg.bucket, 'videos/');
    await cleanStorage(s3, storageCfg.bucket, 'thumbnails/');
  };

  beforeEach(async () => {
    await clean();
    throttlerStorage.storage.clear();
    const owner = await createUser('owner@test.dev', 'owner');
    ownerToken = owner.token;
    channel = owner.channel;
    otherToken = (await createUser('other@test.dev', 'other')).token;
  });

  afterAll(async () => {
    await clean();
    await app.close();
  });

  describe('GET /videos/:publicId', () => {
    it('should return the status, duration and metadata to the owner', async () => {
      const publicId = await seedVideo(VideoStatus.READY);

      const body = await bodyOf<VideoStatusResponseDto>(
        request(app.getHttpServer())
          .get(`/videos/${publicId}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200),
      );

      expect(body).toMatchObject({
        publicId,
        status: 'ready',
        title: null,
        originalFilename: 'clip.mp4',
        durationSeconds: 2,
        failureReason: null,
        metadata: { container: 'mov,mp4', width: 320, height: 240 },
      });
      expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt);
    });

    it('should expose the failure reason of an errored video', async () => {
      const publicId = await seedVideo(VideoStatus.ERROR, {
        failure_reason: 'NOT_A_VIDEO',
      });

      const body = await bodyOf<VideoStatusResponseDto>(
        request(app.getHttpServer())
          .get(`/videos/${publicId}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200),
      );

      expect(body).toMatchObject({
        status: 'error',
        failureReason: 'NOT_A_VIDEO',
        durationSeconds: null,
        metadata: null,
      });
    });

    it('should answer 404 to another user and 401 without a token', async () => {
      const publicId = await seedVideo(VideoStatus.READY);

      const body = await errorBodyOf(
        request(app.getHttpServer())
          .get(`/videos/${publicId}`)
          .set('Authorization', `Bearer ${otherToken}`)
          .expect(404),
      );
      await request(app.getHttpServer()).get(`/videos/${publicId}`).expect(401);

      expect(body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('should not be rate limited at the global 10 requests per minute', async () => {
      const publicId = await seedVideo(VideoStatus.READY);

      for (let i = 0; i < 15; i++) {
        await request(app.getHttpServer())
          .get(`/videos/${publicId}`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .expect(200);
      }
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('should redirect anonymous callers to a presigned URL that serves ranges', async () => {
      const publicId = await seedVideo(VideoStatus.READY);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .expect(302);

      expect(response.headers['cache-control']).toBe('no-store');
      // Only Express's short redirect notice: no video bytes pass through the API.
      expect(response.text).toMatch(/^Found\. Redirecting to /);
      expect(Buffer.byteLength(response.text)).toBeLessThan(2000);
      const ranged = await fetch(response.headers.location, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-99/${SOURCE.length}`,
      );
      await ranged.arrayBuffer();
    });

    it('should not be rate limited at the global 10 requests per minute', async () => {
      const publicId = await seedVideo(VideoStatus.READY);

      for (let i = 0; i < 15; i++) {
        await request(app.getHttpServer())
          .get(`/videos/${publicId}/stream`)
          .expect(302);
      }
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('should redirect to a URL that answers with an attachment disposition', async () => {
      const publicId = await seedVideo(VideoStatus.READY, {
        original_filename: 'holiday.mp4',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const download = await fetch(response.headers.location, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(download.headers.get('content-disposition')).toBe(
        'attachment; filename="holiday.mp4"',
      );
      await download.arrayBuffer();
    });

    it('should strip quotes and line breaks from the original filename', async () => {
      const publicId = await seedVideo(VideoStatus.READY, {
        original_filename: 'my "clip"\r\nname.mp4',
      });

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .expect(302);

      const download = await fetch(response.headers.location, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(download.headers.get('content-disposition')).toBe(
        'attachment; filename="my clipname.mp4"',
      );
      await download.arrayBuffer();
    });
  });

  describe('GET /videos/:publicId/thumbnail', () => {
    it('should redirect to a presigned URL that serves the JPEG', async () => {
      const publicId = await seedVideo(VideoStatus.READY);

      const response = await request(app.getHttpServer())
        .get(`/videos/${publicId}/thumbnail`)
        .expect(302);

      const thumbnail = await fetch(response.headers.location);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await thumbnail.arrayBuffer()).equals(THUMB)).toBe(
        true,
      );
    });
  });

  describe.each(['stream', 'download', 'thumbnail'])(
    'GET /videos/:publicId/%s for videos that are not deliverable',
    (route) => {
      it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
        'should answer 404 VIDEO_NOT_FOUND for a %s video',
        async (status) => {
          const publicId = await seedVideo(status);

          const body = await errorBodyOf(
            request(app.getHttpServer())
              .get(`/videos/${publicId}/${route}`)
              .expect(404),
          );

          expect(body.error).toBe('VIDEO_NOT_FOUND');
        },
      );

      it('should answer 404 VIDEO_NOT_FOUND for an unknown id', async () => {
        const body = await errorBodyOf(
          request(app.getHttpServer())
            .get(`/videos/unknownid_1/${route}`)
            .expect(404),
        );

        expect(body.error).toBe('VIDEO_NOT_FOUND');
      });
    },
  );

  it('should answer 404 for a ready video that has no thumbnail', async () => {
    const publicId = await seedVideo(VideoStatus.READY, {
      thumbnail_key: null,
    });

    await request(app.getHttpServer())
      .get(`/videos/${publicId}/thumbnail`)
      .expect(404);
  });
});
