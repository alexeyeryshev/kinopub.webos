/**
 * Mounts the real player against a scripted CDN and gives a test a clock it can wind forward.
 *
 * The component under test is `components/media/media.new`, unmodified: the recovery paths the
 * scenarios exercise are the ones that ship. Only two things are substituted -- the CDN (see
 * `hlsCdn`) and the parts of the browser jsdom does not have (media source, playback progress).
 *
 * Playback has to be simulated because jsdom decodes nothing: `currentTime` never advances on its
 * own and `buffered` is permanently empty, so the stall watchdog would see a frozen picture in
 * every test and fire in all of them. The simulation is driven from what the CDN actually
 * delivered, which keeps it honest -- make the CDN stop serving segments and the buffer stops
 * growing, so playback runs into its end exactly as it did on the TV.
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import HLS from 'hls.js';

import Media, { AudioTrack, MediaRef, SourceTrack, StreamingType } from 'components/media/media.new';

import { MockCdn, MockCdnOptions, createMockCdn } from './hlsCdn';
import { StubSourceBuffer, onSourceBufferCreated, resetMediaSourceStub } from './mediaSource';

import { sentryEpisodeSink } from 'utils/logging';
import { EpisodeCrumb, EpisodeSummary } from 'utils/playbackEpisode';

export type HarnessOptions = {
  cdn?: MockCdnOptions;
  streamingType?: StreamingType;
  /** Source tracks the player offers. The default is a single one pointing at the mock CDN. */
  sourceTracks?: SourceTrack[];
  audioTracks?: AudioTrack[];
  /** Starts the simulated transport immediately, as autoplay would. */
  autoPlay?: boolean;
};

export type HlsErrorRecord = { reason: string; fatal: boolean; at: number };

export type RecoveryStep = EpisodeCrumb & { at: number };

export type PlaybackHarness = {
  cdn: MockCdn;
  /** The imperative handle the app itself uses; assertions read the player's state through it. */
  readonly player: MediaRef;
  readonly video: HTMLVideoElement;
  /** Every episode the player reported, in order. */
  readonly episodes: EpisodeSummary[];
  /** Every hls.js error, as `type / details` plus whether it was fatal. */
  readonly hlsErrors: HlsErrorRecord[];
  /**
   * Every recovery step the player recorded, in order. Episodes are only reported once they
   * conclude and only when a fatal error was involved, so this is the way to see what a non-fatal
   * outage made the player do -- and when, relative to hls.js's own errors.
   */
  readonly steps: RecoveryStep[];
  /** Runs the player's own manual-retry path, wrapped so React state updates settle. */
  reload: () => void;
  /** Runs a viewer action against the player's imperative handle, inside `act`. */
  interact: (action: (player: MediaRef) => void) => void;
  /** Winds the virtual clock forward, flushing timers, promises and React updates as it goes. */
  advance: (ms: number, stepMs?: number) => Promise<void>;
  /** Simulated transport, so a scenario can pause or seek the way a viewer would. */
  playback: {
    play: () => void;
    pause: () => void;
    seek: (position: number) => void;
    readonly position: number;
    readonly bufferedEnd: number;
  };
  destroy: () => void;
};

const DEFAULT_SOURCE_TRACK_NAME = '720p';

/**
 * How finely the clock is stepped by default. hls.js schedules work on short timers and reads
 * `performance.now()` inside those callbacks, so jumping the clock in one leap would run a
 * twenty-second stall as a single tick and skip the states the player reacts to.
 */
const STEP_MS = 100;

// Captured before any test installs fake timers, so it still schedules a real macrotask afterwards.
// Awaiting one is what drains the microtask queue completely; counting `Promise.resolve()` turns
// instead means guessing how long hls.js's internal promise chains are, and guessing low silently
// stalls the pipeline mid-fragment.
const realSetImmediate: typeof setImmediate = setImmediate;

export function flush() {
  return new Promise<void>((resolve) => {
    realSetImmediate(() => resolve());
  });
}

export function createPlaybackHarness(options: HarnessOptions = {}): PlaybackHarness {
  const cdn = createMockCdn(options.cdn);
  const episodes: EpisodeSummary[] = [];
  const hlsErrors: HlsErrorRecord[] = [];
  const steps: RecoveryStep[] = [];

  const reportSpy = jest.spyOn(sentryEpisodeSink, 'report').mockImplementation((summary) => {
    episodes.push(summary);
  });
  const breadcrumbSpy = jest.spyOn(sentryEpisodeSink, 'breadcrumb').mockImplementation((crumb) => {
    steps.push({ ...crumb, at: window.performance.now() });
  });

  // hls.js instantiates `config.loader` per request, and the player builds its `Hls` instance with
  // no loader of its own, so the default config is the seam that reaches it without touching app
  // code. `HLS_DEBUG=1` turns on hls.js's own logging, which is the fastest way to see why a
  // scenario is not progressing.
  const defaultConfig = HLS.DefaultConfig;
  HLS.DefaultConfig = { ...HLS.DefaultConfig, loader: cdn.loader as any, debug: Boolean(process.env.HLS_DEBUG) };

  // The buffer, modelled from what the CDN actually delivered. One contiguous range is enough:
  // VOD segments are requested in playback order, and a request that jumps elsewhere means hls.js
  // has restarted from a new position, which discards what came before.
  let bufferStart = 0;
  let bufferEnd = 0;
  let announcedCanPlay = false;
  let sourceBuffers: StubSourceBuffer[] = [];

  function publishBuffer() {
    sourceBuffers.forEach((sourceBuffer) => sourceBuffer.setBufferedRange(bufferStart, bufferEnd));
  }

  // A new source buffer means hls.js reset the media source, so whatever was buffered is gone.
  const stopWatchingBuffers = onSourceBufferCreated((sourceBuffer) => {
    sourceBuffers = [sourceBuffer];
    bufferStart = 0;
    bufferEnd = 0;
  });

  cdn.observe((request, reply) => {
    if (request.kind !== 'fragment' || 'hang' in reply || reply.status < 200 || reply.status >= 300) {
      return;
    }

    const index = cdn.segmentIndexOf(request.path);
    if (index === -1) {
      return;
    }

    const start = index * cdn.segmentDuration;
    const end = start + cdn.segmentDuration;

    if (bufferEnd === 0 || start > bufferEnd + 0.001 || end < bufferStart) {
      bufferStart = start;
      bufferEnd = end;
    } else {
      bufferStart = Math.min(bufferStart, start);
      bufferEnd = Math.max(bufferEnd, end);
    }

    publishBuffer();
  });

  let playing = Boolean(options.autoPlay);
  let position = 0;

  const container = document.createElement('div');
  document.body.appendChild(container);

  const ref = React.createRef<MediaRef>();
  const sourceTracks: SourceTrack[] = options.sourceTracks ?? [
    { src: cdn.masterUrl, type: 'application/x-mpegURL', name: DEFAULT_SOURCE_TRACK_NAME, default: true },
  ];

  act(() => {
    ReactDOM.render(
      <Media
        ref={ref}
        sourceTracks={sourceTracks}
        audioTracks={options.audioTracks}
        streamingType={options.streamingType ?? 'hls4'}
        autoPlay={options.autoPlay}
      />,
      container,
    );
  });

  const video = ref.current!.videoElement!;

  // jsdom's `buffered` is a permanently empty TimeRanges and its `paused` never changes, so both
  // are replaced with the simulation's view of the same facts.
  Object.defineProperty(video, 'buffered', {
    configurable: true,
    get: () => ({
      length: bufferEnd > bufferStart ? 1 : 0,
      start: () => bufferStart,
      end: () => bufferEnd,
    }),
  });
  Object.defineProperty(video, 'paused', { configurable: true, get: () => !playing });
  // Not cosmetic. hls.js skips its buffer bookkeeping entirely while `readyState` is 0, and jsdom
  // never leaves 0 -- which leaves `loadedmetadata` false, so hls.js measures its forward buffer
  // from the load position instead of the playback position, concludes it has buffered nothing and
  // downloads the whole playlist at once. No stall can be staged against a player that has already
  // fetched the entire film.
  Object.defineProperty(video, 'readyState', {
    configurable: true,
    get: () => (bufferEnd > video.currentTime + 0.001 ? 4 : bufferEnd > bufferStart ? 2 : 0),
  });

  let attachedTo: HLS | null = null;

  function trackErrors() {
    const instance = ref.current?.hls;

    if (!instance || instance === attachedTo) {
      return;
    }

    attachedTo = instance;
    instance.on(HLS.Events.ERROR, (_event, data: any) => {
      hlsErrors.push({
        reason: [data?.type, data?.details].filter(Boolean).join(' / '),
        fatal: Boolean(data?.fatal),
        at: window.performance.now(),
      });
    });
  }

  trackErrors();

  async function advance(ms: number, stepMs = STEP_MS) {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        jest.advanceTimersByTime(stepMs);
        await flush();
      });

      // A new hls.js instance appears whenever the player rebuilds its pipeline, so the error log
      // has to be re-attached rather than wired once at mount.
      trackErrors();

      if (bufferEnd <= bufferStart) {
        // The buffer emptied, which for this simulation means the pipeline was rebuilt; the next
        // fill is a fresh `canplay`.
        announcedCanPlay = false;
      }

      if (!announcedCanPlay && bufferEnd > bufferStart) {
        announcedCanPlay = true;
        // The player waits for `canplay` to restore the position it saved when the pipeline was
        // torn down, so a harness that never fires it would make every manual retry look like a
        // restart from zero -- the exact bug these scenarios exist to detect.
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          video.dispatchEvent(new Event('canplay'));
          await flush();
        });
      }

      // Read the position back rather than trusting the harness's own copy: hls.js nudges
      // `currentTime` over buffer holes and the player restores it after a recovery, and a
      // simulation that overwrote those moves would hide the restart bug it exists to catch.
      position = video.currentTime;

      if (playing) {
        // Playback cannot run past the end of the buffer -- that is precisely what a stall is.
        position = Math.max(position, Math.min(position + stepMs / 1000, bufferEnd));
        video.currentTime = position;
      }
    }
  }

  return {
    cdn,
    get player() {
      return ref.current!;
    },
    get video() {
      return video;
    },
    episodes,
    hlsErrors,
    steps,
    advance,
    reload: () => {
      act(() => {
        ref.current!.reload();
      });
    },
    interact: (action) => {
      act(() => {
        action(ref.current!);
      });
    },
    playback: {
      play: () => {
        playing = true;
      },
      pause: () => {
        playing = false;
      },
      seek: (to: number) => {
        position = to;
        video.currentTime = to;
      },
      get position() {
        return position;
      },
      get bufferedEnd() {
        return bufferEnd;
      },
    },
    destroy: () => {
      act(() => {
        ReactDOM.unmountComponentAtNode(container);
      });
      container.remove();
      stopWatchingBuffers();
      HLS.DefaultConfig = defaultConfig;
      reportSpy.mockRestore();
      breadcrumbSpy.mockRestore();
      resetMediaSourceStub();
    },
  };
}
