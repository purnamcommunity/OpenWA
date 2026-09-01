import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Thrown when a reply thread cannot be read from the page: WhatsApp Web keeps announcement replies
 * in an add-on table that no engine library exposes, so the adapter reads the internal module
 * directly and this is what a build that has moved or renamed it produces.
 *
 * Extends NestJS `UnprocessableEntityException` so it maps to **HTTP 422** through NestJS's built-in
 * exception handler — no custom global filter required. Mirrors how {@link ChatLabelsUnsupportedError}
 * maps to 422.
 *
 * Deliberately NOT `EngineNotSupportedError`: whatsapp-web.js does support this read, and a 501
 * would state that the engine never can. It is this WhatsApp Web build, on this day, that cannot —
 * the same shape of refusal as a labels write on a non-Business account. It is equally not an empty
 * array, which says the announcement drew no replies.
 */
export class MessageCommentsUnavailableError extends UnprocessableEntityException {
  constructor(detail: string) {
    super(
      `Replies cannot be read from this WhatsApp Web build (${detail}). The reply thread is an ` +
        'undocumented internal and moves between releases.',
    );
  }
}
