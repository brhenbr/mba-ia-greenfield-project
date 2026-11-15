import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

@Injectable()
export class VideoQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Enqueues processing for a video. The job id is the video id, so a second
   * call while the job still exists is ignored by BullMQ (one job per video).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    await this.processingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { jobId: videoId },
    );
  }
}
