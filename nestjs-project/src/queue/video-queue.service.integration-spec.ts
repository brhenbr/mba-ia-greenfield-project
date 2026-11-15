import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import queueConfig from '../config/queue.config';
import { cleanQueues } from '../test/clean-queue';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';

describe('VideoQueueService (integration, real Redis)', () => {
  let moduleRef: TestingModule;
  let service: VideoQueueService;
  let queue: Queue;
  let config: ConfigType<typeof queueConfig>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    service = moduleRef.get(VideoQueueService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    config = moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  });

  beforeEach(async () => {
    await cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: config.host, port: config.port },
      config.prefix,
    );
  });

  afterAll(async () => {
    await cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: config.host, port: config.port },
      config.prefix,
    );
    await moduleRef.close();
  });

  it('should create one job whose id is the video id and whose data is the video id', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job?.id).toBe(videoId);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId });
    expect(await queue.getJobCountByTypes('waiting')).toBe(1);
  });

  it('should not create a second job when the same video is enqueued again', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);
    await service.enqueueProcessing(videoId);

    expect(await queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(
      1,
    );
  });

  it('should inherit 3 attempts and an exponential 5000 ms backoff', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should store the job in Redis under the configured QUEUE_PREFIX', async () => {
    const videoId = randomUUID();

    await service.enqueueProcessing(videoId);

    const redis = new Redis({ host: config.host, port: config.port });
    try {
      const keys = await redis.keys(
        `${config.prefix}:${VIDEO_PROCESSING_QUEUE}:${videoId}`,
      );
      expect(keys).toHaveLength(1);
      expect(config.prefix).toBe('streamtube-test');
    } finally {
      redis.disconnect();
    }
  });
});
