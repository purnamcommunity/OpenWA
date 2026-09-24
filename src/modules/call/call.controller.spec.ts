import { BadRequestException } from '@nestjs/common';
import { CALL_PLACEMENTS_PER_MINUTE, CallController } from './call.controller';
import { CallService } from './call.service';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

describe('CallController', () => {
  const build = (service: Partial<Record<keyof CallService, jest.Mock>>) => {
    const controller = new CallController(service as unknown as CallService);
    return { controller, service };
  };

  it('POST link returns the generated link', async () => {
    const { controller, service } = build({
      createCallLink: jest.fn().mockResolvedValue('https://call.whatsapp.com/video/TOKEN'),
    });
    await expect(controller.createLink('s1', { type: 'video', startTime: 1_800_000_000_000 })).resolves.toEqual({
      link: 'https://call.whatsapp.com/video/TOKEN',
    });
    expect(service.createCallLink).toHaveBeenCalledWith('s1', 'video', 1_800_000_000_000);
  });

  // A refusal must reach the caller as a refusal. Returning `{ link: '' }` would be a 200 carrying
  // nothing, which reads as success and hands the caller a link that does not exist.
  it('propagates a WhatsApp-side refusal rather than answering with an empty link', async () => {
    const { controller } = build({
      createCallLink: jest.fn().mockRejectedValue(new EngineRefusedError('WhatsApp did not return a call link')),
    });
    await expect(controller.createLink('s1', { type: 'audio', startTime: 1_800_000_000_000 })).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('POST :callId/reject returns the success envelope', async () => {
    const { controller, service } = build({ rejectCall: jest.fn().mockResolvedValue(undefined) });
    await expect(controller.reject('s1', 'CALL1')).resolves.toEqual({ success: true });
    expect(service.rejectCall).toHaveBeenCalledWith('s1', 'CALL1');
  });

  it('propagates a service rejection (session not started -> 400)', async () => {
    const { controller } = build({
      rejectCall: jest.fn().mockRejectedValue(new BadRequestException('Session is not started')),
    });
    await expect(controller.reject('s1', 'CALL1')).rejects.toThrow(BadRequestException);
  });

  it('propagates a service rejection (unknown/expired call id -> 404)', async () => {
    const { controller } = build({
      rejectCall: jest.fn().mockRejectedValue(new CallNotFoundError('CALL1')),
    });
    await expect(controller.reject('s1', 'CALL1')).rejects.toBeInstanceOf(CallNotFoundError);
  });

  // Placing a call is limited per LINE, not per client IP: every line is driven through one api
  // client, so an IP bucket would let one busy line use up another's calls — and WhatsApp judges
  // call behaviour per account.
  describe('call placement limit', () => {
    // Looked up by name: the decorators write their metadata onto the handler function itself.
    const meta = (key: string, handler: keyof CallController) =>
      Reflect.getMetadata(
        key,
        Object.getOwnPropertyDescriptor(CallController.prototype, handler)!.value as object,
      ) as unknown;

    it('allows a handful of placements a minute on each line', () => {
      expect(meta('THROTTLER:LIMITmedium', 'place')).toBe(CALL_PLACEMENTS_PER_MINUTE);
      expect(meta('THROTTLER:TTLmedium', 'place')).toBe(60_000);
      expect(CALL_PLACEMENTS_PER_MINUTE).toBe(5);
    });

    it('counts placements by session, whatever address they come from', async () => {
      const tracker = meta('THROTTLER:TRACKERmedium', 'place') as (
        req: Record<string, unknown>,
      ) => Promise<string> | string;
      const a = await tracker({ params: { sessionId: 's1' }, ip: '10.0.0.1' });
      const b = await tracker({ params: { sessionId: 's1' }, ip: '10.0.0.2' });
      const c = await tracker({ params: { sessionId: 's2' }, ip: '10.0.0.1' });
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    });

    it('leaves the other call routes on the ordinary limits', () => {
      expect(meta('THROTTLER:LIMITmedium', 'state')).toBeUndefined();
      expect(meta('THROTTLER:LIMITmedium', 'end')).toBeUndefined();
    });
  });
});
