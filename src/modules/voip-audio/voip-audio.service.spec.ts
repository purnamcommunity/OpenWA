import { EventEmitter } from 'events';
import { VoipAudioService, type AudioProcess } from './voip-audio.service';
import { FRAME_BYTES, MAX_MIC_BACKLOG_BYTES } from './voip-audio.constants';

/** A pacat/parec stand-in: an emitter with the two streams the service touches. */
function fakeProcess() {
  const proc = new EventEmitter() as unknown as AudioProcess & {
    written: Buffer[];
    drain: () => void;
    killSignal: string | null;
    ended: boolean;
  };
  const written: Buffer[] = [];
  const pendingCallbacks: Array<() => void> = [];
  Object.assign(proc, {
    written,
    killSignal: null,
    ended: false,
    stdin: Object.assign(new EventEmitter(), {
      // Hold the completion callback so a test can decide when PulseAudio drained the chunk.
      write: (chunk: Buffer, cb?: () => void) => {
        written.push(chunk);
        if (cb) pendingCallbacks.push(cb);
        return true;
      },
      end: () => {
        (proc as { ended: boolean }).ended = true;
      },
    }),
    stdout: new EventEmitter(),
    kill: (signal: string) => {
      (proc as { killSignal: string | null }).killSignal = signal;
      return true;
    },
    drain: () => {
      while (pendingCallbacks.length) pendingCallbacks.shift()!();
    },
  });
  return proc;
}

function serviceWith() {
  const spawned: Array<{ command: string; args: string[]; proc: ReturnType<typeof fakeProcess> }> = [];
  const service = new VoipAudioService();
  service.useSpawn((command, args) => {
    const proc = fakeProcess();
    spawned.push({ command, args, proc });
    return proc;
  });
  return { service, spawned, mic: () => spawned[0], out: () => spawned[1] };
}

const frame = (n = FRAME_BYTES) => Buffer.alloc(n, 1);

describe('VoipAudioService topology', () => {
  it('records the playback sink and plays into the microphone sink, never the same one', () => {
    const { service, mic, out } = serviceWith();
    service.open('s1', () => {});

    expect(mic().command).toBe('pacat');
    expect(mic().args).toContain('--device=micsink');
    expect(out().command).toBe('parec');
    expect(out().args).toContain('--device=outsink.monitor');
    // One shared sink would loop Chromium's own playback back into its microphone.
    expect(mic().args.find(a => a.startsWith('--device='))).not.toBe(out().args.find(a => a.startsWith('--device=')));
  });

  it('pins the same PCM format on both pipes', () => {
    const { service, mic, out } = serviceWith();
    service.open('s1', () => {});

    for (const p of [mic(), out()]) {
      expect(p.args).toContain('--format=s16le');
      expect(p.args).toContain('--rate=48000');
      expect(p.args).toContain('--channels=1');
    }
  });
});

describe('VoipAudioService streaming', () => {
  it('hands the far end audio to the operator callback', () => {
    const { service, out } = serviceWith();
    const heard: Buffer[] = [];
    service.open('s1', c => heard.push(c));

    out().proc.stdout.emit('data', frame());
    expect(heard).toHaveLength(1);
  });

  it('writes the operator microphone toward the call', () => {
    const { service, mic } = serviceWith();
    service.open('s1', () => {});

    expect(service.writeMic('s1', frame())).toBe(true);
    expect(mic().proc.written).toHaveLength(1);
  });

  it('drops microphone audio for a session with no bridge instead of throwing', () => {
    const { service } = serviceWith();
    expect(service.writeMic('nobody', frame())).toBe(false);
  });

  it('stops feeding the far end once the bridge is closed', () => {
    const { service, out } = serviceWith();
    const heard: Buffer[] = [];
    service.open('s1', c => heard.push(c));
    service.close('s1');

    out().proc.stdout.emit('data', frame());
    expect(heard).toHaveLength(0);
  });
});

describe('VoipAudioService backlog cap', () => {
  it('drops audio past the cap rather than building delay that never drains', () => {
    const { service, mic } = serviceWith();
    service.open('s1', () => {});

    let accepted = 0;
    // PulseAudio plays everything it is given, so an un-drained pipe must refuse eventually.
    for (let i = 0; i < 200; i++) if (service.writeMic('s1', frame())) accepted++;

    expect(accepted).toBeLessThanOrEqual(Math.ceil(MAX_MIC_BACKLOG_BYTES / FRAME_BYTES));
    expect(accepted).toBeGreaterThan(0);
    expect(mic().proc.written.length).toBe(accepted);
  });

  it('reports the peak backlog and the audio it refused in the close summary', () => {
    const { service } = serviceWith();
    const logged: string[] = [];
    jest.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation(m => logged.push(m));
    service.open('s1', () => {});

    while (service.writeMic('s1', frame())) {
      /* fill to the cap; the final refused write is the dropped frame */
    }
    service.close('s1');

    const summary = logged.find(m => m.includes('bridge closed'));
    expect(summary).toContain(`peak mic backlog ${MAX_MIC_BACKLOG_BYTES / 96}ms`);
    expect(summary).toContain(`dropped ${FRAME_BYTES / 96}ms`);
  });

  it('accepts audio again once the pipe drains', () => {
    const { service, mic } = serviceWith();
    service.open('s1', () => {});
    while (service.writeMic('s1', frame())) {
      /* fill to the cap */
    }
    expect(service.writeMic('s1', frame())).toBe(false);

    mic().proc.drain();

    expect(service.writeMic('s1', frame())).toBe(true);
  });
});

describe('VoipAudioService lifecycle', () => {
  it('closes both pipes', () => {
    const { service, mic, out } = serviceWith();
    service.open('s1', () => {});
    service.close('s1');

    expect(mic().proc.killSignal).toBe('SIGTERM');
    expect(out().proc.killSignal).toBe('SIGTERM');
    expect(service.isOpen('s1')).toBe(false);
  });

  it('replaces an existing bridge so two operators never mix into one call', () => {
    const { service, spawned } = serviceWith();
    service.open('s1', () => {});
    service.open('s1', () => {});

    expect(spawned).toHaveLength(4);
    expect(spawned[0].proc.killSignal).toBe('SIGTERM');
    expect(service.isOpen('s1')).toBe(true);
  });

  it('tears the bridge down when a pipe dies mid-call', () => {
    const { service, mic } = serviceWith();
    service.open('s1', () => {});

    mic().proc.emit('exit', 1);

    expect(service.isOpen('s1')).toBe(false);
  });

  it('survives a pipe that fails to start', () => {
    const { service, mic } = serviceWith();
    service.open('s1', () => {});

    // An unhandled 'error' on a child process would otherwise take the gateway down.
    expect(() => mic().proc.emit('error', new Error('pacat: not found'))).not.toThrow();
    expect(service.isOpen('s1')).toBe(false);
  });

  it('closing a session that has no bridge is a no-op', () => {
    const { service } = serviceWith();
    expect(() => service.close('ghost')).not.toThrow();
  });

  it('closes every bridge on shutdown', () => {
    const { service } = serviceWith();
    service.open('a', () => {});
    service.open('b', () => {});

    service.onModuleDestroy();

    expect(service.isOpen('a')).toBe(false);
    expect(service.isOpen('b')).toBe(false);
  });
});

describe('VoipAudioService.isEnabled', () => {
  const prev = process.env.VOIP_AUDIO_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.VOIP_AUDIO_ENABLED;
    else process.env.VOIP_AUDIO_ENABLED = prev;
  });

  it('is off unless explicitly enabled', () => {
    delete process.env.VOIP_AUDIO_ENABLED;
    expect(VoipAudioService.isEnabled()).toBe(false);
  });

  it('is on only for the exact string true', () => {
    process.env.VOIP_AUDIO_ENABLED = 'true';
    expect(VoipAudioService.isEnabled()).toBe(true);
    process.env.VOIP_AUDIO_ENABLED = '1';
    expect(VoipAudioService.isEnabled()).toBe(false);
  });
});
