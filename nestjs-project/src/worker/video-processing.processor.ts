import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideosService } from '../videos/videos.service';
import {
  MediaProbeError,
  MediaProbeService,
  thumbnailInstant,
} from './media-probe.service';
import {
  VideoFailureReason,
  VideoProcessingError,
} from './video-processing.errors';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly mediaProbeService: MediaProbeService,
    @Inject(videosConfig.KEY)
    private readonly videosCfg: ConfigType<typeof videosConfig>,
  ) {
    super();
  }

  // The decorator cannot read config (it is evaluated before ConfigModule loads
  // the .env), so the concurrency is applied once the worker exists.
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.videosCfg.workerConcurrency;
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videosService.findById(job.data.videoId);
    if (!video || video.status !== VideoStatus.PROCESSING) {
      // Late or duplicate delivery: nothing to do, and no error to retry.
      this.logger.log(
        `Skipping job ${job.id}: video is ${video ? video.status : 'missing'}`,
      );
      return;
    }

    const head = await this.fromStorage(() =>
      this.storageService.headObject(video.source_key),
    );
    if (!head) {
      throw new VideoProcessingError('SOURCE_MISSING');
    }

    const sourceUrl = await this.fromStorage(() =>
      this.storageService.presignInternalGetObject(video.source_key),
    );
    const probe = await this.fromMedia(() =>
      this.mediaProbeService.probe(sourceUrl),
    );
    const thumbnail = await this.fromMedia(() =>
      this.mediaProbeService.extractThumbnail(
        sourceUrl,
        thumbnailInstant(probe.durationSeconds),
      ),
    );

    const thumbnailKey = `thumbnails/${video.id}/default.jpg`;
    await this.fromStorage(() =>
      this.storageService.putObject(thumbnailKey, thumbnail, 'image/jpeg'),
    );

    const updated = await this.videosService.markReady(video.id, {
      durationSeconds: probe.durationSeconds,
      metadata: probe.metadata,
      thumbnailKey,
    });
    this.logger.log(
      `Video ${video.id} ${updated ? 'is ready' : 'was already finalised'}`,
    );
  }

  /**
   * Marks the video as failed once no more retries will happen: either the
   * error is unrecoverable or the attempts are exhausted.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const unrecoverable = error instanceof UnrecoverableError;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!unrecoverable && !exhausted) return;

    const reason: VideoFailureReason = unrecoverable
      ? (error.message as VideoFailureReason)
      : error instanceof VideoProcessingError
        ? error.reason
        : 'PROBE_FAILED';

    // Event handler context: a failure here is logged, not rethrown.
    try {
      await this.videosService.markError(job.data.videoId, reason);
      this.logger.warn(`Video ${job.data.videoId} failed: ${reason}`);
    } catch (markError) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(markError)}`,
      );
    }
  }

  private async fromStorage<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof StorageUnavailableException) {
        throw new VideoProcessingError('STORAGE_ERROR');
      }
      throw error;
    }
  }

  private async fromMedia<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MediaProbeError) {
        this.logger.warn(error.message);
        if (error.reason === 'NOT_A_VIDEO') {
          // No retry can turn a non-video into a video.
          throw new UnrecoverableError('NOT_A_VIDEO');
        }
        throw new VideoProcessingError(error.reason);
      }
      throw error;
    }
  }
}
