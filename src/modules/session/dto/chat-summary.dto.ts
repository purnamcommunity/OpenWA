import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ChatKind } from '../../../engine/identity/wa-id';

const CHAT_KINDS: ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

/** OpenAPI mirror of the engine `ChatActivityPreview`. */
export class ChatActivityPreviewDto {
  @ApiProperty({
    description:
      'What moved the chat: `comment` is a reply on a community announcement, `reaction` an emoji ' +
      'on a message, `poll_vote` a vote. Not a closed set — WhatsApp adds add-on types, and an ' +
      'unrecognised one is still a real event.',
    example: 'comment',
  })
  kind!: string;

  @ApiProperty({
    description: 'Who caused it. May be an `@lid` privacy id, which carries no phone number.',
    example: '628111@c.us',
  })
  senderId!: string;

  @ApiProperty({
    description:
      'True when this account caused it. Answered by the engine because nothing else can: in a ' +
      'group the account is an `@lid` sharing no digits with its own phone number.',
    example: false,
  })
  isMe!: boolean;

  @ApiProperty({ description: 'Unix seconds.', example: 1700000010 })
  timestamp!: number;

  @ApiPropertyOptional({ description: 'The message the add-on hangs off, when the engine reports one.' })
  parentMessageId?: string;
}

/** OpenAPI mirror of the engine `ChatSummary` (documentation only; the runtime returns the interface). */
export class ChatSummaryDto {
  @ApiProperty({ example: '628111@c.us' })
  id!: string;

  @ApiProperty({ example: 'Alice' })
  name!: string;

  @ApiProperty({ description: 'Retained for back-compat; true for @g.us chats.', example: false })
  isGroup!: boolean;

  @ApiProperty({ enum: CHAT_KINDS, description: 'User-facing chat kind.', example: 'individual' })
  kind!: ChatKind;

  @ApiProperty({ example: 1 })
  unreadCount!: number;

  @ApiProperty({ description: 'Unix seconds of the last activity.', example: 1700000010 })
  timestamp!: number;

  @ApiPropertyOptional({ example: 'hi' })
  lastMessage?: string;

  @ApiProperty({ description: 'Archived state, as set via POST /sessions/{sessionId}/chats/archive.', example: false })
  archived!: boolean;

  @ApiProperty({ description: 'Pinned state, as set via POST /sessions/{sessionId}/chats/pin.', example: false })
  pinned!: boolean;

  @ApiProperty({
    description:
      'Whether the chat is muted right now, as set via POST /sessions/{sessionId}/chats/mute. The ' +
      'verdict rather than the expiry: whatsapp-web.js derives it itself from Chat.isMuted, and ' +
      'Baileys carries a muteEndTime that this gateway compares against now. The expiry instant ' +
      'itself is tracked separately in #1473.',
    example: false,
  })
  muted!: boolean;
  @ApiPropertyOptional({
    type: ChatActivityPreviewDto,
    description:
      'Set when the chat’s newest activity is an add-on rather than a message — a reply on an ' +
      'announcement, a reaction, a vote. These move a chat to the top of the list while changing ' +
      'nothing a message read can see, so without this the chat rises showing its previous message ' +
      'and the reason is invisible. Absent on engines that do not model add-ons.',
  })
  lastActivity?: ChatActivityPreviewDto;
}
