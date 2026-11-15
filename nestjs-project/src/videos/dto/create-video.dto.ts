import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import { VIDEO_CONTENT_TYPES } from '../videos.constants';

export class CreateVideoDto {
  /** Client-side file name; stored as metadata only, never used as the title. */
  @IsString()
  @Length(1, 255)
  filename: string;

  /** Declared container type; a hint only, the worker validates the real file. */
  @IsIn(Object.keys(VIDEO_CONTENT_TYPES))
  contentType: string;

  /** Total size in bytes. Sizes above 10 GiB are rejected with 413 by the service. */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
