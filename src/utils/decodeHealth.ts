/**
 * Decode-health scoring for the playback indicator.
 *
 * There is no normative threshold for "the decoder is struggling", but there is a settled *metric*:
 * the dropped-frame ratio from `HTMLVideoElement.getVideoPlaybackQuality()`, which the W3C Media
 * Playback Quality spec exposes for exactly this purpose and which every player surfaces in its
 * stats panel. Two refinements matter more than the exact numbers:
 *
 * 1. A ratio, not a raw count. "Five dropped frames a minute" means 0.35% at 24 fps and 0.14% at
 *    60 fps — the same count describes very different experiences. Normalising by frames rendered
 *    makes the number mean one thing.
 * 2. A sliding window, not the cumulative totals. Cumulative counters dilute: an hour of clean
 *    playback buries a minute of stuttering, so a lifetime ratio stops describing *now*.
 *
 * Hard decode errors are tracked alongside, because they are qualitatively worse than a dropped
 * frame: a dropped frame is a late frame, while `bufferAppendError` or `fragParsingError` means the
 * decoder rejected the data outright.
 */

export type DecodeSeverity = 'ok' | 'warning' | 'severe';

/** One reading of the video element's cumulative playback-quality counters. */
export type DecodeSample = {
  at: number;
  totalVideoFrames: number;
  droppedVideoFrames: number;
};

export type DecodeHealth = {
  severity: DecodeSeverity;
  /** Dropped frames as a fraction of frames rendered inside the window, 0..1. */
  droppedRatio: number;
  droppedFrames: number;
  totalFrames: number;
  decodeErrors: number;
  /** How much of the window actually holds data, in seconds. */
  windowSeconds: number;
};

export const DECODE_WINDOW_MS = 30000;

/**
 * Below this many frames the ratio is too noisy to act on — a couple of frames dropped while the
 * pipeline spins up would otherwise read as a 100% failure.
 */
export const DECODE_MIN_FRAMES = 120;

export const DECODE_WARNING_RATIO = 0.01;
export const DECODE_SEVERE_RATIO = 0.05;

/** Hard decode errors are rare enough that a single one in the window is worth showing. */
export const DECODE_WARNING_ERRORS = 1;
export const DECODE_SEVERE_ERRORS = 3;

export const EMPTY_DECODE_HEALTH: DecodeHealth = {
  severity: 'ok',
  droppedRatio: 0,
  droppedFrames: 0,
  totalFrames: 0,
  decodeErrors: 0,
  windowSeconds: 0,
};

/** Drops entries that have aged out of the window. Keeps the newest sample before the cutoff so a
 *  delta can still be measured across it. */
export function pruneSamples(samples: DecodeSample[], now: number, windowMs = DECODE_WINDOW_MS) {
  const cutoff = now - windowMs;
  const firstInside = samples.findIndex((sample) => sample.at >= cutoff);

  if (firstInside <= 0) {
    return firstInside === 0 ? samples : samples.slice(-1);
  }

  return samples.slice(firstInside - 1);
}

export function pruneTimestamps(timestamps: number[], now: number, windowMs = DECODE_WINDOW_MS) {
  const cutoff = now - windowMs;

  return timestamps.filter((at) => at >= cutoff);
}

export function evaluateDecodeHealth(samples: DecodeSample[], decodeErrorTimes: number[], now: number): DecodeHealth {
  const decodeErrors = pruneTimestamps(decodeErrorTimes, now).length;

  if (samples.length < 2) {
    return {
      ...EMPTY_DECODE_HEALTH,
      severity: severityFromErrors(decodeErrors),
      decodeErrors,
    };
  }

  const oldest = samples[0];
  const newest = samples[samples.length - 1];

  // Loading a new source resets the element's counters. A backwards delta means that happened, so
  // the window holds two unrelated runs and cannot be compared.
  if (newest.totalVideoFrames < oldest.totalVideoFrames || newest.droppedVideoFrames < oldest.droppedVideoFrames) {
    return {
      ...EMPTY_DECODE_HEALTH,
      severity: severityFromErrors(decodeErrors),
      decodeErrors,
    };
  }

  const totalFrames = newest.totalVideoFrames - oldest.totalVideoFrames;
  const droppedFrames = newest.droppedVideoFrames - oldest.droppedVideoFrames;
  const windowSeconds = Math.max(0, (newest.at - oldest.at) / 1000);
  const droppedRatio = totalFrames > 0 ? droppedFrames / totalFrames : 0;

  const health: DecodeHealth = {
    severity: 'ok',
    droppedRatio,
    droppedFrames,
    totalFrames,
    decodeErrors,
    windowSeconds,
  };

  const errorSeverity = severityFromErrors(decodeErrors);

  if (totalFrames < DECODE_MIN_FRAMES) {
    return { ...health, severity: errorSeverity };
  }

  const ratioSeverity: DecodeSeverity =
    droppedRatio >= DECODE_SEVERE_RATIO ? 'severe' : droppedRatio >= DECODE_WARNING_RATIO ? 'warning' : 'ok';

  return { ...health, severity: worstOf(ratioSeverity, errorSeverity) };
}

function severityFromErrors(decodeErrors: number): DecodeSeverity {
  if (decodeErrors >= DECODE_SEVERE_ERRORS) {
    return 'severe';
  }

  return decodeErrors >= DECODE_WARNING_ERRORS ? 'warning' : 'ok';
}

const SEVERITY_ORDER: DecodeSeverity[] = ['ok', 'warning', 'severe'];

export function worstOf(a: DecodeSeverity, b: DecodeSeverity): DecodeSeverity {
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}
