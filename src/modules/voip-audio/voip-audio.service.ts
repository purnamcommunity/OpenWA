import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import {
  FRAME_BYTES,
  MAX_MIC_BACKLOG_BYTES,
  MIC_PACING_SLACK_BYTES,
  PCM_BYTES_PER_SAMPLE,
  PCM_CHANNELS,
  PCM_FORMAT,
  PCM_SAMPLE_RATE,
} from './voip-audio.constants';

/**
 * Carries a call's audio between the operator's browser and the gateway's headless Chromium.
 *
 * The call itself happens in Chromium, which has no hardware to listen to, so the two directions
 * are plumbed through PulseAudio (created by docker-entrypoint.sh when VOIP_AUDIO_ENABLED=true):
 *
 *   operator mic  --ws-->  pacat --playback -d micsink  -->  vmic  -->  Chromium getUserMedia
 *   operator ears <--ws--  parec -d outsink.monitor     <--  outsink <-- Chromium playback
 *
 * The two sinks are separate on purpose. One shared sink would loop Chromium's own playback back
 * into its microphone and the far end would hear itself.
 *
 * `spawnProcess` is injectable so the whole lifecycle is testable without PulseAudio present —
 * these are long-lived pipes, and their failure modes (a binary that is missing, a stream that
 * ends mid-call) matter more than the happy path.
 */
/** stderr is dropped: pacat/parec chatter is not worth a pipe to drain, and a real failure
 *  surfaces as an exit or an error event instead. */
export type AudioProcess = ChildProcessByStdio<Writable, Readable, null>;
export type AudioSpawn = (command: string, args: string[]) => AudioProcess;

interface Bridge {
  mic: AudioProcess;
  out: AudioProcess;
  /** Bytes handed to pacat but not yet drained — the backlog the cap is enforced against. */
  pending: number;
  /** High-water mark of `pending` and total bytes refused at the cap, reported when the bridge
   *  closes — the standing delay a call built up is invisible in any single frame. */
  peakPending: number;
  droppedBytes: number;
  /** Wall-clock anchor of the pacing budget: when the first microphone frame arrived. Null until
   *  then — anchoring at bridge open would hand a client that connects late a free burst budget. */
  firstFrameAt: number | null;
  /** Bytes accepted toward pacat since `firstFrameAt` — what the pacing budget is charged against. */
  acceptedBytes: number;
  statsTimer: NodeJS.Timeout | null;
  closed: boolean;
}

/** Bytes of s16le mono 48 kHz as milliseconds of audio — the unit delay is felt in. */
function msOf(bytes: number): number {
  return Math.round(bytes / ((PCM_SAMPLE_RATE / 1000) * PCM_BYTES_PER_SAMPLE * PCM_CHANNELS));
}

@Injectable()
export class VoipAudioService implements OnModuleDestroy {
  private readonly logger = new Logger(VoipAudioService.name);
  private readonly bridges = new Map<string, Bridge>();

  /**
   * How a pipe is started. A field rather than a constructor parameter: Nest resolves constructor
   * params by type metadata and a function type is not injectable, so making this a DI parameter
   * breaks the module at boot. Tests replace it with `useSpawn`.
   */
  private spawnProcess: AudioSpawn = defaultSpawn;

  /** Test seam — replaces the pipe launcher. Not for production use. */
  useSpawn(spawnProcess: AudioSpawn): void {
    this.spawnProcess = spawnProcess;
  }

  /** Whether the deployment gave this container the audio devices a call needs. */
  static isEnabled(): boolean {
    return (process.env.VOIP_AUDIO_ENABLED ?? 'false') === 'true';
  }

  private static micSink(): string {
    return process.env.VOIP_AUDIO_MIC_SINK ?? 'micsink';
  }

  private static outSink(): string {
    return process.env.VOIP_AUDIO_OUT_SINK ?? 'outsink';
  }

  /**
   * Open the bridge for a session and start streaming Chromium's playback to `onRemoteAudio`.
   * Opening twice for one session closes the first: a second operator taking over a call is the
   * intended behaviour, and leaving both pipes alive would mix two microphones into one call.
   */
  open(sessionId: string, onRemoteAudio: (chunk: Buffer) => void): void {
    this.close(sessionId);

    const mic = this.spawnProcess('pacat', [
      '--playback',
      `--device=${VoipAudioService.micSink()}`,
      `--format=${PCM_FORMAT}`,
      `--rate=${PCM_SAMPLE_RATE}`,
      `--channels=${PCM_CHANNELS}`,
      // Ask PulseAudio for a short buffer; the default is tuned for music playback and adds
      // latency the far end hears as lag.
      '--latency-msec=20',
      '--client-name=openwa-voip-mic',
    ]);
    const out = this.spawnProcess('parec', [
      `--device=${VoipAudioService.outSink()}.monitor`,
      `--format=${PCM_FORMAT}`,
      `--rate=${PCM_SAMPLE_RATE}`,
      `--channels=${PCM_CHANNELS}`,
      '--latency-msec=20',
      '--client-name=openwa-voip-out',
    ]);

    const bridge: Bridge = {
      mic,
      out,
      pending: 0,
      peakPending: 0,
      droppedBytes: 0,
      firstFrameAt: null,
      acceptedBytes: 0,
      statsTimer: null,
      closed: false,
    };
    this.bridges.set(sessionId, bridge);

    // Backlog report while the bridge is up — but only when the numbers MOVE. A healthy call sits
    // at 0ms backlog for its whole length, and a line a second saying so drowns the log the one
    // time it matters. Debug level: diagnosis traffic; the close summary carries the part worth
    // keeping. unref so a bridge left open in a test cannot hold the process alive.
    let lastReported = '';
    bridge.statsTimer = setInterval(() => {
      const line = `mic backlog ${msOf(bridge.pending)}ms (peak ${msOf(bridge.peakPending)}ms, dropped ${msOf(bridge.droppedBytes)}ms)`;
      if (line === lastReported) return;
      lastReported = line;
      this.logger.debug(`VoIP audio ${sessionId}: ${line}`);
    }, 1000);
    bridge.statsTimer.unref?.();

    out.stdout.on('data', (chunk: Buffer) => {
      if (!bridge.closed) onRemoteAudio(chunk);
    });

    // A pipe that dies mid-call must not take the process with it: an EPIPE write on a killed
    // pacat is an unhandled 'error' event otherwise.
    for (const [name, proc] of [
      ['mic', mic],
      ['out', out],
    ] as const) {
      proc.on('error', (error: Error) => {
        this.logger.warn(`VoIP audio ${name} pipe failed for ${sessionId}: ${error.message}`);
        this.close(sessionId);
      });
      proc.stdin.on('error', () => {
        /* the close path already reports it */
      });
      proc.on('exit', (code: number | null) => {
        if (!bridge.closed) {
          this.logger.warn(`VoIP audio ${name} pipe for ${sessionId} exited (${String(code)})`);
          this.close(sessionId);
        }
      });
    }

    this.logger.log(`VoIP audio bridge open for ${sessionId}`);
  }

  /**
   * Feed one chunk of the operator's microphone toward the call. Returns false when the chunk was
   * dropped — no bridge is open, the backlog cap was hit, or the pacing budget was exceeded.
   */
  writeMic(sessionId: string, chunk: Buffer): boolean {
    const bridge = this.bridges.get(sessionId);
    if (!bridge || bridge.closed) return false;

    // Pacing: never accept more than realtime-plus-slack since the first frame. The backlog cap
    // below cannot see audio the OS pipe buffer already holds (~680 ms), so a bursting client
    // would otherwise plant standing delay the far end hears for the rest of the call. Cumulative
    // against the wall clock, so a post-stall catch-up burst of realtime audio still passes.
    const now = Date.now();
    if (bridge.firstFrameAt === null) bridge.firstFrameAt = now;
    const budget =
      ((now - bridge.firstFrameAt) / 1000) * PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * PCM_CHANNELS +
      MIC_PACING_SLACK_BYTES;
    if (bridge.acceptedBytes + chunk.length > budget) {
      bridge.droppedBytes += chunk.length;
      return false;
    }

    // PulseAudio plays everything it is given, so a client sending faster than realtime builds
    // delay that never drains. Dropping the incoming chunk keeps the call live rather than letting
    // it slide permanently behind.
    if (bridge.pending + chunk.length > MAX_MIC_BACKLOG_BYTES) {
      bridge.droppedBytes += chunk.length;
      return false;
    }
    bridge.acceptedBytes += chunk.length;
    bridge.pending += chunk.length;
    if (bridge.pending > bridge.peakPending) bridge.peakPending = bridge.pending;
    bridge.mic.stdin.write(chunk, () => {
      bridge.pending = Math.max(0, bridge.pending - chunk.length);
    });
    return true;
  }

  /** Close a session's bridge. Safe to call for a session that has none. */
  close(sessionId: string): void {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return;
    bridge.closed = true;
    this.bridges.delete(sessionId);
    if (bridge.statsTimer) clearInterval(bridge.statsTimer);
    for (const proc of [bridge.mic, bridge.out]) {
      try {
        proc.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.logger.log(
      `VoIP audio bridge closed for ${sessionId} (peak mic backlog ${msOf(bridge.peakPending)}ms, dropped ${msOf(bridge.droppedBytes)}ms)`,
    );
  }

  isOpen(sessionId: string): boolean {
    return this.bridges.get(sessionId)?.closed === false;
  }

  /** Frame size clients should send, so a browser does not have to guess. */
  static frameBytes(): number {
    return FRAME_BYTES;
  }

  onModuleDestroy(): void {
    for (const sessionId of [...this.bridges.keys()]) this.close(sessionId);
  }
}

const defaultSpawn: AudioSpawn = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
