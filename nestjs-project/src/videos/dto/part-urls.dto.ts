import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PART_NUMBERS_PER_REQUEST } from '../videos.constants';

export class PartUrlsDto {
  /** Part numbers to sign (1-based). The upper bound is the video's `partCount`. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PART_NUMBERS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
