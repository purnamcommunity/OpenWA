import { MessageCommentsUnavailableError } from './message-comments-unavailable.error';

describe('MessageCommentsUnavailableError', () => {
  it('maps to 422, not to the 501 that would blame the engine', () => {
    // 501 states the engine never supports the read; this refusal is about the page build, and a
    // caller distinguishing "retry after an update" from "never" reads the status to do it.
    expect(new MessageCommentsUnavailableError('x').getStatus()).toBe(422);
  });

  it('names the module that moved, so a broken build is diagnosable from the response', () => {
    expect(new MessageCommentsUnavailableError('commentTableMode.bulkGetByParentMsgKey').message).toContain(
      'commentTableMode.bulkGetByParentMsgKey',
    );
  });
});
