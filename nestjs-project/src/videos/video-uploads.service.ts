import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  InvalidPartNumberException,
  TooManyOpenUploadsException,
  UploadPartsMismatchException,
  UploadSizeMismatchException,
  VideoInvalidStateException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import type {
  CreateVideoResponseDto,
  PartUrlsResponseDto,
  UploadCompletedResponseDto,
} from './dto/upload-responses.dto';
import type { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';
import {
  MAX_VIDEO_SIZE_BYTES,
  VIDEO_CONTENT_TYPES,
  type VideoContentType,
} from './videos.constants';

// S3 returns ETags quoted; clients may send them with or without quotes.
const normalizeEtag = (etag: string): string => etag.replace(/"/g, '');

@Injectable()
export class VideoUploadsService {
  private readonly logger = new Logger(VideoUploadsService.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
    @Inject(videosConfig.KEY)
    private readonly videosCfg: ConfigType<typeof videosConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async startUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    if (dto.sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }
    // Bounds the storage a single account can reserve with unfinished uploads
    // (abandoned drafts are only reclaimed by the sweep after VIDEO_DRAFT_TTL_DAYS).
    const openDrafts = await this.videosService.countOpenDrafts(channel.id);
    if (openDrafts >= this.videosCfg.maxOpenDrafts) {
      throw new TooManyOpenUploadsException();
    }

    // The id is generated here (not by the DB) because the storage key embeds it.
    const id = randomUUID();
    const extension = VIDEO_CONTENT_TYPES[dto.contentType as VideoContentType];
    const sourceKey = `videos/${id}/source.${extension}`;
    const uploadId = await this.storageService.createMultipartUpload(
      sourceKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.videosService.createDraft({
        id,
        channelId: channel.id,
        originalFilename: dto.filename,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
        sourceKey,
        uploadId,
      });
    } catch (error) {
      // Compensate: do not leave a multipart upload orphaned in storage.
      await this.storageService
        .abortMultipartUpload(sourceKey, uploadId)
        .catch((abortError: unknown) =>
          this.logger.error(
            `Could not abort upload ${uploadId} after a failed draft insert: ${String(abortError)}`,
          ),
        );
      throw error;
    }

    return {
      publicId: video.public_id,
      status: video.status,
      partSizeBytes: this.videosCfg.partSizeBytes,
      partCount: this.partCountOf(video),
    };
  }

  async getPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<PartUrlsResponseDto> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    this.assertDraft(video);

    const partCount = this.partCountOf(video);
    if (partNumbers.some((n) => n > partCount)) {
      throw new InvalidPartNumberException();
    }

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const sizeBytes = this.partLengthOf(video, partNumber, partCount);
        return {
          partNumber,
          sizeBytes,
          url: await this.storageService.presignUploadPart(
            video.source_key,
            video.upload_id as string,
            partNumber,
            sizeBytes,
          ),
        };
      }),
    );
    return { parts, expiresInSeconds: this.storageCfg.presignExpiresSeconds };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<UploadCompletedResponseDto> {
    const video = await this.videosService.findOwnedByPublicId(
      publicId,
      userId,
    );
    this.assertDraft(video);

    const partCount = this.partCountOf(video);
    const sent = new Map(dto.parts.map((p) => [p.partNumber, p.etag]));
    const expectedNumbers = Array.from({ length: partCount }, (_, i) => i + 1);
    if (
      dto.parts.length !== partCount ||
      expectedNumbers.some((n) => !sent.has(n))
    ) {
      throw new UploadPartsMismatchException();
    }

    const uploadId = video.upload_id as string;
    const stored = await this.storageService.listParts(
      video.source_key,
      uploadId,
    );
    const matches =
      stored.length === partCount &&
      stored.every(
        (part) =>
          normalizeEtag(sent.get(part.partNumber) ?? '') ===
          normalizeEtag(part.etag),
      );
    if (!matches) {
      throw new UploadPartsMismatchException();
    }

    const totalBytes = stored.reduce((sum, part) => sum + part.size, 0);
    if (totalBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    if (totalBytes !== video.size_bytes) {
      throw new UploadSizeMismatchException();
    }

    await this.storageService.completeMultipartUpload(
      video.source_key,
      uploadId,
      stored
        .map((part) => ({ partNumber: part.partNumber, etag: part.etag }))
        .sort((a, b) => a.partNumber - b.partNumber),
    );
    await this.videosService.markProcessing(video.id);

    // Enqueue only after the status change is committed. A failure here is not
    // surfaced to the client: the maintenance sweep re-enqueues videos stuck in
    // `processing` (closes the dual-write gap, per TD-10).
    try {
      await this.videoQueueService.enqueueProcessing(video.id);
    } catch (error) {
      this.logger.error(
        `Could not enqueue processing for video ${video.id}; the sweep will recover it: ${String(error)}`,
      );
    }

    return { publicId: video.public_id, status: VideoStatus.PROCESSING };
  }

  private assertDraft(video: Video): void {
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoInvalidStateException();
    }
  }

  private partCountOf(video: Video): number {
    return Math.ceil(
      (video.size_bytes as number) / this.videosCfg.partSizeBytes,
    );
  }

  /** Every part has `partSizeBytes` except the last, which carries the remainder. */
  private partLengthOf(
    video: Video,
    partNumber: number,
    partCount: number,
  ): number {
    return partNumber < partCount
      ? this.videosCfg.partSizeBytes
      : (video.size_bytes as number) -
          (partCount - 1) * this.videosCfg.partSizeBytes;
  }
}
