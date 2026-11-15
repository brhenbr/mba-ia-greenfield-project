import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videosConfig from '../config/videos.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER_ID,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { cleanQueues } from '../test/clean-queue';
import { VideoMaintenanceScheduler } from './video-maintenance.scheduler';

describe('VideoMaintenanceScheduler (integration, real Redis)', () => {
  let moduleRef: TestingModule;
  let scheduler: VideoMaintenanceScheduler;
  let queue: Queue;
  let queueCfg: ConfigType<typeof queueConfig>;
  let videosCfg: ConfigType<typeof videosConfig>;

  const clean = () =>
    cleanQueues(
      [VIDEO_PROCESSING_QUEUE, VIDEO_MAINTENANCE_QUEUE],
      { host: queueCfg.host, port: queueCfg.port },
      queueCfg.prefix,
    );

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videosConfig],
        }),
        QueueModule,
      ],
      providers: [VideoMaintenanceScheduler],
    }).compile();
    scheduler = moduleRef.get(VideoMaintenanceScheduler);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
    queueCfg = moduleRef.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
    videosCfg = moduleRef.get<ConfigType<typeof videosConfig>>(
      videosConfig.KEY,
    );
    await clean();
  });

  afterAll(async () => {
    await clean();
    await moduleRef.close();
  });

  it('should register the sweep with the configured interval, once, even when registered twice', async () => {
    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: VIDEO_MAINTENANCE_SCHEDULER_ID,
      name: 'sweep',
      every: videosCfg.sweepIntervalMs,
    });
  });
});
