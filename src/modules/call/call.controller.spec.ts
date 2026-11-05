import { BadRequestException } from '@nestjs/common';
import { CALL_PLACEMENTS_PER_MINUTE, CallController } from './call.controller';
import { CallService } from './call.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { type IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
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

  // The mint is not idempotent, so an unconfirmed link_create answers 500 on both engines: a
  // retryable 503 would invite a replay that creates a second link.
  it('POST link declares no retryable 503', () => {
    const responses = (Reflect.getMetadata(
      'swagger/apiResponse',
      Object.getOwnPropertyDescriptor(CallController.prototype, 'createLink')?.value as object,
    ) ?? {}) as Record<string, unknown>;
    expect(Object.keys(responses)).not.toContain('503');
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

// Exercise controller -> service -> registry together: the fork's VoIP routes must keep
// the session fence, boolean defaults, response shape and engine refusals after a sync.
describe('VoIP routes through the real call service', () => {
  const ack = { success: true };
  const currentCall = { callId: 'CALL1', state: 'ACTIVE', isVideo: false };
  const cases: {
    label: string;
    method: keyof IWhatsAppEngine;
    run: (controller: CallController) => Promise<unknown>;
    args: unknown[];
    engineResult?: unknown;
    response: unknown;
  }[] = [
    { label: 'warmup', method: 'ensureVoipReady', run: c => c.warmup('s1'), args: [], response: ack },
    {
      label: 'place voice by default',
      method: 'placeCall',
      run: c => c.place('s1', { chatId: '123@c.us' }),
      args: ['123@c.us', false],
      engineResult: 'CALL1',
      response: { success: true, callId: 'CALL1' },
    },
    {
      label: 'place video with an unconfirmed call id',
      method: 'placeCall',
      run: c => c.place('s1', { chatId: '123@lid', isVideo: true }),
      args: ['123@lid', true],
      engineResult: null,
      response: { success: true, callId: null },
    },
    {
      label: 'answer without a body',
      method: 'answerCall',
      run: c => c.answer('s1', 'CALL1'),
      args: ['CALL1', false],
      response: ack,
    },
    {
      label: 'answer with an empty body',
      method: 'answerCall',
      run: c => c.answer('s1', 'CALL1', {}),
      args: ['CALL1', false],
      response: ack,
    },
    {
      label: 'answer with video',
      method: 'answerCall',
      run: c => c.answer('s1', 'CALL1', { withVideo: true }),
      args: ['CALL1', true],
      response: ack,
    },
    { label: 'end', method: 'endCall', run: c => c.end('s1', 'CALL1'), args: ['CALL1'], response: ack },
    {
      label: 'state',
      method: 'callState',
      run: c => c.state('s1'),
      args: [],
      engineResult: currentCall,
      response: currentCall,
    },
  ];

  const controllerFor = (method?: keyof IWhatsAppEngine, operation?: jest.Mock) => {
    const registry = new EngineRegistry();
    if (method) registry.set('s1', { [method]: operation } as unknown as IWhatsAppEngine);
    return new CallController(new CallService(registry));
  };

  it.each(cases)('$label preserves engine arguments and the response contract', async test => {
    const operation = jest.fn().mockResolvedValue(test.engineResult);
    await expect(test.run(controllerFor(test.method, operation))).resolves.toEqual(test.response);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(...test.args);
  });

  it.each(cases)('$label refuses a session without a registered engine', async test => {
    await expect(test.run(controllerFor())).rejects.toThrow('Session is not started');
  });

  it.each(cases)('$label propagates a refusal without reporting success', async test => {
    const refusal = new EngineRefusedError('WhatsApp refused the operation');
    const operation = jest.fn().mockRejectedValue(refusal);
    await expect(test.run(controllerFor(test.method, operation))).rejects.toBe(refusal);
  });
});
