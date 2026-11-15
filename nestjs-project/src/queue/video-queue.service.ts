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

  /**
   * Re-enqueues a video whose job may be gone or finished. A job that is still
   * waiting, active or delayed is left alone (it will be processed); a retained
   * completed or failed job is removed first, otherwise BullMQ would ignore
   * the new job because its id already exists.
   */
  async requeueProcessing(videoId: string): Promise<void> {
    const existing = await this.processingQueue.getJob(videoId);
    if (existing) {
      const state = await existing.getState();
      if (state !== 'completed' && state !== 'failed') {
        return;
      }
      await existing.remove();
    }
    await this.enqueueProcessing(videoId);
  }
}
