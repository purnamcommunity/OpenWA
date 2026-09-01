import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class PlaceCallDto {
  @ApiProperty({
    description:
      'Chat to call, as a 1:1 user id (`<number>@c.us`). Group calls are not offered here: the ' +
      'page module places them through a different entry point that takes a participant list.',
    example: '919876543210@c.us',
  })
  @IsString()
  @Matches(/@c\.us$/, { message: 'chatId must be a 1:1 user id ending in @c.us' })
  chatId!: string;

  @ApiProperty({
    description:
      'Place a video call rather than a voice call. A video call additionally needs a camera device ' +
      'in the container; without one WhatsApp still places the call and sends no video.',
    example: false,
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isVideo?: boolean;
}
