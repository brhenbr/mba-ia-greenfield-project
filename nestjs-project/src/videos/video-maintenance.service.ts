import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
// Bounds one sweep; whatever is left is picked up by the next run.
const BATCH_SIZE = 200;

/**
 * Closes the consistency gaps between the database, the queue and storage
 * (per TD-10). Runs in the worker, from the maintenance sweep.
 */
@Injectable()
export class VideoMaintenanceService {
  private readonly logger = new Logger(VideoMaintenanceService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  /**
   * Videos stuck in `processing` (the enqueue after commit failed, or the job
   * was lost) go back to the queue. Idempotent: one job per video id.
   * Returns how many videos were examined for re-enqueue.
   */
  async reenqueueStuckProcessing(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.processingStuckMinutes * MS_PER_MINUTE,
    );
    const stuck = await this.videoRepository.find({
      select: { id: true },
      where: {
        status: VideoStatus.PROCESSING,
        processing_started_at: LessThan(cutoff),
      },
      take: BATCH_SIZE,
    });

    for (const video of stuck) {
      // Background sweep: one failing video must not stop the others.
      try {
        await this.videoQueueService.requeueProcessing(video.id);
      } catch (error) {
        this.logger.error(
          `Could not re-enqueue video ${video.id}: ${String(error)}`,
        );
      }
    }
    return stuck.length;
  }

  /**
   * Drafts older than the TTL were never completed: abort their multipart
   * upload (frees the stored parts) and delete the row. A draft whose abort
   * fails is kept and retried by the next sweep. Returns how many were removed.
   */
  async cleanupAbandonedDrafts(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.draftTtlDays * MS_PER_DAY,
    );
    const abandoned = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
      take: BATCH_SIZE,
    });

    let removed = 0;
    for (const video of abandoned) {
      try {
        if (video.upload_id) {
          await this.storageService.abortMultipartUpload(
            video.source_key,
            video.upload_id,
          );
        }
        // Conditional on `draft`: never deletes a video completed meanwhile.
        const result = await this.videoRepository.delete({
          id: video.id,
          status: VideoStatus.DRAFT,
        });
        removed += result.affected ?? 0;
      } catch (error) {
        this.logger.error(
          `Could not clean up draft ${video.id}; it will be retried: ${String(error)}`,
        );
      }
    }
    return removed;
  }
}
