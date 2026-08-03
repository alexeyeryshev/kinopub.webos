#!/usr/bin/env node
/**
 * Reference decoder for the diagnostics QR payload produced by
 * `src/components/player/diagnosticsExport.ts`.
 *
 * Usage:
 *   node scripts/decode-diagnostics.js "KPD1D11.MFRGG..."
 *   node scripts/decode-diagnostics.js "KPD1D12.AAA..." "KPD1D22.BBB..."
 *   pbpaste | node scripts/decode-diagnostics.js
 *
 * Chunks may be passed in any order; they are reassembled by their index header. Add `--json` to
 * emit a structured object instead of the human-readable report.
 *
 * This file is the contract for the wire format. Any change to FORMAT_VERSION or EVENT_CODES in
 * diagnosticsExport.ts has to land here in the same commit.
 */

const zlib = require('zlib');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Must stay index-aligned with EVENT_CODES in src/components/player/diagnosticsExport.ts.
const EVENT_CODES = [
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

const CHUNK_PATTERN = /^KPD(\d+)([DP])(\d)(\d)\.([A-Z2-7]*)$/;

function fromBase32(text) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;

  for (const char of text) {
    const value = BASE32_ALPHABET.indexOf(char);

    if (value < 0) {
      throw new Error(`Invalid Base32 character: ${char}`);
    }

    buffer = (buffer << 5) | value;
    bits += 5;

    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function parseChunks(inputs) {
  const parsed = inputs
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const match = CHUNK_PATTERN.exec(raw);

      if (!match) {
        throw new Error(`Not a diagnostics payload: ${raw.slice(0, 24)}…`);
      }

      return {
        version: Number(match[1]),
        compressed: match[2] === 'D',
        index: Number(match[3]),
        count: Number(match[4]),
        body: match[5],
      };
    });

  if (!parsed.length) {
    throw new Error('No payload given.');
  }

  const { count, version, compressed } = parsed[0];

  if (parsed.length !== count) {
    throw new Error(`Expected ${count} chunk(s), got ${parsed.length}.`);
  }

  parsed.sort((a, b) => a.index - b.index);
  parsed.forEach((chunk, position) => {
    if (chunk.index !== position + 1) {
      throw new Error(`Missing chunk ${position + 1} of ${count}.`);
    }
  });

  return { version, compressed, body: parsed.map((chunk) => chunk.body).join('') };
}

function decodePayload(inputs) {
  const { version, compressed, body } = parseChunks(inputs);
  const raw = fromBase32(body);
  const text = (compressed ? zlib.inflateRawSync(raw) : raw).toString('utf8');

  return { version, text };
}

function optional(value) {
  return value === '' || value === undefined ? undefined : value;
}

function parseCompactText(text) {
  const report = { events: [] };
  let clock;

  text.split('\n').forEach((line) => {
    const parts = line.split('|');
    const tag = parts[0];

    if (tag === 'v') {
      report.formatVersion = Number(parts[1]);
      report.capturedAt = Number(parts[2]);
      report.appVersion = optional(parts[3]);
      clock = report.capturedAt;
    } else if (tag === 'p') {
      report.playback = {
        currentTime: Number(parts[1]),
        duration: Number(parts[2]),
        paused: parts[3] === '1',
        seeking: parts[4] === '1',
        readyState: Number(parts[5]),
        networkState: Number(parts[6]),
        videoErrorCode: optional(parts[7]),
      };
    } else if (tag === 'b') {
      report.buffer = {
        aheadSeconds: optional(parts[1]),
        positionBuffered: parts[2] === '1',
        ranges: optional(parts[3]),
      };
    } else if (tag === 'h') {
      report.hls = {
        active: parts[1] === '1',
        selectedQuality: optional(parts[2]),
        levelCount: Number(parts[3]),
        mode: optional(parts[4]),
        currentLevel: optional(parts[5]),
        nextLevel: optional(parts[6]),
        loadLevel: optional(parts[7]),
        autoLevelCapping: optional(parts[8]),
        bandwidthEstimateBps: optional(parts[9]),
      };
    } else if (tag === 'l') {
      report.levels = optional(parts[1]);
    } else if (tag === 'f') {
      report.lastFragment = {
        level: optional(parts[1]),
        height: optional(parts[2]),
        bytes: optional(parts[3]),
        loadSeconds: optional(parts[4]),
        ageSeconds: optional(parts[5]),
      };
    } else if (tag === 's') {
      report.pipeline = { load: optional(parts[1]), append: optional(parts[2]), emergencyAborts: Number(parts[3]) };
    } else if (tag === 'e') {
      report.failures = {
        network: Number(parts[1]),
        buffer: Number(parts[2]),
        media: Number(parts[3]),
        other: Number(parts[4]),
        lastCategory: optional(parts[5]),
        lastAgeSeconds: optional(parts[6]),
      };
    } else if (tag === 'q') {
      report.decode = { totalFrames: Number(parts[1]), droppedFrames: Number(parts[2]) };
    } else if (tag === 'E') {
      // Deltas run backwards from the capture time, newest event first.
      clock -= Number(parts[1]);

      const code = Number(parts[3]);

      report.events.push({
        timestamp: clock,
        source: parts[2] === 'h' ? 'hls' : 'video',
        name: Number.isInteger(code) && EVENT_CODES[code] !== undefined ? EVENT_CODES[code] : parts[3],
        details: optional(parts.slice(4).join('|')),
      });
    }
  });

  return report;
}

function formatReport(report) {
  const lines = [];
  const at = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

  lines.push(`format v${report.formatVersion}  app ${report.appVersion || 'n/a'}  captured ${at(report.capturedAt)}`);

  if (report.playback) {
    const p = report.playback;

    lines.push(
      `playback: t=${p.currentTime}/${p.duration}s paused=${p.paused} seeking=${p.seeking} readyState=${p.readyState} networkState=${p.networkState}` +
        (p.videoErrorCode ? ` videoError=${p.videoErrorCode}` : ''),
    );
  }

  if (report.buffer) {
    lines.push(
      `buffer:   ahead=${report.buffer.aheadSeconds ?? 'n/a'}s buffered=${report.buffer.positionBuffered} ranges=${
        report.buffer.ranges || 'none'
      }`,
    );
  }

  if (report.hls) {
    const h = report.hls;

    lines.push(
      `hls:      active=${h.active} quality=${h.selectedQuality || 'n/a'} mode=${h.mode} levels=${h.levelCount} cur=${
        h.currentLevel ?? 'n/a'
      } next=${h.nextLevel ?? 'n/a'} load=${h.loadLevel ?? 'n/a'} capping=${h.autoLevelCapping ?? 'n/a'} bw=${
        h.bandwidthEstimateBps ?? 'n/a'
      }bps`,
    );
  }

  if (report.levels) {
    lines.push(`levels:   ${report.levels}`);
  }

  if (report.lastFragment) {
    const f = report.lastFragment;

    lines.push(
      `lastFrag: level=${f.level ?? 'n/a'} height=${f.height ?? 'n/a'} bytes=${f.bytes ?? 'n/a'} load=${f.loadSeconds ?? 'n/a'}s age=${
        f.ageSeconds ?? 'n/a'
      }s`,
    );
  }

  if (report.pipeline) {
    lines.push(`pipeline: load=${report.pipeline.load || 'idle'}`);
    lines.push(`          append=${report.pipeline.append || 'idle'} emergencyAborts=${report.pipeline.emergencyAborts}`);
  }

  if (report.failures) {
    const e = report.failures;

    lines.push(
      `failures: network=${e.network} bufferStarvation=${e.buffer} media=${e.media} other=${e.other} last=${e.lastCategory || 'none'}${
        e.lastAgeSeconds ? ` (${e.lastAgeSeconds}s ago)` : ''
      }`,
    );
  }

  if (report.decode) {
    lines.push(`decode:   frames=${report.decode.totalFrames} dropped=${report.decode.droppedFrames}`);
  }

  lines.push('');
  lines.push(`events (${report.events.length}, newest first):`);
  report.events.forEach((event) => {
    lines.push(
      `  ${at(event.timestamp).slice(11, 23)} ${event.source.padEnd(5)} ${event.name}${event.details ? ` - ${event.details}` : ''}`,
    );
  });

  return lines.join('\n');
}

function run(inputs, asJson) {
  const { text } = decodePayload(inputs);
  const report = parseCompactText(text);

  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');

  const main = (inputs) => {
    try {
      run(inputs, asJson);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  };

  if (positional.length) {
    main(positional);
  } else {
    let stdin = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      stdin += chunk;
    });
    process.stdin.on('end', () => main(stdin.split(/\s+/)));
  }
}

module.exports = { decodePayload, parseCompactText, formatReport, fromBase32 };
