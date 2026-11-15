import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  VideoInvalidStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import type { VideoStatusResponseDto } from './dto/video-status-response.dto';
import { Video, type VideoMetadata } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { PUBLIC_ID_MAX_ATTEMPTS, PUBLIC_ID_PATTERN } from './videos.constants';
import { VideoStatus } from './video-status.enum';

export interface CreateDraftInput {
  id: string;
  channelId: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  sourceKey: string;
  uploadId: string;
}

export interface ProcessingResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
  thumbnailKey: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  /**
   * Inserts the draft with a fresh public id. A collision on `public_id`
   * (probability ~2^-66 per pair) is retried with a new id, up to 5 attempts.
   */
  async createDraft(input: CreateDraftInput): Promise<Video> {
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: input.id,
            public_id: generatePublicId(),
            channel_id: input.channelId,
            original_filename: input.originalFilename,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
            status: VideoStatus.DRAFT,
            upload_id: input.uploadId,
            source_key: input.sourceKey,
          }),
        );
      } catch (error) {
        if (
          !isPgUniqueViolationOnColumn(error, 'public_id') ||
          attempt === PUBLIC_ID_MAX_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new Error('Unreachable: createDraft exhausted its attempts');
  }

  /**
   * Finds a video by public id for its owner. Unknown ids, malformed ids and
   * videos of other users all answer the same way, so existence is not leaked.
   */
  async findOwnedByPublicId(publicId: string, userId: string): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Owner-only view of a video's status and extracted metadata. */
  async getOwnedStatus(
    publicId: string,
    userId: string,
  ): Promise<VideoStatusResponseDto> {
    const video = await this.findOwnedByPublicId(publicId, userId);
    return {
      publicId: video.public_id,
      status: video.status,
      title: video.title,
      originalFilename: video.original_filename,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      failureReason: video.failure_reason,
      createdAt: video.created_at.toISOString(),
      updatedAt: video.updated_at.toISOString(),
    };
  }

  /**
   * Public lookup for delivery: only `ready` videos exist for anonymous
   * callers; drafts, processing and failed videos answer like unknown ids.
   */
  async findReadyByPublicId(publicId: string): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * `draft → processing` as one conditional UPDATE: atomic, and of two
   * concurrent callers exactly one wins; the other gets VIDEO_INVALID_STATE.
   */
  async markProcessing(videoId: string): Promise<void> {
    const result = await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set({
        status: VideoStatus.PROCESSING,
        processing_started_at: () => 'now()',
        upload_id: null,
      })
      .where('id = :id AND status = :draft', {
        id: videoId,
        draft: VideoStatus.DRAFT,
      })
      .execute();

    if (!result.affected) {
      throw new VideoInvalidStateException();
    }
  }

  async findById(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id: videoId });
  }

  /** Unfinished uploads of a channel (each one holds a multipart upload in storage). */
  async countOpenDrafts(channelId: string): Promise<number> {
    return this.videoRepository.countBy({
      channel_id: channelId,
      status: VideoStatus.DRAFT,
    });
  }

  /**
   * `processing → ready`, written by the worker. Conditional on `processing`,
   * so a duplicate delivery matches no row and changes nothing (not even
   * `updated_at`). Returns whether the row was updated.
   */
  async markReady(videoId: string, result: ProcessingResult): Promise<boolean> {
    const update = await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set({
        status: VideoStatus.READY,
        duration_seconds: result.durationSeconds,
        metadata: result.metadata,
        thumbnail_key: result.thumbnailKey,
        failure_reason: null,
      })
      .where('id = :id AND status = :processing', {
        id: videoId,
        processing: VideoStatus.PROCESSING,
      })
      .execute();
    return (update.affected ?? 0) > 0;
  }

  /** `processing → error` with a failure code; same idempotence as `markReady`. */
  async markError(videoId: string, failureReason: string): Promise<boolean> {
    const update = await this.videoRepository
      .createQueryBuilder()
      .update(Video)
      .set({ status: VideoStatus.ERROR, failure_reason: failureReason })
      .where('id = :id AND status = :processing', {
        id: videoId,
        processing: VideoStatus.PROCESSING,
      })
      .execute();
    return (update.affected ?? 0) > 0;
  }
}
