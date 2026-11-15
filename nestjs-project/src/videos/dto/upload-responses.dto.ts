import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class CreateVideoResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ', description: 'Public video id (URL)' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    example: 67108864,
    description: 'Size of every part but the last',
  })
  partSizeBytes: number;

  @ApiProperty({ example: 160, description: 'ceil(sizeBytes / partSizeBytes)' })
  partCount: number;
}

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    example: 67108864,
    description:
      'Exact size of this part in bytes. The URL is signed for this Content-Length: storage rejects any other size',
  })
  sizeBytes: number;

  @ApiProperty({
    description: 'Presigned URL: PUT the part bytes straight to it',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({ example: 3600 })
  expiresInSeconds: number;
}

export class UploadCompletedResponseDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  publicId: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
