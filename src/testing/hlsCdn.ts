/**
 * A scripted CDN for the playback scenario tests.
 *
 * The mock sits at the HTTP boundary -- it is an hls.js `config.loader`, which is the library's
 * documented extension point for "how bytes are fetched" and has kept the same shape across every
 * 1.x release. Everything above it is the real hls.js: playlist parsing, level selection, the
 * non-fatal retry ladder, and the escalation to a fatal error are all performed by the library
 * under test rather than simulated here.
 *
 * That boundary is the point. Mocking anything higher -- hls.js events, the error controller --
 * would bake this version's internals into the tests, and an upgrade would then be a rewrite of the
 * tests rather than a check on them. A failing CDN is a fact about the network; it means the same
 * thing in 1.0 and in 1.7.
 *
 * The retry and timeout behaviour below deliberately mirrors hls.js's own `XhrLoader`, because
 * hls.js delegates part of its retry policy to the loader: playlist requests are issued with a
 * non-zero `maxRetry` and the loader is expected to honour it, while fragment requests come with
 * `maxRetry: 0` because the stream controller retries those itself. A mock that ignored
 * `maxRetry` would make manifest failures escalate several steps earlier than they do in a browser.
 */

/** What a request was for, derived from the URL so scenarios can talk about kinds, not paths. */
export type CdnRequestKind = 'manifest' | 'playlist' | 'fragment';

export type CdnRequest = {
  url: string;
  /** Hostname only, so scenarios can single out one CDN edge the way the real failure did. */
  host: string;
  path: string;
  kind: CdnRequestKind;
  /** Virtual clock reading when the request was issued. */
  at: number;
  /** How many times this exact URL has been requested, including this one. */
  attempt: number;
};

/**
 * `hang` models the failure this player was actually built for: an edge that accepts the connection
 * and then never answers, which is what turns into a frozen picture rather than an error.
 */
export type CdnReply = { status: number; body?: string | Uint8Array } | { hang: true };

export type CdnHandler = (request: CdnRequest) => CdnReply | undefined | void;

export type LevelSpec = {
  name: string;
  bandwidth: number;
  resolution?: string;
  codecs?: string;
  videoRange?: 'SDR' | 'PQ' | 'HLG';
  /** Audio group the level references, when the scenario needs alternate audio renditions. */
  audioGroup?: string;
};

export type AudioRenditionSpec = {
  groupId: string;
  name: string;
  language?: string;
  default?: boolean;
};

export type MockCdnOptions = {
  /** Host serving the master playlist. Segments are served from the edges below. */
  origin?: string;
  levels?: LevelSpec[];
  audioRenditions?: AudioRenditionSpec[];
  segmentCount?: number;
  segmentDuration?: number;
  /**
   * Hosts handed to successive media-playlist responses, the last repeating. A real playlist
   * refetch is how the player escapes a bad edge -- the new playlist carries new segment URLs --
   * so the mock has to be able to change edges between fetches or the watchdog's escalation cannot
   * be shown to achieve anything.
   */
  edges?: string[];
};

const DEFAULTS = {
  origin: 'https://cdn.test',
  levels: [{ name: '720p', bandwidth: 1200000, resolution: '1280x536', codecs: 'mp4a.40.2' }] as LevelSpec[],
  segmentCount: 60,
  segmentDuration: 10,
  edges: ['edge-01.cdn.test'],
};

function hostOf(url: string) {
  const match = /^https?:\/\/([^/]+)/.exec(url);

  return match ? match[1] : '';
}

function pathOf(url: string) {
  return url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
}

function kindOf(path: string): CdnRequestKind {
  if (path.endsWith('master.m3u8')) {
    return 'manifest';
  }

  return path.endsWith('.m3u8') ? 'playlist' : 'fragment';
}

/**
 * A single AAC frame in ADTS framing.
 *
 * hls.js probes segment bytes to pick a demuxer and never decodes the payload, so a syntactically
 * valid header over arbitrary bytes is enough to carry a fragment all the way through demux, remux
 * and append -- which is what `FRAG_BUFFERED` requires, and `FRAG_BUFFERED` is what the player
 * treats as proof that a failing stream has recovered.
 */
function adtsFrame(payloadLength: number) {
  const frameLength = 7 + payloadLength;
  const frame = new Uint8Array(frameLength);

  frame[0] = 0xff;
  // MPEG-4, layer 0, no CRC.
  frame[1] = 0xf1;
  // AAC-LC, 44100 Hz (index 4), channel configuration 2 (stereo).
  frame[2] = 0x50;
  frame[3] = 0x80 | ((frameLength >> 11) & 0x03);
  frame[4] = (frameLength >> 3) & 0xff;
  frame[5] = ((frameLength & 0x07) << 5) | 0x1f;
  frame[6] = 0xfc;

  return frame;
}

/** Concatenated ADTS frames, roughly `duration` seconds' worth at 1024 samples per frame. */
export function syntheticSegment(duration: number) {
  const frames = Math.max(1, Math.round((duration * 44100) / 1024));
  const payloadLength = 20;
  const segment = new Uint8Array(frames * (7 + payloadLength));

  for (let index = 0; index < frames; index += 1) {
    segment.set(adtsFrame(payloadLength), index * (7 + payloadLength));
  }

  return segment;
}

/** jsdom under jest 26 has no global TextEncoder/TextDecoder, and playlists are ASCII anyway. */
function toArrayBuffer(body: string | Uint8Array): ArrayBuffer {
  if (typeof body !== 'string') {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }

  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) {
    bytes[index] = body.charCodeAt(index) & 0xff;
  }

  return bytes.buffer;
}

function toText(body: string | Uint8Array): string {
  if (typeof body === 'string') {
    return body;
  }

  let text = '';
  for (let index = 0; index < body.length; index += 1) {
    text += String.fromCharCode(body[index]);
  }

  return text;
}

type LoaderCallbacks = {
  onSuccess: (response: unknown, stats: unknown, context: unknown, networkDetails: unknown) => void;
  onError: (error: { code: number; text: string }, context: unknown, networkDetails: unknown, stats?: unknown) => void;
  onTimeout: (stats: unknown, context: unknown, networkDetails: unknown) => void;
  onProgress?: (stats: unknown, context: unknown, data: unknown, networkDetails: unknown) => void;
};

type LoaderConfiguration = {
  maxRetry: number;
  timeout: number;
  retryDelay: number;
  maxRetryDelay: number;
};

function newStats() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

export function createMockCdn(options: MockCdnOptions = {}) {
  const origin = options.origin ?? DEFAULTS.origin;
  const levels = options.levels ?? DEFAULTS.levels;
  const audioRenditions = options.audioRenditions ?? [];
  const segmentCount = options.segmentCount ?? DEFAULTS.segmentCount;
  const segmentDuration = options.segmentDuration ?? DEFAULTS.segmentDuration;
  const edges = options.edges?.length ? options.edges : DEFAULTS.edges;

  const requests: CdnRequest[] = [];
  const attempts = new Map<string, number>();
  const handlers: CdnHandler[] = [];
  const observers: ((request: CdnRequest, reply: CdnReply) => void)[] = [];
  /** Mutable so a scenario can change what the master playlist says between fetches. */
  let currentRenditions = audioRenditions;
  let playlistFetches = 0;

  const masterUrl = `${origin}/master.m3u8`;

  function edgeForFetch(index: number) {
    return edges[Math.min(index, edges.length - 1)];
  }

  function buildMaster() {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    currentRenditions.forEach((rendition) => {
      const attrs = [
        'TYPE=AUDIO',
        `GROUP-ID="${rendition.groupId}"`,
        `NAME="${rendition.name}"`,
        rendition.language ? `LANGUAGE="${rendition.language}"` : undefined,
        `DEFAULT=${rendition.default ? 'YES' : 'NO'}`,
        'AUTOSELECT=YES',
      ]
        .filter(Boolean)
        .join(',');
      lines.push(`#EXT-X-MEDIA:${attrs}`);
    });

    levels.forEach((level, index) => {
      const attrs = [
        `BANDWIDTH=${level.bandwidth}`,
        level.resolution ? `RESOLUTION=${level.resolution}` : undefined,
        level.codecs ? `CODECS="${level.codecs}"` : undefined,
        level.videoRange ? `VIDEO-RANGE=${level.videoRange}` : undefined,
        level.audioGroup ? `AUDIO="${level.audioGroup}"` : undefined,
      ]
        .filter(Boolean)
        .join(',');
      lines.push(`#EXT-X-STREAM-INF:${attrs}`, `${origin}/level${index}.m3u8`);
    });

    return `${lines.join('\n')}\n`;
  }

  function buildMediaPlaylist(levelIndex: number) {
    // Each fetch may be answered from a different edge; that is the mechanism the stall watchdog
    // relies on, so it is modelled rather than assumed.
    const edge = edgeForFetch(playlistFetches);
    playlistFetches += 1;

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ];

    for (let index = 0; index < segmentCount; index += 1) {
      lines.push(`#EXTINF:${segmentDuration.toFixed(3)},`, `https://${edge}/level${levelIndex}/seg${index}.aac`);
    }

    lines.push('#EXT-X-ENDLIST');

    return `${lines.join('\n')}\n`;
  }

  function defaultReply(request: CdnRequest): CdnReply {
    if (request.path.endsWith('master.m3u8')) {
      return { status: 200, body: buildMaster() };
    }

    const levelMatch = /level(\d+)\.m3u8$/.exec(request.path);
    if (levelMatch) {
      return { status: 200, body: buildMediaPlaylist(Number(levelMatch[1])) };
    }

    if (request.kind === 'fragment') {
      return { status: 200, body: syntheticSegment(segmentDuration) };
    }

    return { status: 404 };
  }

  function resolve(request: CdnRequest): CdnReply {
    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      const reply = handlers[index](request);

      if (reply) {
        return reply;
      }
    }

    return defaultReply(request);
  }

  class MockCdnLoader {
    context: unknown;
    stats = newStats();

    private timers: ReturnType<typeof setTimeout>[] = [];
    private retryDelay = 0;
    private destroyed = false;

    load(context: any, config: LoaderConfiguration, callbacks: LoaderCallbacks) {
      this.context = context;
      this.retryDelay = config.retryDelay;
      this.attempt(context, config, callbacks);
    }

    private attempt(context: any, config: LoaderConfiguration, callbacks: LoaderCallbacks) {
      const url: string = context.url;
      const path = pathOf(url);
      const attempt = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, attempt);

      const request: CdnRequest = { url, host: hostOf(url), path, kind: kindOf(path), at: window.performance.now(), attempt };
      requests.push(request);

      const reply = resolve(request);
      observers.forEach((observer) => observer(request, reply));
      this.stats.loading.start = window.performance.now();

      if ('hang' in reply) {
        // No response ever arrives; only hls.js's own request timeout ends this, exactly as on the
        // TV where the connection was accepted and then abandoned.
        this.timers.push(
          setTimeout(() => {
            if (!this.destroyed) {
              this.stats.aborted = true;
              callbacks.onTimeout(this.stats, context, null);
            }
          }, config.timeout),
        );

        return;
      }

      this.timers.push(
        setTimeout(() => {
          if (this.destroyed) {
            return;
          }

          this.stats.loading.first = this.stats.loading.end = window.performance.now();

          if (reply.status >= 200 && reply.status < 300 && reply.body !== undefined) {
            const wantsBinary = context.responseType === 'arraybuffer';
            const body = reply.body;
            const data = wantsBinary ? toArrayBuffer(body) : toText(body);

            this.stats.loaded = this.stats.total = typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength;

            // Not optional, and easy to miss: hls.js feeds its transmuxer from `onProgress`, and
            // its own XHR loader calls it with the whole body on completion when progressive
            // streaming is off (which it always is for a custom loader). A loader that only calls
            // `onSuccess` loads fragments that are then never demuxed, buffered or played.
            callbacks.onProgress?.(this.stats, context, data, null);
            callbacks.onSuccess({ url, data, code: reply.status }, this.stats, context, null);

            return;
          }

          // Mirrors XhrLoader: 4xx is never retried by the loader, everything else is, up to the
          // `maxRetry` hls.js chose for this request kind.
          const retryable = this.stats.retry < config.maxRetry && !(reply.status >= 400 && reply.status < 499);

          if (!retryable) {
            callbacks.onError({ code: reply.status, text: `mock cdn ${reply.status}` }, context, null, this.stats);

            return;
          }

          const delay = this.retryDelay;
          this.retryDelay = Math.min(2 * this.retryDelay, config.maxRetryDelay);
          this.stats.retry += 1;
          this.timers.push(setTimeout(() => !this.destroyed && this.attempt(context, config, callbacks), delay));
        }, 0),
      );
    }

    abort() {
      this.stats.aborted = true;
      this.clear();
    }

    destroy() {
      this.destroyed = true;
      this.clear();
    }

    /** Present because newer hls.js consults it for playlist freshness; the mock has no cache. */
    getCacheAge() {
      return null;
    }

    getResponseHeader() {
      return null;
    }

    private clear() {
      this.timers.forEach((timer) => clearTimeout(timer));
      this.timers = [];
    }
  }

  return {
    masterUrl,
    loader: MockCdnLoader,
    requests,
    segmentDuration,

    /** Notified of every request and the reply the mock decided on, before it is delivered. */
    observe(observer: (request: CdnRequest, reply: CdnReply) => void) {
      observers.push(observer);

      return () => {
        const index = observers.indexOf(observer);
        if (index !== -1) {
          observers.splice(index, 1);
        }
      };
    },

    /** Zero-based index of the segment a fragment URL refers to, or -1 for anything else. */
    segmentIndexOf(path: string) {
      const match = /seg(\d+)\.aac$/.exec(path);

      return match ? Number(match[1]) : -1;
    },

    /** Adds a rule; later rules win, and returning nothing falls through to the healthy default. */
    intercept(handler: CdnHandler) {
      handlers.push(handler);

      return () => {
        const index = handlers.indexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
      };
    },

    /** Every request that matches, in order. */
    requestsMatching(predicate: (request: CdnRequest) => boolean) {
      return requests.filter(predicate);
    },

    requestsOfKind(kind: CdnRequestKind) {
      return requests.filter((request) => request.kind === kind);
    },

    /** Replaces the audio renditions the master playlist declares from the next fetch onwards. */
    setAudioRenditions(renditions: AudioRenditionSpec[]) {
      currentRenditions = renditions;
    },
  };
}

export type MockCdn = ReturnType<typeof createMockCdn>;
