/**
 * Compact, offline-transferable encoding of a diagnostics capture.
 *
 * The point of this format is to get a playback-stall report off the TV without a network round
 * trip, because the failure being investigated is itself a network stall. The encoded payload is
 * rendered as a QR code, scanned with a phone, and pasted back as text.
 *
 * Pipeline: compact text -> deflate-raw (when the runtime has CompressionStream) -> Base32 -> QR.
 *
 * Base32 rather than Base64 is deliberate: its A-Z2-7 alphabet is a subset of the QR alphanumeric
 * charset, so the code is encoded in alphanumeric mode (5.5 bits/char) instead of byte mode
 * (8 bits/char). That fits noticeably more payload into the same physical code size.
 *
 * `scripts/decode-diagnostics.js` is the reference decoder and must be kept in sync with the
 * FORMAT_VERSION and EVENT_CODES below.
 */

export const FORMAT_VERSION = 1;
export const PAYLOAD_PREFIX = 'KPD';

/**
 * Characters per QR code. Chosen so a chunk stays around 100 modules at error-correction level M,
 * which scans reliably off a TV panel from a couch-length distance.
 */
export const MAX_CHARS_PER_CHUNK = 900;

/** The chunk header carries index and count as single digits. */
export const MAX_CHUNKS = 9;

/**
 * Event names are the single largest repeated cost in the history, so they travel as table indices.
 * Append-only: existing entries must never be reordered or removed, or older decoders break.
 */
export const EVENT_CODES = [
  'playing',
  'waiting',
  'stalled',
  'canplay',
  'canplaythrough',
  'seeking',
  'seeked',
  'error',
  'ended',
  'FRAG_LOADING',
  'FRAG_LOADED',
  'FRAG_LOAD_EMERGENCY_ABORTED',
  'FRAG_BUFFERED',
  'FRAG_CHANGED',
  'BUFFER_APPENDING',
  'BUFFER_APPENDED',
  'LEVEL_SWITCHED',
  'ERROR',
];

const EVENT_CODE_BY_NAME = new Map(EVENT_CODES.map((name, index) => [name, index]));

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type ExportEvent = {
  timestamp: number;
  source: 'video' | 'hls';
  name: string;
  details?: string;
};

export type ExportCapture = {
  capturedAt: number;
  appVersion?: string;
  playback?: {
    currentTime: number;
    duration: number;
    paused: boolean;
    seeking: boolean;
    readyState: number;
    networkState: number;
    videoErrorCode?: number;
  };
  buffer?: {
    ahead?: number;
    positionBuffered: boolean;
    ranges: { start: number; end: number }[];
  };
  hls?: {
    active: boolean;
    selectedQuality?: string;
    levelCount: number;
    mode: string;
    currentLevel?: number;
    nextLevel?: number;
    loadLevel?: number;
    autoLevelCapping?: number;
    bandwidthEstimate?: number;
    levels: string[];
  };
  lastFragment?: {
    level?: number;
    height?: number;
    bytes?: number;
    loadSeconds?: number;
    ageSeconds?: number;
  };
  pipeline?: {
    load: string;
    append: string;
    emergencyAborts: number;
  };
  failures?: {
    network: number;
    buffer: number;
    media: number;
    other: number;
    lastCategory?: string;
    lastAgeSeconds?: number;
  };
  decode?: {
    totalFrames: number;
    droppedFrames: number;
  };
  /** Newest first — see the delta encoding in `buildCompactText`. */
  events: ExportEvent[];
};

/** Fields are separated by `|`, so any literal separator in free text has to go. */
function clean(value: unknown) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value)
    .replace(/[|\n\r]+/g, ' ')
    .trim();
}

function num(value: number | undefined, digits = 0) {
  if (value === undefined || !Number.isFinite(value)) {
    return '';
  }

  return digits > 0 ? String(Number(value.toFixed(digits))) : String(Math.round(value));
}

function bool(value: boolean | undefined) {
  return value ? '1' : '0';
}

/**
 * Builds the pre-compression text form. Line-oriented and tagged by a leading letter so the decoder
 * stays readable and unknown lines from a newer producer can simply be skipped.
 */
export function buildCompactText(capture: ExportCapture) {
  const lines: string[] = [];

  lines.push(`v|${FORMAT_VERSION}|${capture.capturedAt}|${clean(capture.appVersion)}`);

  if (capture.playback) {
    const p = capture.playback;

    lines.push(
      `p|${num(p.currentTime, 1)}|${num(p.duration, 1)}|${bool(p.paused)}|${bool(p.seeking)}|${p.readyState}|${p.networkState}|${num(
        p.videoErrorCode,
      )}`,
    );
  }

  if (capture.buffer) {
    const b = capture.buffer;
    const ranges = b.ranges.map((range) => `${num(range.start, 1)}-${num(range.end, 1)}`).join(';');

    lines.push(`b|${num(b.ahead, 1)}|${bool(b.positionBuffered)}|${ranges}`);
  }

  if (capture.hls) {
    const h = capture.hls;

    lines.push(
      `h|${bool(h.active)}|${clean(h.selectedQuality)}|${h.levelCount}|${clean(h.mode)}|${num(h.currentLevel)}|${num(h.nextLevel)}|${num(
        h.loadLevel,
      )}|${num(h.autoLevelCapping)}|${num(h.bandwidthEstimate)}`,
    );
    lines.push(`l|${h.levels.map(clean).join(';')}`);
  }

  if (capture.lastFragment) {
    const f = capture.lastFragment;

    lines.push(`f|${num(f.level)}|${num(f.height)}|${num(f.bytes)}|${num(f.loadSeconds, 2)}|${num(f.ageSeconds, 1)}`);
  }

  if (capture.pipeline) {
    const s = capture.pipeline;

    lines.push(`s|${clean(s.load)}|${clean(s.append)}|${s.emergencyAborts}`);
  }

  if (capture.failures) {
    const e = capture.failures;

    lines.push(`e|${e.network}|${e.buffer}|${e.media}|${e.other}|${clean(e.lastCategory)}|${num(e.lastAgeSeconds, 1)}`);
  }

  if (capture.decode) {
    lines.push(`q|${capture.decode.totalFrames}|${capture.decode.droppedFrames}`);
  }

  // Events must arrive newest-first: each delta counts milliseconds *backwards* from the previous
  // entry, starting at the capture time. That keeps every line short, compresses far better than
  // absolute clock times, and means truncating the tail drops the oldest events rather than the
  // ones nearest the failure.
  let previousTimestamp = capture.capturedAt;

  capture.events.forEach((event) => {
    const delta = Math.max(0, previousTimestamp - event.timestamp);

    previousTimestamp = event.timestamp;

    const code = EVENT_CODE_BY_NAME.get(event.name);
    const name = code === undefined ? clean(event.name) : String(code);

    lines.push(`E|${delta}|${event.source === 'hls' ? 'h' : 'v'}|${name}|${clean(event.details)}`);
  });

  return lines.join('\n');
}

export function toBase32(bytes: Uint8Array) {
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    buffer = (buffer << 8) | bytes[index];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }

  return output;
}

function utf8Bytes(text: string) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }

  // webOS builds without TextEncoder still need a correct UTF-8 path for Cyrillic details text.
  const encoded = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(encoded.length);

  for (let index = 0; index < encoded.length; index += 1) {
    bytes[index] = encoded.charCodeAt(index);
  }

  return bytes;
}

// Not in the DOM lib of the pinned TypeScript, and absent on older webOS browsers, so it is
// declared here and always reached through a `typeof` guard.
declare const CompressionStream:
  | (new (format: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> })
  | undefined;

async function deflate(bytes: Uint8Array) {
  // `typeof` rather than a `globalThis` lookup: older webOS browsers predate `globalThis`, and this
  // must not depend on core-js having been loaded first.
  const CompressionStreamCtor = typeof CompressionStream === 'undefined' ? undefined : CompressionStream;

  if (!CompressionStreamCtor) {
    return null;
  }

  try {
    const stream = new CompressionStreamCtor('deflate-raw');
    const writer = stream.writable.getWriter();

    writer.write(bytes);
    writer.close();

    const chunks: Uint8Array[] = [];
    const reader = stream.readable.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // A non-final read can still yield no chunk; only the `done` flag ends the stream.
      if (value) {
        chunks.push(value);
      }
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;

    chunks.forEach((chunk) => {
      result.set(chunk, offset);
      offset += chunk.length;
    });

    return result;
  } catch (e) {
    return null;
  }
}

export type EncodedCapture = {
  /** One string per QR code, already carrying its own header. */
  chunks: string[];
  compressed: boolean;
  /** Length of the Base32 body, useful for showing how close a capture is to needing a second code. */
  encodedLength: number;
  /** How many of the oldest events had to be dropped to stay within MAX_CHUNKS. */
  droppedEvents: number;
};

/**
 * Encodes a capture into one or more self-describing QR payload strings.
 *
 * Each chunk looks like `KPD1<C><index><count>.<base32>`, where `<C>` is `D` for deflated or `P`
 * for plain. Index and count are single digits; a capture large enough to need ten codes is not
 * worth scanning, so the caller should trim history instead.
 */
export async function encodeCapture(capture: ExportCapture): Promise<EncodedCapture> {
  let events = capture.events;

  for (;;) {
    const text = buildCompactText({ ...capture, events });
    const raw = utf8Bytes(text);
    const deflated = await deflate(raw);
    const compressed = Boolean(deflated && deflated.length < raw.length);
    const body = toBase32(compressed && deflated ? deflated : raw);
    const chunkCount = Math.max(1, Math.ceil(body.length / MAX_CHARS_PER_CHUNK));

    // Index and count are single digits, so the header cannot express more than MAX_CHUNKS parts.
    // Nobody is going to scan ten codes anyway: drop the oldest events and try again rather than
    // emit a payload the decoder would reject.
    if (chunkCount > MAX_CHUNKS) {
      if (events.length > 0) {
        // Halving reaches zero (floor(1 / 2) === 0), so this always terminates.
        events = events.slice(0, Math.floor(events.length / 2));
        continue;
      }

      // The snapshot alone is too large, so there is nothing left to trim. Fail loudly: emitting
      // two-digit indices here would produce codes the reference decoder rejects by design, which
      // is a worse outcome than telling the user the capture could not be encoded.
      throw new Error(`Diagnostics capture needs ${chunkCount} QR codes, more than the ${MAX_CHUNKS} the format allows.`);
    }

    const chunks: string[] = [];

    for (let index = 0; index < chunkCount; index += 1) {
      const slice = body.slice(index * MAX_CHARS_PER_CHUNK, (index + 1) * MAX_CHARS_PER_CHUNK);

      chunks.push(`${PAYLOAD_PREFIX}${FORMAT_VERSION}${compressed ? 'D' : 'P'}${index + 1}${chunkCount}.${slice}`);
    }

    return { chunks, compressed, encodedLength: body.length, droppedEvents: capture.events.length - events.length };
  }
}
