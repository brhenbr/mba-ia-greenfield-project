import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';

describe('QueueModule', () => {
  it('should compile and register both queues and the producer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(moduleRef.get(VideoQueueService)).toBeInstanceOf(VideoQueueService);
    expect(moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    expect(moduleRef.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE))).toBeDefined();

    await moduleRef.close();
  });
});
