import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VIDEO_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { VideoMaintenanceService } from '../videos/video-maintenance.service';

@Processor(VIDEO_MAINTENANCE_QUEUE)
export class VideoMaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoMaintenanceProcessor.name);

  constructor(private readonly maintenanceService: VideoMaintenanceService) {
    super();
  }

  /**
   * Runs both routines on every sweep. A failure in one never prevents the
   * other from running; if any failed, the job is failed afterwards so it
   * shows up in BullMQ (the next scheduled sweep still happens).
   */
  async process(): Promise<void> {
    const failures: string[] = [];

    try {
      const count = await this.maintenanceService.reenqueueStuckProcessing();
      this.logger.log(`Stuck processing videos examined: ${count}`);
    } catch (error) {
      failures.push(`reenqueueStuckProcessing: ${String(error)}`);
    }

    try {
      const count = await this.maintenanceService.cleanupAbandonedDrafts();
      this.logger.log(`Abandoned drafts removed: ${count}`);
    } catch (error) {
      failures.push(`cleanupAbandonedDrafts: ${String(error)}`);
    }

    if (failures.length > 0) {
      throw new Error(`Maintenance sweep failed: ${failures.join('; ')}`);
    }
  }
}
