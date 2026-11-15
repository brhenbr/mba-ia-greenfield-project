import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import {
  CreateVideoResponseDto,
  PartUrlsResponseDto,
  UploadCompletedResponseDto,
} from './dto/upload-responses.dto';
import { VideoStatusResponseDto } from './dto/video-status-response.dto';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoUploadsService } from './video-uploads.service';
import { VideosService } from './videos.service';

interface RedirectResult {
  url: string;
  statusCode: number;
}

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videoUploadsService: VideoUploadsService,
    private readonly videoDeliveryService: VideoDeliveryService,
    private readonly videosService: VideosService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Creates the video draft in the caller's channel and starts an S3 multipart upload. The client then uploads each part straight to storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_TOO_LARGE: sizeBytes is greater than 10 GiB',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description:
      'STORAGE_UNAVAILABLE: the multipart upload could not be created',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videoUploadsService.startUpload(user.sub, dto);
  }

  // A 10 GiB upload needs up to ~160 calls; the global limit (10/min) would 429 it.
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns one presigned PUT URL per requested part. The API never receives video bytes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, or INVALID_PART_NUMBER above partCount',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND: unknown id or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_INVALID_STATE: the video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async partUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videoUploadsService.getPartUrls(
      user.sub,
      publicId,
      dto.partNumbers,
    );
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Completes the multipart upload, moves the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; the video is being processed',
    type: UploadCompletedResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND: unknown id or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_INVALID_STATE: the video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_TOO_LARGE: stored parts add up to more than 10 GiB',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description:
      'UPLOAD_PARTS_MISMATCH or UPLOAD_SIZE_MISMATCH: the parts do not match what storage holds',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'STORAGE_UNAVAILABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<UploadCompletedResponseDto> {
    return this.videoUploadsService.completeUpload(user.sub, publicId, dto);
  }

  // Polled by the client while a video is `processing`.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get(':publicId')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get the status of a video',
    description:
      'Owner-only status and extracted metadata, used to follow the processing lifecycle.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video status and metadata',
    type: VideoStatusResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND: unknown id or not owned by the caller',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async status(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoStatusResponseDto> {
    return this.videosService.getOwnedStatus(publicId, user.sub);
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get(':publicId/stream')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL; storage answers Range requests with 206. Only ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned GET URL of the video',
    headers: {
      Location: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND: unknown id or the video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('publicId') publicId: string): Promise<RedirectResult> {
    return {
      url: await this.videoDeliveryService.getStreamUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get(':publicId/download')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned URL that forces Content-Disposition: attachment. Only ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
    headers: {
      Location: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND: unknown id or the video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('publicId') publicId: string): Promise<RedirectResult> {
    return {
      url: await this.videoDeliveryService.getDownloadUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }

  @Public()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get(':publicId/thumbnail')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get the thumbnail of a video',
    description:
      'Redirects to a presigned URL of the JPEG thumbnail. Only ready videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL',
    headers: {
      Location: { schema: { type: 'string' } },
      'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
    },
  })
  @ApiResponse({
    status: 404,
    description:
      'VIDEO_NOT_FOUND: unknown id, the video is not ready, or it has no thumbnail',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId') publicId: string,
  ): Promise<RedirectResult> {
    return {
      url: await this.videoDeliveryService.getThumbnailUrl(publicId),
      statusCode: HttpStatus.FOUND,
    };
  }
}
