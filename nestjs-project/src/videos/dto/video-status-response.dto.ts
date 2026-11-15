import { ApiProperty } from '@nestjs/swagger';
import type { VideoMetadata } from '../entities/video.entity';
import { VideoStatus } from '../video-status.enum';

export class VideoStatusResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ type: String, nullable: true, example: null })
  title: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'clip.mp4' })
  originalFilename: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 240.04 })
  durationSeconds: number | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    example: {
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 1280,
      height: 720,
      bitrate: 1432000,
      sizeBytes: 42966013,
    },
  })
  metadata: VideoMetadata | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  failureReason: string | null;

  @ApiProperty({ example: '2026-11-15T03:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-11-15T03:01:00.000Z' })
  updatedAt: string;
}
