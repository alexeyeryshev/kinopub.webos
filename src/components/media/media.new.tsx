import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import cx from 'classnames';
import HLS from 'hls.js';
import forEach from 'lodash/forEach';

import useStorageState from 'hooks/useStorageState';

import { DecodeHealth, DecodeSample, EMPTY_DECODE_HEALTH, evaluateDecodeHealth, pruneSamples, pruneTimestamps } from 'utils/decodeHealth';
import { VideoRange, getStreamVideoRange } from 'utils/hdr';
import { getFailureCategory } from 'utils/hlsFailures';
import { findLevelIndexForQuality } from 'utils/hlsLevels';
import { provesStreamRecovered } from 'utils/hlsRecovery';
import { logPlaybackIssue, resetPlaybackIssueReports, sentryEpisodeSink } from 'utils/logging';
import { createPlaybackEpisodeTracker } from 'utils/playbackEpisode';
import { convertToVTT } from 'utils/subtitles';

export type AudioTrack = {
  name: string;
  number: string;
  lang: string;
  default?: boolean;
};

export type SourceTrack = {
  src: string;
  type: string;
  name: string;
  codec?: string;
  default?: boolean;
};

export type SubtitleTrack = {
  src: string;
  name: string;
  number: string;
  lang: string;
  default?: boolean;
};

export type StreamingType = 'http' | 'hls' | 'hls2' | 'hls4';

/**
 * Sentinel source-track name for HLS.js automatic level selection.
 * Only offered when the currently loaded stream is a genuine master
 * playlist exposing more than one HLS level.
 */
export const AUTO_SOURCE_NAME = 'Авто';

// A fatal hls.js error stops the loading engine for good: nothing reloads on
// its own, and seeking does not restart it, so playback freezes until the
// player is torn down. Recovery has to be driven by the application.
const RECOVERY_MAX_NETWORK_ATTEMPTS = 6;
const RECOVERY_MAX_MEDIA_ATTEMPTS = 2;
const RECOVERY_BASE_DELAY = 1000;
const RECOVERY_MAX_DELAY = 8000;

// Not every stall announces itself as a fatal error. A CDN edge can refuse
// specific segments indefinitely (HTTP 0 on every attempt) while hls.js keeps
// retrying the same URLs non-fatally, so nothing above ever escalates and
// playback sits frozen at the end of the buffer. Retrying the same request is
// useless there; the playlist has to be fetched again to get fresh segment
// URLs, which is usually a different edge.
const STALL_CHECK_INTERVAL = 2000;
const STALL_MIN_BUFFER_AHEAD = 0.5;
const STALL_RESTART_AFTER = 8000;
const STALL_RELOAD_AFTER = 20000;
const STALL_MAX_RELOADS = 3;
// Each stall cycle spends one restart and one reload, so this is the cap the
// overlay renders progress against.
const STALL_MAX_ACTIONS = STALL_MAX_RELOADS * 2;

// How often the video element's playback-quality counters are read. The decode window is 30s, so
// this keeps ~15 points in it -- enough to survive pruning without sampling being noticeable.
const DECODE_SAMPLE_INTERVAL = 2000;

/** Hostname of whatever request an hls.js error refers to. Never the full URL: they carry tokens. */
function hostnameOfFragment(data: any) {
  const url = data?.frag?.url || data?.context?.url || data?.url;

  if (typeof url !== 'string') {
    return undefined;
  }

  try {
    return new URL(url, window.location.href).hostname;
  } catch (e) {
    return url.match(/^(?:[a-z]+:)?\/\/([^/?#]+)/i)?.[1];
  }
}

export type RecoveryState = {
  attempts: number;
  // The cap that applies to `attempts`, which differs between network and
  // media recovery, so the overlay can render the budget without guessing.
  limit: number;
  exhausted: boolean;
  lastReason?: string;
  lastAt?: number;
};

/**
 * Playback is over and the player is not going to fix it.
 *
 * Deliberately narrow: this is the terminal state, not a report on every retry. While either
 * recovery path still has budget there is a real chance of resuming, and saying so would be
 * premature -- so this stays undefined until nothing is left to try.
 */
export type PlaybackFailure = {
  /** `recovery-exhausted` for HLS, `media-error` for a source the element itself rejected. */
  kind: 'recovery-exhausted' | 'media-error';
  /** hls.js `type / details`, or a media-element error code. Never a URL. */
  reason?: string;
  /** When this failure was first observed, so the UI can render without flickering. */
  since: number;
};

type OwnProps = {
  autoPlay?: boolean;
  audioTracks?: AudioTrack[];
  sourceTracks?: SourceTrack[];
  subtitleTracks?: SubtitleTrack[];
  streamingType?: StreamingType;
  isSettingsOpen?: boolean;
  mediaComponent?: string;
  onUpdate?: () => void;
  onAudioChange?: (audioTrack: AudioTrack) => void;
  onSourceChange?: (sourceTrack: SourceTrack) => void;
  onSubtitleChange?: (subtitleTrack: SubtitleTrack | null) => void;
};

export type MediaRef = {
  play: () => Promise<void>;
  pause: () => void;
  playPause: () => Promise<void>;
  load: () => void;
  /** Tears the media pipeline down and builds it again from the current position. */
  reload: () => void;
  readonly videoElement: HTMLVideoElement | null;
  readonly hls: HLS | null;
  readonly recovery: RecoveryState;
  readonly audioTrackIndex: number;
  /** `VIDEO-RANGE` of the stream, when the manifest declares one. `undefined` means it did not. */
  readonly videoRange: VideoRange | undefined;
  readonly failure: PlaybackFailure | undefined;
  readonly decodeHealth: DecodeHealth;
  currentTime: number;
  playbackRate: number;
  audioTracks?: AudioTrack[];
  audioTrack?: string;
  sourceTracks?: SourceTrack[];
  sourceTrack?: string;
  subtitleTracks?: SubtitleTrack[];
  subtitleTrack?: string;
  readonly duration: number;
  readonly error: boolean;
  readonly loading: boolean;
  readonly paused: boolean;
  readonly proportionLoaded: number;
  readonly proportionPlayed: number;
};

function useVideoPlayer({
  autoPlay,
  audioTracks,
  sourceTracks,
  subtitleTracks,
  streamingType,
  isSettingsOpen,
  onAudioChange,
  onSourceChange,
  onSubtitleChange,
}: OwnProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HLS | null>(null);
  const startTimeRef = useRef(0);
  const isSettingsOpenRef = useRef(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isHLSJSActive] = useStorageState<boolean>('is_hls.js_active');
  // Whether the currently loaded HLS manifest is a genuine master playlist
  // with multiple levels, i.e. capable of real ABR/Auto selection.
  const [isAdaptiveLevel, setIsAdaptiveLevel] = useState(false);
  const [qualityMode, setQualityMode] = useState<'auto' | 'fixed'>('fixed');
  // Mirrors qualityMode synchronously so a pending Auto request survives a
  // replacement manifest that is still loading (see setSourceTrack below).
  const qualityModeRef = useRef(qualityMode);
  // Fatal-error recovery and the stall watchdog keep separate budgets. They
  // recover from different failures and clear on different evidence -- a fatal
  // retry is only proven good once the failing stream buffers, while the
  // watchdog only needs playback to move again -- so sharing one record let
  // each reset and inflate the other's attempt count.
  const fatalRecoveryRef = useRef<RecoveryState>({ attempts: 0, limit: RECOVERY_MAX_NETWORK_ATTEMPTS, exhausted: false });
  const stallRecoveryRef = useRef<RecoveryState>({ attempts: 0, limit: STALL_MAX_ACTIONS, exhausted: false });
  // True only while a fatal-error retry is scheduled, so the watchdog can stand
  // aside without reading state it writes itself.
  const fatalRetryPendingRef = useRef(false);
  const currentAudioTrackIndexRef = useRef(0);
  // Decode health is sampled continuously, not only while the diagnostics overlay is open, because
  // the indicator it drives is the whole point: a viewer should not have to open diagnostics to
  // learn the decoder is struggling.
  const decodeSamplesRef = useRef<DecodeSample[]>([]);
  const decodeErrorTimesRef = useRef<number[]>([]);
  const decodeHealthRef = useRef<DecodeHealth>(EMPTY_DECODE_HEALTH);
  // Threads every recovery step of one failure into a single Sentry report, so the question the
  // on-screen diagnostics could not answer -- did the recovery actually work? -- is answered
  // without anyone having to be watching at the right moment.
  const episodeRef = useRef(createPlaybackEpisodeTracker(sentryEpisodeSink));

  // Bumped to rebuild the media pipeline in place. A fatal hls.js error leaves the loading engine
  // stopped for good, so a retry has to construct a new instance rather than restart the dead one.
  const [reloadNonce, setReloadNonce] = useState(0);
  const failureRef = useRef<PlaybackFailure | undefined>();
  // Whether the current source is being played through hls.js, which decides how a failure is
  // recognised. Not `hlsRef.current !== null`: that goes briefly null while an instance is being
  // replaced, and `destroy()` detaching the media element can leave a transient `video.error`
  // behind -- long enough for a poll to land on it and announce a failure that is not happening.
  const usesHlsRef = useRef(false);

  const getDecodeHealth = useCallback(() => decodeHealthRef.current, []);

  /**
   * The terminal state, or undefined while there is still something to try.
   *
   * "Every recovery path is spent" has to mean every path that *applies*, not every path that
   * exists. The two are not the same, and requiring both budgets would have excluded the failure
   * this player was built for: a CDN edge refusing specific segments produces only non-fatal errors,
   * so hls.js never escalates, the fatal budget is never touched, and the stall watchdog is the only
   * thing recovering. Demanding a spent fatal budget there would leave the viewer on the same silent
   * frozen frame the notice exists to replace.
   *
   * So the watchdog must be spent -- it engages on any stall, whatever caused it -- and the fatal
   * budget only has to be spent if a fatal error ever engaged it. A fatal retry still in flight
   * means there is a real chance of resuming, and saying playback has failed over the top of that
   * would be worse than saying nothing.
   *
   * For a source played without hls.js there is no budget at all, and the element's own error is the
   * whole story.
   */
  const getFailure = useCallback(() => {
    const pending = (() => {
      if (usesHlsRef.current) {
        const fatal = fatalRecoveryRef.current;
        const stall = stallRecoveryRef.current;
        const fatalEngaged = fatal.attempts > 0 || fatal.exhausted;

        return stall.exhausted && (!fatalEngaged || fatal.exhausted)
          ? // Prefer the fatal reason when there is one: `networkError / fragLoadError` says what
            // broke, while the watchdog's `stall / reload` only says how we noticed.
            { kind: 'recovery-exhausted' as const, reason: fatal.lastReason || stall.lastReason }
          : undefined;
      }

      const error = videoRef.current?.error;

      return error ? { kind: 'media-error' as const, reason: `code ${error.code}` } : undefined;
    })();

    if (!pending) {
      failureRef.current = undefined;

      return undefined;
    }

    // Keep `since` stable while the same failure persists, so the notice does not remount under a
    // viewer who is reaching for the retry button.
    if (failureRef.current?.kind !== pending.kind || failureRef.current?.reason !== pending.reason) {
      failureRef.current = { ...pending, since: Date.now() };
    }

    return failureRef.current;
  }, []);

  const reload = useCallback(() => {
    // Closed here rather than left to the effect below, so the report says the viewer asked for
    // this instead of blaming a source change that did not happen.
    episodeRef.current.reset(Date.now(), 'manual-retry');
    failureRef.current = undefined;
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  // The overlay shows one line, so surface whichever path acted most recently.
  const getRecovery = useCallback(() => {
    const fatal = fatalRecoveryRef.current;
    const stall = stallRecoveryRef.current;
    const fatalActive = fatal.attempts > 0 || fatal.exhausted;
    const stallActive = stall.attempts > 0 || stall.exhausted;

    if (fatalActive && stallActive) {
      return (fatal.lastAt || 0) >= (stall.lastAt || 0) ? fatal : stall;
    }

    return stallActive ? stall : fatal;
  }, []);
  const [currentAudioTrack, setCurrentAudioTrack] = useState<AudioTrack>(
    () => (audioTracks?.find((audioTrack) => audioTrack.default) || audioTracks?.[0])!,
  );
  const [currentSourceTrack, setCurrentSourceTrack] = useState<SourceTrack>(
    () => (sourceTracks?.find((sourceTrack) => sourceTrack.default) || sourceTracks?.[0])!,
  );
  const currentSourceTrackRef = useRef(currentSourceTrack);
  currentSourceTrackRef.current = currentSourceTrack;
  // Read inside long-lived effects for issue reports. A ref rather than a dependency, so reporting
  // context can never cause the HLS instance to be torn down and rebuilt.
  const streamingTypeRef = useRef(streamingType);
  streamingTypeRef.current = streamingType;
  const [currentSubtitleTrack, setCurrentSubtitleTrack] = useState<SubtitleTrack | null>(
    () => subtitleTracks?.find((subtitleTrack) => subtitleTrack.default) || null,
  );

  const getAudioTracks = useCallback(() => (streamingType === 'hls2' ? [] : audioTracks), [audioTracks, streamingType]);
  const getAudioTrack = useCallback(() => currentAudioTrack?.name, [currentAudioTrack]);
  // The position the player believes is selected. Exposed so diagnostics can hold it next to what
  // hls.js is actually playing: the two drifting apart is a real defect and is otherwise invisible.
  const getAudioTrackIndex = useCallback(() => currentAudioTrackIndexRef.current, []);
  // Read live rather than cached: levels arrive a moment after playback starts, and in Auto mode
  // `currentLevel` stays -1 until hls.js has chosen one.
  const getVideoRange = useCallback(() => getStreamVideoRange(hlsRef.current?.levels as any[], hlsRef.current?.currentLevel), []);
  const setAudioTrack = useCallback(
    (audioTrackName: string) => {
      const audioTrackIndex = audioTracks?.findIndex((audioTrack) => audioTrack.name === audioTrackName) ?? -1;
      if (audioTrackIndex !== -1) {
        const audioTrack = audioTracks![audioTrackIndex];
        setCurrentAudioTrack(audioTrack);
        onAudioChange?.(audioTrack);
      }
    },
    [audioTracks, onAudioChange],
  );
  const getSourceTracks = useCallback(() => {
    if (!sourceTracks || !isAdaptiveLevel || !currentSourceTrack) {
      return sourceTracks;
    }

    // Only a genuine master playlist with multiple HLS levels gets an
    // explicit Auto option, delegating level selection to HLS.js.
    return [{ ...currentSourceTrack, name: AUTO_SOURCE_NAME, default: false }, ...sourceTracks];
  }, [sourceTracks, isAdaptiveLevel, currentSourceTrack]);
  const getSourceTrack = useCallback(
    () => (qualityMode === 'auto' && isAdaptiveLevel ? AUTO_SOURCE_NAME : currentSourceTrack?.name),
    [qualityMode, isAdaptiveLevel, currentSourceTrack],
  );
  const setSourceTrack = useCallback(
    (sourceTrackName: string) => {
      // Delegate level selection to HLS.js instead of pinning a fixed level.
      // If a replacement manifest is still loading (hls.levels not known
      // yet), the request is kept in qualityModeRef and honored by the
      // MANIFEST_PARSED handler below once the new levels are known.
      if (sourceTrackName === AUTO_SOURCE_NAME) {
        qualityModeRef.current = 'auto';
        setQualityMode('auto');

        if (hlsRef.current && hlsRef.current.levels.length > 1) {
          hlsRef.current.nextLevel = -1;
        }

        return;
      }

      const sourceTrackIndex = sourceTracks?.findIndex((sourceTrack) => sourceTrack.name === sourceTrackName) ?? -1;
      if (sourceTrackIndex !== -1) {
        const sourceTrack = sourceTracks![sourceTrackIndex];
        qualityModeRef.current = 'fixed';
        setQualityMode('fixed');
        setCurrentSourceTrack(sourceTrack);
        onSourceChange?.(sourceTrack);

        // For adaptive HLS (e.g. hls4): switch quality via HLS.js level
        // in place when the new track resolves to the same master playlist.
        // `nextLevel` rather than `currentLevel`: the latter flushes the whole
        // buffer to apply the switch instantly, which on a flaky CDN trades
        // minutes of already-downloaded video for a stall it may not recover
        // from. `nextLevel` keeps the fragment being played and switches from
        // the next one.
        if (hlsRef.current && hlsRef.current.levels.length > 1) {
          const levelIndex = findLevelIndexForQuality(hlsRef.current.levels, sourceTrack.name);
          if (levelIndex !== -1) {
            hlsRef.current.nextLevel = levelIndex;
          }
        }
      }
    },
    [sourceTracks, onSourceChange],
  );
  const getSubtitleTracks = useCallback(() => subtitleTracks, [subtitleTracks]);
  const getSubtitleTrack = useCallback(() => currentSubtitleTrack?.name, [currentSubtitleTrack]);
  const setSubtitleTrack = useCallback(
    (subtitleTrackName?: string) => {
      const subtitleTrackIndex = subtitleTracks?.findIndex((subtitleTrack) => subtitleTrack.name === subtitleTrackName) ?? -1;

      const subtitleTrack = (subtitleTrackIndex !== -1 && subtitleTracks![subtitleTrackIndex]) || null;
      setCurrentSubtitleTrack(subtitleTrack);
      onSubtitleChange?.(subtitleTrack);
    },
    [subtitleTracks, onSubtitleChange],
  );

  const currentAudioTrackIndex = useMemo(
    () => audioTracks?.findIndex((audioTrack) => audioTrack.name === currentAudioTrack.name) ?? 0,
    [audioTracks, currentAudioTrack],
  );
  currentAudioTrackIndexRef.current = currentAudioTrackIndex;
  const currentSrc = useMemo(
    () =>
      streamingType === 'hls'
        ? currentSourceTrack?.src.replace(/master-v1a\d/, `master-v1a${currentAudioTrackIndex + 1}`)
        : currentSourceTrack?.src,
    [streamingType, currentAudioTrackIndex, currentSourceTrack?.src],
  );

  const handleMediaLoaded = useCallback(() => {
    if (videoRef.current) {
      setIsLoaded(true);
      videoRef.current.removeEventListener('canplay', handleMediaLoaded);

      if (startTimeRef.current > 0) {
        videoRef.current.currentTime = startTimeRef.current;

        if (isSettingsOpenRef.current) {
          videoRef.current.pause();
        } else {
          videoRef.current.play();
        }
      } else if (autoPlay && !isSettingsOpenRef.current) {
        videoRef.current.play();
      }
    }
  }, [autoPlay]);

  useEffect(() => {
    let recoveryTimeoutId: NodeJS.Timeout | undefined;
    let mediaRecoveryAttempts = 0;
    // Guards the audio-track re-selection below to one attempt per healthy stretch of playback.
    let audioTrackReselected = false;
    let recoveringStream: string | undefined;

    if (videoRef.current && currentSrc) {
      // A freshly loaded source always starts pinned to the requested
      // fixed quality, matching the previous manual-selection behavior,
      // unless a pending Auto request (see setSourceTrack) arrives before
      // the new manifest finishes parsing.
      setIsAdaptiveLevel(false);
      qualityModeRef.current = 'fixed';
      setQualityMode('fixed');
      fatalRecoveryRef.current = { attempts: 0, limit: RECOVERY_MAX_NETWORK_ATTEMPTS, exhausted: false };
      stallRecoveryRef.current = { attempts: 0, limit: STALL_MAX_ACTIONS, exhausted: false };
      fatalRetryPendingRef.current = false;
      decodeSamplesRef.current = [];
      decodeErrorTimesRef.current = [];
      decodeHealthRef.current = EMPTY_DECODE_HEALTH;
      failureRef.current = undefined;
      // A new source is a new playback session, so each issue is worth reporting once more.
      resetPlaybackIssueReports();
      episodeRef.current.reset(Date.now());

      usesHlsRef.current = isHLSJSActive !== false && currentSrc.includes('.m3u8') && HLS.isSupported();

      if (usesHlsRef.current) {
        const hls = (hlsRef.current = new HLS({
          enableWebVTT: false,
          enableCEA708Captions: false,
        }));
        hls.attachMedia(videoRef.current);
        hls.on(HLS.Events.MEDIA_ATTACHED, () => {
          hls.loadSource(currentSrc);
        });

        // A media fragment buffered on the failing stream means it is healthy
        // again, so the next unrelated failure starts from a full budget
        // instead of inheriting the attempts an already-survived outage used
        // up. See `provesStreamRecovered` for what does and does not count.
        hls.on(HLS.Events.FRAG_BUFFERED, (_event, data: any) => {
          if (!provesStreamRecovered(data?.frag, recoveringStream)) {
            return;
          }

          // The same evidence that refills the retry budget closes the episode. Position moving is
          // not enough: after a fatal error hls.js's engine is stopped, so playback advancing is
          // the buffer draining, and crediting that to whichever retry happened to be in flight
          // would make `recoveredAfter` -- the one field worth grouping on -- lie.
          episodeRef.current.noteProgress(Date.now());

          recoveringStream = undefined;
          mediaRecoveryAttempts = 0;
          audioTrackReselected = false;

          if (fatalRecoveryRef.current.attempts > 0 || fatalRecoveryRef.current.exhausted) {
            fatalRecoveryRef.current = { ...fatalRecoveryRef.current, attempts: 0, exhausted: false };
          }
        });

        hls.on(HLS.Events.ERROR, (_event, data: any) => {
          // Decode failures count towards the health indicator whether or not they are fatal.
          // Non-fatal ones matter most: hls.js absorbs them silently, so without this nothing
          // surfaces a decoder that is quietly rejecting data.
          const category = getFailureCategory(data);

          if (category === 'media') {
            decodeErrorTimesRef.current = pruneTimestamps([...decodeErrorTimesRef.current, Date.now()], Date.now());
          }

          episodeRef.current.setContext({
            quality: currentSourceTrackRef.current?.name,
            streamingType: streamingTypeRef.current,
            levelCount: hls.levels?.length,
            currentLevel: hls.currentLevel,
            bandwidthEstimate: (hls as any).bandwidthEstimate,
          });
          episodeRef.current.noteError(
            category,
            Date.now(),
            Boolean(data?.fatal),
            [data?.type, data?.details].filter(Boolean).join(' / '),
            hostnameOfFragment(data),
          );

          // hls.js retries non-fatal errors internally; only fatal ones stop
          // the loading engine and need the application to restart it.
          if (!data?.fatal) {
            return;
          }

          const reason = [data.type, data.details].filter(Boolean).join(' / ');
          // Remembered so only this stream's own recovery clears the budget.
          recoveringStream = data?.frag?.type || undefined;

          if (data.type === HLS.ErrorTypes.NETWORK_ERROR) {
            const attempts = fatalRecoveryRef.current.attempts + 1;

            if (attempts > RECOVERY_MAX_NETWORK_ATTEMPTS) {
              fatalRecoveryRef.current = {
                attempts: attempts - 1,
                limit: RECOVERY_MAX_NETWORK_ATTEMPTS,
                exhausted: true,
                lastReason: reason,
                lastAt: Date.now(),
              };
              episodeRef.current.noteExhausted('fatal-network', Date.now(), reason);
              return;
            }

            fatalRecoveryRef.current = {
              attempts,
              limit: RECOVERY_MAX_NETWORK_ATTEMPTS,
              exhausted: false,
              lastReason: reason,
              lastAt: Date.now(),
            };

            // Back off so a CDN that is refusing every request is not hammered.
            const delay = Math.min(RECOVERY_BASE_DELAY * 2 ** (attempts - 1), RECOVERY_MAX_DELAY);

            episodeRef.current.noteAction('fatal-retry', Date.now(), { attempt: attempts, limit: RECOVERY_MAX_NETWORK_ATTEMPTS, delay });
            fatalRetryPendingRef.current = true;
            recoveryTimeoutId = setTimeout(() => {
              fatalRetryPendingRef.current = false;
              if (hlsRef.current === hls) {
                hls.startLoad();
              }
            }, delay);

            return;
          }

          if (data.type === HLS.ErrorTypes.MEDIA_ERROR) {
            // `audioTrackLoadError` arrives typed as a *media* error but is not a decode failure at
            // all. hls.js raises this one from `selectInitialTrack()` when an audio group has just
            // been rebuilt and no track in it matches the name that was selected — see
            // `audio-track-controller` in the pinned build, which triggers
            // `{ type: MEDIA_ERROR, details: AUDIO_TRACK_LOAD_ERROR, fatal: true }` with the log
            // line "No track found for running audio group-ID". Rebuilding the media element for
            // that is a sledgehammer, and a Sentry episode from the TV shows what it costs: 54 ms
            // after the stall watchdog's `hls.loadSource()` this fired, and the `recoverMediaError()`
            // it triggered restarted a fifty-minute film from the beginning with the wrong audio.
            //
            // Re-selecting the track is the proportionate response. Once only: if it recurs the
            // selection was not the problem and the original path still runs.
            if (data.details === HLS.ErrorDetails.AUDIO_TRACK_LOAD_ERROR && !audioTrackReselected && hls.audioTracks?.length) {
              audioTrackReselected = true;

              const reselected = hls.audioTracks[currentAudioTrackIndexRef.current] || hls.audioTracks[0];
              const position = videoRef.current?.currentTime;

              episodeRef.current.noteAction('audio-track-reselect', Date.now(), {
                index: currentAudioTrackIndexRef.current,
                count: hls.audioTracks.length,
              });
              fatalRecoveryRef.current = { ...fatalRecoveryRef.current, lastReason: reason, lastAt: Date.now() };

              hls.audioTrack = reselected.id;

              // The fatal error stopped the loading engine, so it needs restarting either way.
              if (position && position > 0) {
                hls.startLoad(position);
              } else {
                hls.startLoad();
              }

              return;
            }

            mediaRecoveryAttempts += 1;

            if (mediaRecoveryAttempts > RECOVERY_MAX_MEDIA_ATTEMPTS) {
              fatalRecoveryRef.current = {
                attempts: RECOVERY_MAX_MEDIA_ATTEMPTS,
                limit: RECOVERY_MAX_MEDIA_ATTEMPTS,
                exhausted: true,
                lastReason: reason,
                lastAt: Date.now(),
              };
              episodeRef.current.noteExhausted('fatal-media', Date.now(), reason);
              return;
            }

            // Mirrored into the exposed state so the overlay reports decoder
            // recovery too, rather than sitting at `idle` through it.
            fatalRecoveryRef.current = {
              attempts: mediaRecoveryAttempts,
              limit: RECOVERY_MAX_MEDIA_ATTEMPTS,
              exhausted: false,
              lastReason: reason,
              lastAt: Date.now(),
            };

            // A second media error in a row usually means the audio codec is
            // the one the decoder is choking on.
            episodeRef.current.noteAction('media-recover', Date.now(), {
              attempt: mediaRecoveryAttempts,
              limit: RECOVERY_MAX_MEDIA_ATTEMPTS,
              swapAudioCodec: mediaRecoveryAttempts > 1,
            });

            // `recoverMediaError()` is more destructive than its name suggests. It detaches and
            // re-attaches the media element, and on the way out hls.js's buffer controller does
            // `media.removeAttribute('src'); media.load()`. That resets `currentTime` to zero and
            // drops every buffered range; on re-attach the stream controller starts from
            // `config.startPosition`, which for this configuration is the beginning of the
            // playlist. Recovering from one decoder hiccup therefore threw the viewer back to the
            // start of the film -- reported from a TV, with a capture showing playback at 6.9 s
            // while the loader was still working on segment 14 near the two-minute mark.
            //
            // The audio selection does not survive the round trip either. Nothing reloads the
            // manifest, so the `MANIFEST_PARSED` handler that normally restores it never runs, and
            // the effect keyed on `isLoaded` cannot re-fire because `isLoaded` never goes back to
            // false. Playback resumed in a different language from the one the settings menu still
            // displayed, and only changing the track by hand put it right.
            //
            // Registered before the call, because the re-attach happens synchronously inside it.
            const resumeAt = videoRef.current?.currentTime;

            hls.once(HLS.Events.MEDIA_ATTACHED, () => {
              const recoveredAudioTrack = hls.audioTracks?.[currentAudioTrackIndexRef.current];

              if (recoveredAudioTrack) {
                hls.audioTrack = recoveredAudioTrack.id;
              }

              // The stream controller has already called `startLoad(config.startPosition)` by the
              // time this runs, so this overrides where it resumes from.
              if (resumeAt !== undefined && resumeAt > 0) {
                hls.startLoad(resumeAt);
              }
            });

            if (mediaRecoveryAttempts > 1) {
              hls.swapAudioCodec();
            }
            hls.recoverMediaError();

            return;
          }

          // Key-system, mux and other fatal errors have no documented in-place
          // recovery path, so record them instead of retrying blindly.
          fatalRecoveryRef.current = { ...fatalRecoveryRef.current, exhausted: true, lastReason: reason, lastAt: Date.now() };
          episodeRef.current.noteExhausted('fatal-unrecoverable', Date.now(), reason);
        });
        hls.on(HLS.Events.MANIFEST_PARSED, () => {
          const isAdaptive = hls.levels.length > 1;
          setIsAdaptiveLevel(isAdaptive);

          // The watchdog's full reload rebuilds the manifest's audio-track
          // state, and the effect that applies the user's choice is keyed by
          // values that do not change here, so restore it alongside quality --
          // otherwise recovery silently reverts to the default audio track.
          const hlsAudioTrack = hls.audioTracks?.[currentAudioTrackIndexRef.current];
          if (hlsAudioTrack) {
            hls.audioTrack = hlsAudioTrack.id;
          }

          if (isAdaptive && qualityModeRef.current === 'auto') {
            hls.currentLevel = -1;
            return;
          }

          if (qualityModeRef.current === 'auto') {
            // Auto was requested but this manifest can't adapt; fall back.
            qualityModeRef.current = 'fixed';
            setQualityMode('fixed');
          }

          if (isAdaptive) {
            const levelIndex = findLevelIndexForQuality(hls.levels, currentSourceTrackRef.current?.name || '');
            if (levelIndex !== -1) {
              hls.currentLevel = levelIndex;
            }
          }
        });
      } else {
        videoRef.current.src = currentSrc;
      }

      setIsLoaded(false);
      videoRef.current.addEventListener('canplay', handleMediaLoaded);
    }

    return () => {
      // Cleared before destroy() so a pending retry can never call startLoad()
      // on a torn-down instance.
      if (recoveryTimeoutId) {
        clearTimeout(recoveryTimeoutId);
      }
      fatalRetryPendingRef.current = false;
      if (videoRef.current) {
        if (videoRef.current.currentTime > 0) {
          // eslint-disable-next-line
          startTimeRef.current = videoRef.current.currentTime;
        }
        // eslint-disable-next-line
        videoRef.current.removeEventListener('canplay', handleMediaLoaded);
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [currentSrc, isHLSJSActive, handleMediaLoaded, reloadNonce]);

  /**
   * Reports a recovery episode that was still in flight when the player went away.
   *
   * Separate from the effect above on purpose: that one's cleanup also runs on every source change,
   * where the episode is closed by `reset()` in its body and the ending is a source change rather
   * than a departure. An empty dependency list is the only way to learn that this is really an
   * unmount -- the viewer pressed Back, or `views/video` remounted the player for another episode.
   * Without it the most common ending of a failed playback was never reported at all.
   */
  useEffect(() => {
    const episode = episodeRef.current;

    return () => {
      episode.reset(Date.now(), 'teardown');
    };
  }, []);

  // Stall watchdog. Covers the failures that never surface as a fatal error:
  // playback sits at the end of the buffer while hls.js retries segments that
  // the assigned CDN edge will never serve. Escalates from a cheap reload of
  // the loading state to a full playlist refetch, which is what actually
  // produces new segment URLs.
  useEffect(() => {
    if (!currentSrc) {
      return;
    }

    let stalledSince: number | undefined;
    let restarted = false;
    let reloads = 0;
    // Every recovery action taken for the current stall, restarts included, so
    // the overlay never reads `idle` while the watchdog is working.
    let actions = 0;
    let lastPosition = -1;

    const getBufferAhead = (video: HTMLVideoElement) => {
      for (let index = 0; index < video.buffered.length; index += 1) {
        try {
          if (video.buffered.start(index) <= video.currentTime && video.currentTime <= video.buffered.end(index)) {
            return video.buffered.end(index) - video.currentTime;
          }
        } catch (e) {
          return 0;
        }
      }

      return 0;
    };

    const intervalId = setInterval(() => {
      const video = videoRef.current;
      const hls = hlsRef.current;

      if (!video || !hls) {
        return;
      }

      // Lets an armed abandonment fire without needing another failure to arrive.
      episodeRef.current.tick(Date.now());

      // While a fatal-error retry is scheduled, that path owns recovery. Keep tracking the
      // position through it anyway: the buffer drains during the backoff, and comparing against a
      // pre-retry position afterwards would read as movement that never happened.
      if (fatalRetryPendingRef.current) {
        lastPosition = video.currentTime;
        return;
      }

      const position = video.currentTime;
      const advancing = lastPosition >= 0 && position !== lastPosition;
      lastPosition = position;

      if (video.paused || video.ended || advancing || getBufferAhead(video) > STALL_MIN_BUFFER_AHEAD) {
        stalledSince = undefined;
        restarted = false;

        // Playback moving again is what this budget is spent against, so the
        // reload allowance is restored too -- a later, unrelated stall gets a
        // full budget rather than inheriting an already-survived one.
        actions = 0;
        reloads = 0;

        if (stallRecoveryRef.current.exhausted || stallRecoveryRef.current.attempts > 0) {
          stallRecoveryRef.current = { attempts: 0, limit: STALL_MAX_ACTIONS, exhausted: false };
        }

        return;
      }

      const now = Date.now();

      if (!stalledSince) {
        stalledSince = now;
        return;
      }

      const stalledFor = now - stalledSince;

      // First, just ask hls.js to re-plan from where playback actually is.
      if (!restarted && stalledFor >= STALL_RESTART_AFTER) {
        restarted = true;
        actions += 1;
        stallRecoveryRef.current = {
          attempts: actions,
          limit: STALL_MAX_ACTIONS,
          exhausted: false,
          lastReason: 'stall / restart',
          lastAt: now,
        };
        episodeRef.current.noteAction('watchdog-restart', now, { stalledForMs: stalledFor, position: Math.round(position) });
        hls.startLoad(position);
        return;
      }

      if (!restarted || stalledFor < STALL_RELOAD_AFTER) {
        return;
      }

      if (reloads >= STALL_MAX_RELOADS) {
        episodeRef.current.noteExhausted('stall-watchdog', Date.now(), 'stall / reload budget spent');
        stallRecoveryRef.current = {
          attempts: actions,
          limit: STALL_MAX_ACTIONS,
          exhausted: true,
          lastReason: 'stall / reload',
          lastAt: now,
        };
        return;
      }

      // Refetch the playlist so the segment URLs -- and usually the edge
      // serving them -- are replaced, then resume from the same position.
      reloads += 1;
      actions += 1;
      stalledSince = now;
      restarted = false;
      episodeRef.current.noteAction('watchdog-reload', now, { reload: reloads, limit: STALL_MAX_RELOADS, position: Math.round(position) });
      stallRecoveryRef.current = {
        attempts: actions,
        limit: STALL_MAX_ACTIONS,
        exhausted: false,
        lastReason: 'stall / reload',
        lastAt: now,
      };
      hls.loadSource(currentSrc);
      hls.startLoad(position);
    }, STALL_CHECK_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
    // `reloadNonce` matters as much as `currentSrc` here. All of this watchdog's state -- how long
    // the stall has run, how many reloads are left -- lives in closure variables, so a rebuilt
    // pipeline that kept the old closure would inherit a spent reload budget and a `stalledSince`
    // from minutes ago. The first tick after a manual retry would then see a huge stall against an
    // exhausted budget and declare the fresh attempt dead within seconds, before it had finished
    // loading its manifest. Re-running the effect is what gives the retry a clean watchdog.
  }, [currentSrc, reloadNonce]);

  // Decode-health sampling. Reads the element's cumulative playback-quality counters on a timer;
  // `evaluateDecodeHealth` turns consecutive readings into a sliding-window dropped-frame ratio.
  useEffect(() => {
    if (!currentSrc) {
      return;
    }

    const intervalId = setInterval(() => {
      const video = videoRef.current;

      if (!video) {
        return;
      }

      const getQuality = (
        video as HTMLVideoElement & {
          getVideoPlaybackQuality?: () => { totalVideoFrames?: number; droppedVideoFrames?: number };
        }
      ).getVideoPlaybackQuality;
      const now = Date.now();

      // Older webOS firmware may not implement it; the error count alone still drives the
      // indicator there.
      if (getQuality) {
        const quality = getQuality.call(video);
        const totalVideoFrames = quality?.totalVideoFrames;
        const droppedVideoFrames = quality?.droppedVideoFrames;

        if (typeof totalVideoFrames === 'number' && typeof droppedVideoFrames === 'number') {
          // Paused playback renders nothing, so sampling through it would stretch the window over
          // a gap where the ratio means nothing.
          if (!video.paused) {
            decodeSamplesRef.current = pruneSamples([...decodeSamplesRef.current, { at: now, totalVideoFrames, droppedVideoFrames }], now);
          }
        }
      }

      decodeErrorTimesRef.current = pruneTimestamps(decodeErrorTimesRef.current, now);
      decodeHealthRef.current = evaluateDecodeHealth(decodeSamplesRef.current, decodeErrorTimesRef.current, now);

      if (decodeHealthRef.current.severity === 'severe') {
        logPlaybackIssue('decode-health-severe', {
          droppedRatio: Number(decodeHealthRef.current.droppedRatio.toFixed(4)),
          decodeErrors: decodeHealthRef.current.decodeErrors,
          quality: currentSourceTrackRef.current?.name,
          streamingType: streamingTypeRef.current,
          levelCount: hlsRef.current?.levels?.length,
          currentLevel: hlsRef.current?.currentLevel,
        });
      }
    }, DECODE_SAMPLE_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, [currentSrc]);

  useEffect(() => {
    if (isLoaded) {
      if (hlsRef.current) {
        const hlsAudioTrack = hlsRef.current.audioTracks?.[currentAudioTrackIndex];

        if (hlsAudioTrack) {
          hlsRef.current.audioTrack = hlsAudioTrack.id;
        }
      } else if (videoRef.current) {
        // Do not change audio if we don't have it (mostly on HLS)
        // @ts-expect-error
        if (videoRef.current.audioTracks?.[currentAudioTrackIndex]) {
          // @ts-expect-error
          forEach(videoRef.current.audioTracks, (audioTrack, idx: number) => {
            audioTrack.enabled = idx === currentAudioTrackIndex;
          });

          videoRef.current.currentTime -= 1;
        }
      }
    }
  }, [isLoaded, currentAudioTrackIndex]);

  useEffect(() => {
    if (isLoaded) {
      if (videoRef.current) {
        // clear existing subtitles
        while (videoRef.current.firstChild) {
          // @ts-expect-error
          videoRef.current.lastChild.track.mode = 'disabled';
          videoRef.current.removeChild(videoRef.current.lastChild!);
        }

        if (currentSubtitleTrack) {
          const addSubtitleTrack = (src: string) => {
            if (videoRef.current) {
              const track = document.createElement('track');
              videoRef.current.appendChild(track);

              track.src = src;
              track.kind = 'captions';
              track.id = currentSubtitleTrack.name;
              track.label = currentSubtitleTrack.name;
              track.srclang = currentSubtitleTrack.lang;

              track.track.mode = 'showing';
            }
          };

          if (currentSubtitleTrack.src.endsWith('.srt')) {
            convertToVTT(currentSubtitleTrack.src).then(addSubtitleTrack);
          } else {
            addSubtitleTrack(currentSubtitleTrack.src);
          }
        }
      }
    }
  }, [isLoaded, currentSubtitleTrack]);

  useEffect(() => {
    isSettingsOpenRef.current = Boolean(isSettingsOpen);
  }, [isSettingsOpen]);

  return useMemo(
    () => ({
      videoRef,
      hlsRef,
      getRecovery,
      getFailure,
      reload,
      getDecodeHealth,
      getAudioTracks,
      getAudioTrack,
      getAudioTrackIndex,
      getVideoRange,
      setAudioTrack,
      getSourceTracks,
      getSourceTrack,
      setSourceTrack,
      getSubtitleTracks,
      getSubtitleTrack,
      setSubtitleTrack,
    }),
    [
      videoRef,
      hlsRef,
      getRecovery,
      getFailure,
      reload,
      getDecodeHealth,
      getAudioTracks,
      getAudioTrack,
      getAudioTrackIndex,
      getVideoRange,
      setAudioTrack,
      getSourceTracks,
      getSourceTrack,
      setSourceTrack,
      getSubtitleTracks,
      getSubtitleTrack,
      setSubtitleTrack,
    ],
  );
}

function useVideoPlayerApi(ref: React.ForwardedRef<MediaRef>, props: OwnProps) {
  const player = useVideoPlayer(props);
  const videoRef = player.videoRef;

  const getCurrentTime = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.currentTime;
    }
    return 0;
  }, [videoRef]);
  const setCurrentTime = useCallback(
    (currentTime: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = currentTime;
      }
    },
    [videoRef],
  );
  const getPlaybackRate = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.playbackRate;
    }
    return 1;
  }, [videoRef]);
  const setPlaybackRate = useCallback(
    (playbackRate: number) => {
      if (videoRef.current) {
        videoRef.current.playbackRate = playbackRate;
      }
    },
    [videoRef],
  );
  const getPaused = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.paused;
    }
    return false;
  }, [videoRef]);
  const getDuration = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.duration;
    }
    return 0;
  }, [videoRef]);
  const getError = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.networkState === videoRef.current.NETWORK_NO_SOURCE;
    }
    return false;
  }, [videoRef]);
  const getLoading = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.readyState < videoRef.current.HAVE_ENOUGH_DATA;
    }
    return true;
  }, [videoRef]);
  const getProportionLoaded = useCallback(() => {
    if (videoRef.current) {
      return (
        videoRef.current.buffered.length && videoRef.current.buffered.end(videoRef.current.buffered.length - 1) / videoRef.current.duration
      );
    }
    return 0;
  }, [videoRef]);
  const getProportionPlayed = useCallback(() => {
    if (videoRef.current) {
      return videoRef.current.currentTime / videoRef.current.duration;
    }
    return 0;
  }, [videoRef]);
  const play = useCallback(async () => {
    await videoRef.current?.play();
  }, [videoRef]);
  const pause = useCallback(() => {
    videoRef.current?.pause();
  }, [videoRef]);
  const playPause = useCallback(async () => {
    if (getPaused()) {
      await play();
    } else {
      pause();
    }
  }, [play, pause, getPaused]);
  const load = useCallback(() => {
    videoRef.current?.load();
  }, [videoRef]);

  const api = useMemo<MediaRef>(
    () => ({
      play,
      pause,
      playPause,
      load,
      get videoElement() {
        return videoRef.current;
      },
      get hls() {
        return player.hlsRef.current;
      },
      get decodeHealth() {
        return player.getDecodeHealth();
      },
      get recovery() {
        return player.getRecovery();
      },
      get audioTrackIndex() {
        return player.getAudioTrackIndex();
      },
      get videoRange() {
        return player.getVideoRange();
      },
      get failure() {
        return player.getFailure();
      },
      reload: player.reload,
      get currentTime() {
        return getCurrentTime();
      },
      set currentTime(currentTime) {
        setCurrentTime(currentTime);
      },
      get audioTracks() {
        return player.getAudioTracks();
      },
      get audioTrack() {
        return player.getAudioTrack();
      },
      set audioTrack(audioTrack) {
        player.setAudioTrack(audioTrack);
      },
      get sourceTracks() {
        return player.getSourceTracks();
      },
      get sourceTrack() {
        return player.getSourceTrack();
      },
      set sourceTrack(sourceTrack) {
        player.setSourceTrack(sourceTrack);
      },
      get subtitleTracks() {
        return player.getSubtitleTracks();
      },
      get subtitleTrack() {
        return player.getSubtitleTrack();
      },
      set subtitleTrack(subtitleTrack) {
        player.setSubtitleTrack(subtitleTrack);
      },
      get playbackRate() {
        return getPlaybackRate();
      },
      set playbackRate(playbackRate) {
        setPlaybackRate(playbackRate);
      },
      get paused() {
        return getPaused();
      },
      get duration() {
        return getDuration();
      },
      get error() {
        return getError();
      },
      get loading() {
        return getLoading();
      },
      get proportionLoaded() {
        return getProportionLoaded();
      },
      get proportionPlayed() {
        return getProportionPlayed();
      },
    }),
    [
      player,
      play,
      pause,
      playPause,
      load,
      videoRef,
      getCurrentTime,
      setCurrentTime,
      getPlaybackRate,
      setPlaybackRate,
      getPaused,
      getDuration,
      getError,
      getLoading,
      getProportionLoaded,
      getProportionPlayed,
    ],
  );

  useImperativeHandle(ref, () => api, [api]);

  return useMemo(
    () => ({
      api,
      player,
    }),
    [api, player],
  );
}

const MEDIA_EVENTS = [
  'onAbort',
  'onCanPlay',
  'onCanPlayThrough',
  'onDurationChange',
  'onEmptied',
  'onEncrypted',
  'onEnded',
  'onError',
  'onLoadedData',
  'onLoadedMetadata',
  'onLoadStart',
  'onPause',
  'onPlay',
  'onPlaying',
  'onProgress',
  'onRateChange',
  'onSeeked',
  'onSeeking',
  'onStalled',
  'onSuspend',
  'onTimeUpdate',
  'onVolumeChange',
  'onWaiting',
] as const;

type MediaEvents = keyof typeof MEDIA_EVENTS;

export type MediaProps = OwnProps & React.HTMLAttributes<HTMLVideoElement>;

const Media = React.forwardRef<MediaRef, MediaProps>(
  (
    {
      autoPlay,
      audioTracks,
      sourceTracks,
      subtitleTracks,
      streamingType,
      isSettingsOpen,
      onUpdate,
      onAudioChange,
      onSourceChange,
      onSubtitleChange,
      className,
      mediaComponent,
      ...props
    },
    ref,
  ) => {
    const handleUpdate = useCallback(() => {
      onUpdate?.();
    }, [onUpdate]);
    const eventProps = useMemo(
      () =>
        MEDIA_EVENTS.reduce<Partial<Record<MediaEvents, Function>>>(
          (result, event) => ({
            ...result,
            [event]: (...args: any[]) => {
              handleUpdate();
              // @ts-expect-error
              props[event]?.(...args);
            },
          }),
          {},
        ),
      [props, handleUpdate],
    );
    const { player } = useVideoPlayerApi(ref, {
      autoPlay,
      audioTracks,
      sourceTracks,
      subtitleTracks,
      streamingType,
      isSettingsOpen,
      onAudioChange,
      onSourceChange,
      onSubtitleChange,
    });

    return <video {...props} {...eventProps} autoPlay={false} className={cx('w-screen h-screen', className)} ref={player.videoRef} />;
  },
);

export default Media;
