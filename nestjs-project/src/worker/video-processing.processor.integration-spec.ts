import { randomUUID } from 'crypto';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { S3Client } from '@aws-sdk/client-s3';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import type { ProcessVideoJobData } from '../queue/queue.constants';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanStorage } from '../test/clean-storage';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosService } from '../videos/videos.service';
import { MediaProbeError, MediaProbeService } from './media-probe.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);
const PROBE = {
  durationSeconds: 2,
  metadata: {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    audioCodec: null,
    width: 320,
    height: 240,
    bitrate: 28000,
    sizeBytes: 6955,
  },
};

describe('VideoProcessingProcessor (integration: DB + MinIO, FFmpeg mocked)', () => {
  let moduleRef: TestingModule;
  let processor: VideoProcessingProcessor;
  let storage: StorageService;
  let dataSource: DataSource;
  let s3: S3Client;
  const probe = { probe: jest.fn(), extractThumbnail: jest.fn() };

  const makeJob = (
    videoId: string,
    overrides: { attemptsMade?: number; attempts?: number } = {},
  ) =>
    ({
      id: videoId,
      data: { videoId },
      attemptsMade: overrides.attemptsMade ?? 0,
      opts: { attempts: overrides.attempts ?? 3 },
    }) as unknown as Job<ProcessVideoJobData>;

  const createVideo = async (status = VideoStatus.PROCESSING) => {
    const id = randomUUID();
    const sourceKey = `videos/${id}/source.mp4`;
    await storage.putObject(
      sourceKey,
      Buffer.from('source bytes'),
      'video/mp4',
    );
    const channel = await dataSource.getRepository(Channel).findOneByOrFail({});
    await dataSource.getRepository(Video).insert({
      id,
      public_id: id.slice(0, 11),
      channel_id: channel.id,
      source_key: sourceKey,
      status,
    });
    return id;
  };

  const rowOf = (id: string) =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

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
      ],
      providers: [
        VideosService,
        VideoProcessingProcessor,
        { provide: MediaProbeService, useValue: probe },
      ],
    }).compile();
    processor = moduleRef.get(VideoProcessingProcessor);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    s3 = moduleRef.get<S3Client>(S3_INTERNAL_CLIENT);
    await storage.ensureBucket();
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@test.dev', password: 'hash' });
    await dataSource
      .getRepository(Channel)
      .save({ name: 'Worker', nickname: 'worker', user_id: user.id });
    probe.probe.mockResolvedValue(PROBE);
    probe.extractThumbnail.mockResolvedValue(JPEG);
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    const { bucket } = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    await cleanStorage(s3, bucket, 'videos/');
    await cleanStorage(s3, bucket, 'thumbnails/');
    await moduleRef.close();
  });

  it('should move a processing video to ready with duration, metadata and thumbnail', async () => {
    const id = await createVideo();

    await processor.process(makeJob(id));

    const row = await rowOf(id);
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration_seconds).toBe(2);
    expect(row.metadata).toMatchObject({
      container: PROBE.metadata.container,
      width: 320,
    });
    expect(row.thumbnail_key).toBe(`thumbnails/${id}/default.jpg`);
    await expect(
      storage.headObject(`thumbnails/${id}/default.jpg`),
    ).resolves.toEqual({
      contentLength: JPEG.length,
      contentType: 'image/jpeg',
    });
    // The worker reads the source through an internal presigned URL.
    expect(probe.probe).toHaveBeenCalledWith(
      expect.stringContaining(`videos/${id}/source.mp4`),
    );
  });

  it('should throw an unrecoverable NOT_A_VIDEO and mark the video as error without retrying', async () => {
    const id = await createVideo();
    probe.probe.mockRejectedValue(
      new MediaProbeError('NOT_A_VIDEO', 'no video stream'),
    );
    const job = makeJob(id, { attemptsMade: 1 });

    const error = await processor.process(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    await processor.onFailed(job, error as Error);

    const row = await rowOf(id);
    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.failure_reason).toBe('NOT_A_VIDEO');
    expect(probe.extractThumbnail).not.toHaveBeenCalled();
  });

  it('should leave the video processing while retries remain and fail it when they are exhausted', async () => {
    const id = await createVideo();
    probe.probe.mockRejectedValue(
      new MediaProbeError('PROBE_FAILED', 'ffprobe timed out'),
    );

    const firstTry = makeJob(id, { attemptsMade: 1 });
    const error = (await processor
      .process(firstTry)
      .catch((e: unknown) => e)) as Error;
    await processor.onFailed(firstTry, error);
    expect((await rowOf(id)).status).toBe(VideoStatus.PROCESSING);

    await processor.onFailed(makeJob(id, { attemptsMade: 3 }), error);
    const row = await rowOf(id);
    expect(row.status).toBe(VideoStatus.ERROR);
    expect(row.failure_reason).toBe('PROBE_FAILED');
  });

  it('should fail with SOURCE_MISSING when the source object is absent', async () => {
    const id = await createVideo();
    await dataSource
      .getRepository(Video)
      .update({ id }, { source_key: `videos/${id}/gone.mp4` });

    const error = (await processor
      .process(makeJob(id))
      .catch((e: unknown) => e)) as Error;
    await processor.onFailed(makeJob(id, { attemptsMade: 3 }), error);

    expect((await rowOf(id)).failure_reason).toBe('SOURCE_MISSING');
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('should leave a ready video untouched when the job is delivered again', async () => {
    const id = await createVideo();
    await processor.process(makeJob(id));
    const before = await rowOf(id);
    probe.probe.mockClear();

    await processor.process(makeJob(id));

    const after = await rowOf(id);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('should end quietly without changing a video that is no longer processing', async () => {
    const id = await createVideo(VideoStatus.DRAFT);
    const before = await rowOf(id);

    await expect(processor.process(makeJob(id))).resolves.toBeUndefined();

    const after = await rowOf(id);
    expect(after.status).toBe(VideoStatus.DRAFT);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it('should end quietly when the video no longer exists', async () => {
    await expect(
      processor.process(makeJob(randomUUID())),
    ).resolves.toBeUndefined();
  });
});
