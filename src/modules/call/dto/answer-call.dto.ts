import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

export class AnswerCallDto {
  @ApiProperty({
    description:
      'Answer with video as well as audio. Defaults to audio only — a video answer additionally ' +
      'needs a camera device in the container, and without one the call is answered sending no video.',
    example: false,
    required: false,
    default: false,
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  withVideo?: boolean;
}
