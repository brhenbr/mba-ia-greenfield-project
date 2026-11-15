import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { VideoQueueService } from './video-queue.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.prefix,
      }),
    }),
    BullModule.registerQueueAsync(
      {
        name: VIDEO_PROCESSING_QUEUE,
        useFactory: () => ({
          defaultJobOptions: { ...VIDEO_PROCESSING_JOB_OPTIONS },
        }),
      },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
  ],
  providers: [VideoQueueService],
  exports: [BullModule, VideoQueueService],
})
export class QueueModule {}
