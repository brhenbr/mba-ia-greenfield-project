import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
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
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { cleanQueues } from '../test/clean-queue';
import { cleanStorage } from '../test/clean-storage';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideoUploadsService } from './video-uploads.service';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const MIB = 1024 * 1024;

describe('VideoUploadsService (integration: DB + MinIO + Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideoUploadsService;
  let dataSource: DataSource;
  let queue: Queue;
  let user: User;
  let queueCfg: ConfigType<typeof queueConfig>;
  let storageCfg: ConfigType<typeof storageConfig>;

  const clean = async () => {
    await cleanAllTables(dataSource);
    await cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: queueCfg.host, port: queueCfg.port },
      queueCfg.prefix,
    );
    await cleanStorage(
      moduleRef.get<S3Client>(S3_INTERNAL_CLIENT, { strict: false }),
      storageCfg.bucket,
      'videos/',
    );
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
        VideosModule,
      ],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(VideoUploadsService);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE), {
      strict: false,
    });
    queueCfg = moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
    storageCfg = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
  });

  beforeEach(async () => {
    await clean();
    user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@test.dev', password: 'hash' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'Uploader', nickname: 'uploader', user_id: user.id });
  });

  afterAll(async () => {
    await clean();
    await moduleRef.close();
  });

  const putPart = async (url: string, size: number): Promise<string> => {
    const response = await fetch(url, {
      method: 'PUT',
      body: Buffer.alloc(size, 1),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  };

  it('should leave the row processing and the job queued after a full upload', async () => {
    const size = 5 * MIB + 1024; // 2 parts with the 5 MiB test part size
    const started = await service.startUpload(user.id, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: size,
    });
    expect(started).toMatchObject({
      status: VideoStatus.DRAFT,
      partSizeBytes: 5 * MIB,
      partCount: 2,
    });

    const { parts } = await service.getPartUrls(
      user.id,
      started.publicId,
      [1, 2],
    );
    const etags = [
      await putPart(parts[0].url, 5 * MIB),
      await putPart(parts[1].url, 1024),
    ];
    const completed = await service.completeUpload(user.id, started.publicId, {
      parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
    });

    expect(completed).toEqual({
      publicId: started.publicId,
      status: VideoStatus.PROCESSING,
    });
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: started.publicId });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.processing_started_at).toBeInstanceOf(Date);
    expect(row.upload_id).toBeNull();
    expect(row.title).toBeNull();
    const job = await queue.getJob(row.id);
    expect(job?.data).toEqual({ videoId: row.id });
  });
});
