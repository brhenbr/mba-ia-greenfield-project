import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue, Worker } from 'bullmq';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanQueues } from '../test/clean-queue';
import { cleanStorage } from '../test/clean-storage';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideoMaintenanceService } from './video-maintenance.service';
import { VideoStatus } from './video-status.enum';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('VideoMaintenanceService (integration: DB + MinIO + Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideoMaintenanceService;
  let storage: StorageService;
  let dataSource: DataSource;
  let queue: Queue;
  let s3: S3Client;
  let queueCfg: ConfigType<typeof queueConfig>;
  let storageCfg: ConfigType<typeof storageConfig>;
  let videosCfg: ConfigType<typeof videosConfig>;
  let channel: Channel;

  const seed = async (overrides: Partial<Video>) => {
    const id = randomUUID();
    await dataSource.getRepository(Video).insert({
      id,
      public_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channel.id,
      source_key: `videos/${id}/source.mp4`,
      ...overrides,
    });
    return id;
  };

  const openUploads = async () => {
    // MinIO answers an empty list when a Prefix is passed: filter client-side.
    const result = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: storageCfg.bucket }),
    );
    return (result.Uploads ?? [])
      .map((u) => u.Key as string)
      .filter((key) => key.startsWith('videos/'));
  };

  const clean = async () => {
    await cleanAllTables(dataSource);
    await cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: queueCfg.host, port: queueCfg.port },
      queueCfg.prefix,
    );
    await cleanStorage(s3, storageCfg.bucket, 'videos/');
  };

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        QueueModule,
      ],
      providers: [VideoMaintenanceService],
    }).compile();
    service = moduleRef.get(VideoMaintenanceService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    s3 = moduleRef.get<S3Client>(S3_INTERNAL_CLIENT);
    queueCfg = moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
    storageCfg = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    videosCfg = moduleRef.get<ConfigType<typeof videosConfig>>(
      videosConfig.KEY,
    );
    await storage.ensureBucket();
  });

  beforeEach(async () => {
    await clean();
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'sweep@test.dev', password: 'hash' });
    channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Sweep', nickname: 'sweep', user_id: user.id });
  });

  afterAll(async () => {
    await clean();
    await moduleRef.close();
  });

  describe('reenqueueStuckProcessing', () => {
    it('should re-enqueue a stuck processing video exactly once, even when the sweep runs twice', async () => {
      const id = await seed({
        status: VideoStatus.PROCESSING,
        processing_started_at: new Date(
          Date.now() - (videosCfg.processingStuckMinutes + 10) * MINUTE,
        ),
      });

      await service.reenqueueStuckProcessing();
      await service.reenqueueStuckProcessing();

      expect((await queue.getJob(id))?.data).toEqual({ videoId: id });
      expect(await queue.getJobCountByTypes('waiting', 'delayed')).toBe(1);
    });

    it('should leave a recently started processing video alone', async () => {
      await seed({
        status: VideoStatus.PROCESSING,
        processing_started_at: new Date(Date.now() - 5 * MINUTE),
      });

      await service.reenqueueStuckProcessing();

      expect(
        await queue.getJobCountByTypes('waiting', 'active', 'delayed'),
      ).toBe(0);
    });

    it('should ignore videos that are not processing', async () => {
      await seed({
        status: VideoStatus.READY,
        processing_started_at: new Date(Date.now() - 5 * DAY),
      });

      await service.reenqueueStuckProcessing();

      expect(
        await queue.getJobCountByTypes('waiting', 'active', 'delayed'),
      ).toBe(0);
    });

    it('should replace a retained failed job so the video is processed again', async () => {
      const id = await seed({
        status: VideoStatus.PROCESSING,
        processing_started_at: new Date(Date.now() - 2 * DAY),
      });
      // Leave a failed job with the video's id behind, as a lost status update would.
      await queue.add(
        'process-video',
        { videoId: id },
        { jobId: id, attempts: 1 },
      );
      const failing = new Worker(
        VIDEO_PROCESSING_QUEUE,
        () => Promise.reject(new Error('boom')),
        {
          connection: { host: queueCfg.host, port: queueCfg.port },
          prefix: queueCfg.prefix,
        },
      );
      const job = (await queue.getJob(id))!;
      for (let i = 0; i < 100 && (await job.getState()) !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await failing.close();
      expect(await job.getState()).toBe('failed');

      await service.reenqueueStuckProcessing();

      expect(await (await queue.getJob(id))!.getState()).toBe('waiting');
    });
  });

  describe('cleanupAbandonedDrafts', () => {
    const seedDraft = async (createdAt: Date) => {
      const id = randomUUID();
      const sourceKey = `videos/${id}/source.mp4`;
      const uploadId = await storage.createMultipartUpload(
        sourceKey,
        'video/mp4',
      );
      await seed({
        id,
        status: VideoStatus.DRAFT,
        source_key: sourceKey,
        upload_id: uploadId,
        created_at: createdAt,
      });
      return { id, sourceKey, uploadId };
    };

    it('should abort the multipart upload and delete an abandoned draft', async () => {
      const old = await seedDraft(
        new Date(Date.now() - (videosCfg.draftTtlDays + 1) * DAY),
      );

      expect(await openUploads()).toContain(old.sourceKey); // guards against a vacuous check below

      const removed = await service.cleanupAbandonedDrafts();

      expect(removed).toBe(1);
      expect(
        await dataSource.getRepository(Video).countBy({ id: old.id }),
      ).toBe(0);
      expect(await openUploads()).not.toContain(old.sourceKey);
    });

    it('should keep a recent draft and its upload', async () => {
      const recent = await seedDraft(new Date());

      const removed = await service.cleanupAbandonedDrafts();

      expect(removed).toBe(0);
      expect(
        await dataSource.getRepository(Video).countBy({ id: recent.id }),
      ).toBe(1);
      expect(await openUploads()).toContain(recent.sourceKey);
    });

    it('should delete an old draft whose upload is already gone', async () => {
      const old = await seedDraft(new Date(Date.now() - 10 * DAY));
      await storage.abortMultipartUpload(old.sourceKey, old.uploadId);

      await expect(service.cleanupAbandonedDrafts()).resolves.toBe(1);
    });

    it('should never delete a video that is no longer a draft', async () => {
      const id = await seed({
        status: VideoStatus.PROCESSING,
        created_at: new Date(Date.now() - 10 * DAY),
        processing_started_at: new Date(),
      });

      await service.cleanupAbandonedDrafts();

      expect(await dataSource.getRepository(Video).countBy({ id })).toBe(1);
    });
  });
});
