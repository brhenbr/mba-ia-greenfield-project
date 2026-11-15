import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videosConfig from '../config/videos.config';
import {
  SWEEP_JOB,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER_ID,
} from '../queue/queue.constants';

/** Registers the periodic maintenance sweep as a BullMQ job scheduler. */
@Injectable()
export class VideoMaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  // Upsert is idempotent: restarting the worker (or running several) never
  // creates a second scheduler.
  async onApplicationBootstrap(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      VIDEO_MAINTENANCE_SCHEDULER_ID,
      { every: this.config.sweepIntervalMs },
      { name: SWEEP_JOB, data: {} },
    );
  }
}
