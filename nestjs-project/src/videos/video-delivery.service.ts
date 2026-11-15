import { Injectable } from '@nestjs/common';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

/** Download file name: no quotes, backslashes, control or non-ASCII characters. */
export function sanitizeDownloadFilename(name: string | null): string {
  const cleaned = (name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned.slice(0, 255) : '';
}

@Injectable()
export class VideoDeliveryService {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  /** Presigned GET for the source; storage serves Range requests itself. */
  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.videosService.findReadyByPublicId(publicId);
    return this.storageService.presignGetObject(video.source_key);
  }

  /** Same object, forced to `attachment` so the browser downloads it. */
  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.videosService.findReadyByPublicId(publicId);
    return this.storageService.presignGetObject(video.source_key, {
      downloadFilename: this.downloadFilenameOf(video),
    });
  }

  async getThumbnailUrl(publicId: string): Promise<string> {
    const video = await this.videosService.findReadyByPublicId(publicId);
    if (!video.thumbnail_key) {
      throw new VideoNotFoundException();
    }
    return this.storageService.presignGetObject(video.thumbnail_key);
  }

  private downloadFilenameOf(video: Video): string {
    const sanitized = sanitizeDownloadFilename(video.original_filename);
    if (sanitized) return sanitized;
    const extension = video.source_key.split('.').pop() ?? 'mp4';
    return `${video.public_id}.${extension}`;
  }
}
