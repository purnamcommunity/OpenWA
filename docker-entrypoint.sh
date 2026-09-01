#!/bin/sh
# Runs as root (via dumb-init). Fixes named-volume ownership then drops to the
# openwa user via gosu so the Node process never holds root privileges.
set -e

mkdir -p /app/data/sessions /app/data/media /app/data/plugins
chown -R openwa:openwa /app/data

# Chromium leaves SingletonLock/SingletonSocket/SingletonCookie in each session profile and does
# not remove them on an unclean shutdown; stale locks block the next launch ("profile appears to be
# in use by another Chromium process", exit Code 21). No Chromium is running yet at entrypoint time,
# so clearing them lets sessions re-launch after a crash/restart. (#259)
rm -f /app/data/sessions/*/Singleton* 2>/dev/null || true

# Chromium resolves its home from the passwd entry (no /home/openwa exists), so it hard-crashes at
# launch unless its config/cache dirs exist and are writable. XDG_CONFIG_HOME/XDG_CACHE_HOME (set in
# the image) point here; create them owned by openwa. On a read_only rootfs these live on tmpfs /tmp,
# which is mounted fresh each start — so they must be (re)created at runtime, not at build. (#254)
if ! mkdir -p "${XDG_CONFIG_HOME:-/tmp/.config}" "${XDG_CACHE_HOME:-/tmp/.cache}"; then
  echo "FATAL: cannot create Chromium config/cache dirs (${XDG_CONFIG_HOME:-/tmp/.config}, ${XDG_CACHE_HOME:-/tmp/.cache})." >&2
  echo "       On a read_only rootfs, mount a writable tmpfs/emptyDir at /tmp (compose: 'tmpfs: [/tmp]'; k8s: an emptyDir at /tmp)." >&2
  echo "       Without it Chromium cannot launch and sessions will fail (#254)." >&2
  exit 1
fi
chown openwa:openwa "${XDG_CONFIG_HOME:-/tmp/.config}" "${XDG_CACHE_HOME:-/tmp/.cache}"

# VOIP audio devices. Chromium opens a PulseAudio source for a call's microphone and plays the far
# end to a sink; a container has no sound hardware, so without this getUserMedia fails
# NotFoundError and any call carries silence.
#
# TWO null sinks, deliberately. The operator's microphone is played into `micsink`, whose monitor is
# remapped to the source `vmic` that Chromium records. Chromium's own playback goes to a SEPARATE
# `outsink`, whose monitor the bridge records and streams back to the operator. Collapsing these
# into one sink loops Chromium's output straight back into its own microphone — the far end hears
# itself, which is the whole reason for the split.
#
# The daemon runs as openwa, never --system: its runtime dir is the tmpfs /tmp, so a read_only
# rootfs needs no extra mount. Failure here is NOT fatal — a session that never places a call is
# unaffected, so a broken audio device must not cost the operator their messaging.
if [ "${VOIP_AUDIO_ENABLED:-false}" = "true" ]; then
  PULSE_DIR="${PULSE_RUNTIME_PATH:-/tmp/pulse}"
  MIC_SINK="${VOIP_AUDIO_MIC_SINK:-micsink}"
  OUT_SINK="${VOIP_AUDIO_OUT_SINK:-outsink}"
  SOURCE="${VOIP_AUDIO_SOURCE:-vmic}"
  # gosu does not synthesize an environment for the target user, and PulseAudio resolves both its
  # runtime dir and its cookie from one — so HOME and PULSE_RUNTIME_PATH are passed explicitly.
  # Without them the daemon binds a different path than Chromium later looks in.
  PA="gosu openwa env HOME=${HOME:-/app/data} PULSE_RUNTIME_PATH=$PULSE_DIR"
  # Pin every device to the format the call itself uses: 48 kHz mono, which is what WebRTC
  # captures and what the bridge sends. PulseAudio otherwise defaults these to 44.1 kHz STEREO,
  # so a call's audio is resampled and channel-converted on the way in and again on the way out —
  # for no gain, since nothing in the path is stereo or 44.1 kHz.
  PA_FORMAT="rate=48000 channels=1 format=s16le"
  if mkdir -p "$PULSE_DIR" && chown openwa:openwa "$PULSE_DIR"; then
    # --exit-idle-time=-1 keeps the daemon up while no client holds a stream; without it PulseAudio
    # exits between calls and the devices disappear from Chromium's enumeration.
    if $PA pulseaudio --start --exit-idle-time=-1 --disallow-exit --realtime=no 2>/dev/null &&
       $PA pactl load-module module-null-sink sink_name="$MIC_SINK" $PA_FORMAT >/dev/null 2>&1 &&
       $PA pactl load-module module-null-sink sink_name="$OUT_SINK" $PA_FORMAT >/dev/null 2>&1 &&
       $PA pactl load-module module-remap-source source_name="$SOURCE" master="$MIC_SINK.monitor" $PA_FORMAT >/dev/null 2>&1; then
      # Chromium picks the DEFAULTS; pinning them is what makes it record the operator rather than
      # an arbitrary monitor, and play to the sink the bridge is recording.
      $PA pactl set-default-source "$SOURCE" >/dev/null 2>&1 || true
      $PA pactl set-default-sink "$OUT_SINK" >/dev/null 2>&1 || true
      echo "VOIP audio: PulseAudio ready (mic '$SOURCE' <- '$MIC_SINK', playback -> '$OUT_SINK')."
    else
      echo "WARNING: VOIP_AUDIO_ENABLED=true but the PulseAudio devices could not be created." >&2
      echo "         Calls will have no audio; messaging is unaffected." >&2
    fi
  else
    echo "WARNING: cannot create PulseAudio runtime dir $PULSE_DIR; calls will have no audio." >&2
  fi
fi

# "$@" = CMD from Dockerfile (default: node dist/main).
# gosu performs exec, so the node process replaces this shell and becomes the
# direct child of dumb-init (PID 1), which can therefore forward SIGTERM cleanly.
exec gosu openwa "$@"
