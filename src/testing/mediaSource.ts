/**
 * A Media Source Extensions stub for jsdom.
 *
 * jsdom implements no part of MSE, so `Hls.isSupported()` returns false there and hls.js refuses to
 * do anything at all. This provides just enough of the API for hls.js to attach to a media element,
 * open a media source, create source buffers and complete append operations -- which is what the
 * playback scenario tests need in order to drive the real hls.js through a real failure.
 *
 * It has to be installed before hls.js is *imported*, not merely before it is used: the bundle
 * evaluates `var MediaSource = getMediaSource()` at module scope, so a stub installed later is
 * never seen. `src/setupTests.ts` is the only place that satisfies that ordering for every test
 * file, including ones that reach hls.js indirectly through a component import.
 */

type Listener = (event?: unknown) => void;

/** Nothing here decodes anything, so appended bytes are only ever counted, never inspected. */
export class StubSourceBuffer {
  readonly mime: string;
  updating = false;
  timestampOffset = 0;
  appendWindowStart = 0;
  appendWindowEnd = Infinity;
  mode = 'segments';
  appendCount = 0;
  appendedBytes = 0;
  removed = false;

  private ranges: { start: number; end: number }[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(mime: string) {
    this.mime = mime;
  }

  get buffered() {
    const ranges = this.ranges;

    return {
      length: ranges.length,
      start: (index: number) => ranges[index].start,
      end: (index: number) => ranges[index].end,
    };
  }

  /**
   * Sets the range this buffer reports. The stub cannot derive it -- it sees bytes, not timing --
   * so the scenario says what buffering a fragment was worth.
   */
  setBufferedRange(start: number, end: number) {
    this.ranges = end > start ? [{ start, end }] : [];
  }

  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
  }

  private emit(type: string) {
    (this.listeners[type] || []).slice().forEach((fn) => fn({ type }));
  }

  appendBuffer(data: ArrayBufferView | ArrayBuffer) {
    this.appendCount += 1;
    this.appendedBytes += (data as ArrayBufferView).byteLength ?? (data as ArrayBuffer).byteLength ?? 0;
    this.updating = true;
    // Real source buffers complete asynchronously and hls.js queues its operations behind
    // `updateend`, so completing synchronously would let it skip states it takes in a browser.
    setTimeout(() => {
      this.updating = false;
      this.emit('updateend');
    }, 0);
  }

  remove(start: number, end: number) {
    this.ranges = this.ranges.map((range) => (range.start >= start && range.end <= end ? undefined : range)).filter(Boolean) as {
      start: number;
      end: number;
    }[];
    this.updating = true;
    setTimeout(() => {
      this.updating = false;
      this.emit('updateend');
    }, 0);
  }

  changeType() {}

  abort() {}
}

export class StubMediaSource {
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  duration = NaN;
  readonly sourceBuffers: StubSourceBuffer[] = [];

  private listeners: Record<string, Listener[]> = {};

  static isTypeSupported() {
    return true;
  }

  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
  }

  private emit(type: string) {
    (this.listeners[type] || []).slice().forEach((fn) => fn({ type }));
  }

  addSourceBuffer(mime: string) {
    const sourceBuffer = new StubSourceBuffer(mime);
    this.sourceBuffers.push(sourceBuffer);
    sourceBufferListeners.slice().forEach((listener) => listener(sourceBuffer));

    return sourceBuffer;
  }

  removeSourceBuffer(sourceBuffer: StubSourceBuffer) {
    const index = this.sourceBuffers.indexOf(sourceBuffer);
    if (index !== -1) {
      this.sourceBuffers.splice(index, 1);
    }
    sourceBuffer.removed = true;
  }

  setLiveSeekableRange() {}

  clearLiveSeekableRange() {}

  endOfStream() {
    this.readyState = 'ended';
    this.emit('sourceended');
  }

  open() {
    if (this.readyState === 'open') {
      return;
    }
    this.readyState = 'open';
    this.emit('sourceopen');
  }

  close() {
    this.readyState = 'closed';
    this.emit('sourceclose');
  }
}

const created: StubMediaSource[] = [];
const sourceBufferListeners: ((sourceBuffer: StubSourceBuffer) => void)[] = [];

/**
 * Notified whenever a source buffer is created.
 *
 * hls.js reads its buffer level from the `SourceBuffer`, not from the media element, so a harness
 * that only fakes `video.buffered` leaves hls.js believing it has buffered nothing and downloading
 * the entire playlist at once. Creation matters as well as content: `loadSource()` triggers a
 * `BUFFER_RESET`, which removes the source buffers and genuinely empties the buffer, and a
 * simulation that carried the old range across that boundary would hide every stall that follows a
 * playlist reload.
 */
export function onSourceBufferCreated(listener: (sourceBuffer: StubSourceBuffer) => void) {
  sourceBufferListeners.push(listener);

  return () => {
    const index = sourceBufferListeners.indexOf(listener);
    if (index !== -1) {
      sourceBufferListeners.splice(index, 1);
    }
  };
}

/** Every media source constructed since the last reset, oldest first. */
export function mediaSources() {
  return created;
}

/** The media source hls.js is currently attached to, i.e. the most recent one. */
export function currentMediaSource(): StubMediaSource | undefined {
  return created[created.length - 1];
}

export function resetMediaSourceStub() {
  created.length = 0;
  sourceBufferListeners.length = 0;
}

let installed = false;

export function installMediaSourceStub() {
  if (installed) {
    return;
  }
  installed = true;

  const global = window as unknown as Record<string, unknown>;

  function MediaSourceStub(this: unknown) {
    const instance = new StubMediaSource();
    created.push(instance);

    return instance;
  }
  MediaSourceStub.isTypeSupported = () => true;

  global.MediaSource = MediaSourceStub;
  global.SourceBuffer = StubSourceBuffer;

  const url = window.URL as unknown as Record<string, unknown>;
  url.createObjectURL = (object: unknown) => {
    // A browser fires `sourceopen` once the element starts loading the object URL. jsdom loads
    // nothing, so the stub schedules it here -- hls.js only triggers MEDIA_ATTACHED from that
    // event, and without it nothing downstream of attaching ever runs.
    if (object instanceof StubMediaSource) {
      setTimeout(() => object.open(), 0);
    }

    return 'blob:stub-media-source';
  };
  url.revokeObjectURL = () => {};

  // hls.js reads `media.buffered` constantly and jsdom's is permanently empty; the scenario tests
  // install their own descriptor per element (see `attachPlaybackStub`).
  const media = (window as unknown as { HTMLMediaElement: { prototype: HTMLMediaElement } }).HTMLMediaElement.prototype;
  media.play = function play() {
    return Promise.resolve();
  };
  media.pause = function pause() {};
  media.load = function load() {};
}
