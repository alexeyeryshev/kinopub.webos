import React, { useCallback, useEffect, useRef, useState } from 'react';
import { VideoPlayerBase } from '@enact/moonstone/VideoPlayer';
import cx from 'classnames';
import HLS from 'hls.js';

import { getVideoNode } from './getVideoNode';

const HISTORY_LIMIT = 30;
const VIDEO_EVENTS = ['playing', 'waiting', 'stalled', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'error', 'ended'];
const HLS_EVENT_KEYS = [
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

// hls.js categorizes buffer-starvation symptoms as MEDIA_ERROR because they surface through the
// media element, so they must be matched by `details` before falling back to `type`.
// `bufferFullError` is deliberately excluded: it is a SourceBuffer quota-exceeded/append-capacity
// failure (the buffer is too full to append), the opposite condition from starvation, and falls
// through to the media/decode-failure category instead.
const BUFFER_STARVATION_DETAILS = new Set(['bufferStalledError', 'bufferSeekOverHole', 'bufferNudgeOnStall']);

type Nullable<T> = T | null;

type DiagnosticsTarget = {
  video: Nullable<HTMLVideoElement>;
  hls: Nullable<HLS>;
  selectedQuality: Nullable<string>;
};

type DiagnosticHistoryItem = {
  id: number;
  timestamp: number;
  source: 'video' | 'hls';
  name: string;
  details?: string;
};

type BufferedRange = {
  start: number;
  end: number;
};

type LastFragmentInfo = {
  timestamp: number;
  level?: number;
  height?: number;
  bytes?: number;
  loadSeconds?: number;
  throughputMbps?: number;
};

type FailureCategory = 'network' | 'buffer' | 'media' | 'other';

type FailureCounts = Record<FailureCategory, number>;

type FragLoadStage = {
  status: 'loading' | 'loaded' | 'aborted';
  level?: number;
  height?: number;
  sn?: number | string;
  startedAt: number;
  durationSeconds?: number;
};

// Keyed by `frag.type` ('main' | 'audio' | 'subtitle'): main and audio fragments load concurrently
// on streams with alternate audio, so a single shared stage would let one hide a stall in the other.
type FragLoadStagesByStream = Record<string, FragLoadStage>;

type BufferAppendStage = {
  status: 'appending' | 'appended';
  startedAt: number;
  durationSeconds?: number;
};

// Keyed by the SourceBuffer type ('video' | 'audio' | 'audiovideo') for the same reason: video and
// audio buffers append independently, so one completing must not hide a stall in the other.
type BufferAppendStagesByType = Record<string, BufferAppendStage>;

type PlaybackSnapshot = {
  currentTime: number;
  duration: number;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  readyStateLabel: string;
  networkState: number;
  networkStateLabel: string;
  videoError: boolean;
  videoErrorCode?: number;
  videoErrorMessage?: string;
  bufferAhead?: number;
  matchingRange?: BufferedRange;
  ranges: BufferedRange[];
  playbackQuality?: {
    totalVideoFrames: number;
    droppedVideoFrames: number;
    droppedPercent: number;
  };
  hls: {
    active: boolean;
    levelCount: number;
    levels: string[];
    currentLevel?: number;
    nextLevel?: number;
    loadLevel?: number;
    autoLevelCapping?: number;
    bandwidthEstimate?: number;
    mode: string;
  };
};

type Props = {
  visible: boolean;
  player: React.MutableRefObject<VideoPlayerBase | undefined>;
};

function formatTime(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return '--:--';
  }

  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const restSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(restSeconds).padStart(2, '0')}`;
}

function formatSeconds(seconds?: number) {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return 'n/a';
  }

  return `${seconds.toFixed(1)} s`;
}

function formatTimestamp(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour12: false });
}

function formatBytes(bytes?: number) {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return 'n/a';
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

function formatBitrate(bitsPerSecond?: number) {
  if (bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond)) {
    return 'n/a';
  }

  return `${(bitsPerSecond / 1000 / 1000).toFixed(1)} Mbps`;
}

function formatLevel(level: any, index: number) {
  const height = getFiniteNumber(level?.height);
  const bitrate = getFiniteNumber(level?.bitrate);
  const label = height ? `${height}p` : `level ${index}`;

  return bitrate ? `${label} / ${formatBitrate(bitrate)}` : label;
}

function getReadyStateLabel(value: number) {
  switch (value) {
    case 0:
      return 'HAVE_NOTHING';
    case 1:
      return 'HAVE_METADATA';
    case 2:
      return 'HAVE_CURRENT_DATA';
    case 3:
      return 'HAVE_FUTURE_DATA';
    case 4:
      return 'HAVE_ENOUGH_DATA';
    default:
      return 'UNKNOWN';
  }
}

function getNetworkStateLabel(value: number) {
  switch (value) {
    case 0:
      return 'NETWORK_EMPTY';
    case 1:
      return 'NETWORK_IDLE';
    case 2:
      return 'NETWORK_LOADING';
    case 3:
      return 'NETWORK_NO_SOURCE';
    default:
      return 'UNKNOWN';
  }
}

function getFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getHostname(value: unknown) {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }

  try {
    return new URL(value, window.location.href).hostname;
  } catch (e) {
    const match = value.match(/^(?:[a-z]+:)?\/\/([^/?#]+)/i);

    return match?.[1];
  }
}

function sanitizeText(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.replace(/https?:\/\/[^\s]+/gi, (url) => getHostname(url) || '[url]');
}

function getBufferedRanges(video: HTMLVideoElement) {
  const ranges: BufferedRange[] = [];

  for (let index = 0; index < video.buffered.length; index += 1) {
    try {
      ranges.push({
        start: video.buffered.start(index),
        end: video.buffered.end(index),
      });
    } catch (e) {
      return ranges;
    }
  }

  return ranges;
}

function getMatchingRange(ranges: BufferedRange[], currentTime: number) {
  return ranges.find((range) => range.start <= currentTime && currentTime <= range.end);
}

function formatRange(range?: BufferedRange) {
  if (!range) {
    return 'not buffered';
  }

  return `${formatTime(range.start)}-${formatTime(range.end)}`;
}

function formatRanges(ranges: BufferedRange[]) {
  if (!ranges.length) {
    return 'none';
  }

  return ranges.map(formatRange).join(', ');
}

function getPlaybackQuality(video: HTMLVideoElement) {
  const getQuality = (
    video as HTMLVideoElement & {
      getVideoPlaybackQuality?: () => {
        totalVideoFrames?: number;
        droppedVideoFrames?: number;
      };
    }
  ).getVideoPlaybackQuality;

  if (!getQuality) {
    return undefined;
  }

  const quality = getQuality.call(video);
  const totalVideoFrames = getFiniteNumber(quality?.totalVideoFrames) || 0;
  const droppedVideoFrames = getFiniteNumber(quality?.droppedVideoFrames) || 0;

  return {
    totalVideoFrames,
    droppedVideoFrames,
    droppedPercent: totalVideoFrames > 0 ? (droppedVideoFrames / totalVideoFrames) * 100 : 0,
  };
}

function getHlsNumber(hls: HLS, field: string) {
  return getFiniteNumber((hls as any)[field]);
}

function getHlsMode(hls: HLS) {
  const autoLevelEnabled = (hls as any).autoLevelEnabled;

  if (typeof autoLevelEnabled === 'boolean') {
    return autoLevelEnabled ? 'auto' : 'fixed';
  }

  return hls.currentLevel === -1 ? 'auto' : 'fixed';
}

function getHlsSnapshot(hls: Nullable<HLS>) {
  if (!hls) {
    return {
      active: false,
      levelCount: 0,
      levels: [],
      mode: 'n/a',
    };
  }

  const levels = Array.isArray(hls.levels) ? hls.levels : [];

  return {
    active: true,
    levelCount: levels.length,
    levels: levels.map(formatLevel),
    currentLevel: getHlsNumber(hls, 'currentLevel'),
    nextLevel: getHlsNumber(hls, 'nextLevel'),
    loadLevel: getHlsNumber(hls, 'loadLevel'),
    autoLevelCapping: getHlsNumber(hls, 'autoLevelCapping'),
    bandwidthEstimate: getHlsNumber(hls, 'bandwidthEstimate'),
    mode: getHlsMode(hls),
  };
}

function takeSnapshot(video: Nullable<HTMLVideoElement>, hls: Nullable<HLS>): Nullable<PlaybackSnapshot> {
  if (!video) {
    return null;
  }

  const ranges = getBufferedRanges(video);
  const matchingRange = getMatchingRange(ranges, video.currentTime);
  const mediaError = video.error;

  return {
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    seeking: video.seeking,
    readyState: video.readyState,
    readyStateLabel: getReadyStateLabel(video.readyState),
    networkState: video.networkState,
    networkStateLabel: getNetworkStateLabel(video.networkState),
    videoError: Boolean(mediaError),
    videoErrorCode: mediaError?.code,
    videoErrorMessage: sanitizeText(mediaError?.message),
    bufferAhead: matchingRange ? matchingRange.end - video.currentTime : undefined,
    matchingRange,
    ranges,
    playbackQuality: getPlaybackQuality(video),
    hls: getHlsSnapshot(hls),
  };
}

function getFragmentInfo(data: any, hls: HLS): LastFragmentInfo {
  const frag = data?.frag || {};
  // FRAG_BUFFERED carries top-level stats; FRAG_LOADED and buffer-append events only expose them on the fragment itself.
  const stats = data?.stats || frag.stats || {};
  const level = getFiniteNumber(frag.level) ?? getFiniteNumber(data?.level);
  const levelInfo = level !== undefined ? hls.levels?.[level] : undefined;
  const bytes = getFiniteNumber(stats.loaded) ?? getFiniteNumber(stats.total);
  const requestTime = getFiniteNumber(stats.trequest);
  const loadTime = getFiniteNumber(stats.tload);
  const loadSeconds =
    requestTime !== undefined && loadTime !== undefined && loadTime > requestTime ? (loadTime - requestTime) / 1000 : undefined;

  return {
    timestamp: Date.now(),
    level,
    height: getFiniteNumber(levelInfo?.height) ?? getFiniteNumber(frag.height),
    bytes,
    loadSeconds,
    throughputMbps: bytes !== undefined && loadSeconds && loadSeconds > 0 ? (bytes * 8) / loadSeconds / 1000 / 1000 : undefined,
  };
}

function formatFragmentIdentity(frag: any, hls: HLS) {
  const level = getFiniteNumber(frag?.level);
  const height = level !== undefined ? getFiniteNumber(hls.levels?.[level]?.height) : undefined;
  const label = height ? `${height}p` : level !== undefined ? `level ${level}` : 'unknown level';
  const sn = frag?.sn;

  return sn !== undefined && sn !== null ? `${label}, sn ${sn}` : label;
}

function getFailureCategory(data: any): FailureCategory {
  const details = typeof data?.details === 'string' ? data.details : undefined;

  if (details && BUFFER_STARVATION_DETAILS.has(details)) {
    return 'buffer';
  }

  if (data?.type === 'networkError') {
    return 'network';
  }

  if (data?.type === 'mediaError' || data?.type === 'muxError') {
    return 'media';
  }

  return 'other';
}

function formatCategoryLabel(category: FailureCategory) {
  switch (category) {
    case 'network':
      return 'network failure';
    case 'buffer':
      return 'buffer starvation';
    case 'media':
      return 'media/decode failure';
    default:
      return 'other failure';
  }
}

function formatFragLoadStageValue(stage: FragLoadStage) {
  const identity = stage.height ? `${stage.height}p` : stage.level !== undefined ? `level ${stage.level}` : 'unknown level';
  const snLabel = stage.sn !== undefined && stage.sn !== null ? `, sn ${stage.sn}` : '';

  if (stage.status === 'loading') {
    return `${identity}${snLabel} - loading (${formatSeconds((Date.now() - stage.startedAt) / 1000)})`;
  }

  if (stage.status === 'aborted') {
    return `${identity}${snLabel} - aborted (low bandwidth)`;
  }

  return `${identity}${snLabel} - loaded in ${formatSeconds(stage.durationSeconds)}`;
}

function formatFragLoadStages(stages: FragLoadStagesByStream) {
  const entries = Object.entries(stages);

  if (!entries.length) {
    return 'idle';
  }

  return entries.map(([streamType, stage]) => `${streamType}: ${formatFragLoadStageValue(stage)}`).join('; ');
}

function formatBufferAppendStageValue(stage: BufferAppendStage) {
  if (stage.status === 'appending') {
    return `appending (${formatSeconds((Date.now() - stage.startedAt) / 1000)})`;
  }

  return `appended in ${formatSeconds(stage.durationSeconds)}`;
}

function formatBufferAppendStages(stages: BufferAppendStagesByType) {
  const entries = Object.entries(stages);

  if (!entries.length) {
    return 'idle';
  }

  return entries.map(([bufferType, stage]) => `${bufferType}: ${formatBufferAppendStageValue(stage)}`).join('; ');
}

function formatLastFragment(fragment?: LastFragmentInfo) {
  if (!fragment) {
    return 'none yet';
  }

  const level = fragment.height ? `${fragment.height}p` : fragment.level !== undefined ? `level ${fragment.level}` : 'unknown level';

  return `${level}, ${formatBytes(fragment.bytes)}, ${formatSeconds(fragment.loadSeconds)}, ${formatBitrate(
    fragment.throughputMbps !== undefined ? fragment.throughputMbps * 1000 * 1000 : undefined,
  )}`;
}

function getErrorDetails(data: any) {
  const response = data?.response || data?.context?.response;
  const status = getFiniteNumber(response?.code) ?? getFiniteNumber(response?.status);
  const hostname =
    getHostname(data?.context?.url) || getHostname(response?.url) || getHostname(data?.frag?.url) || getHostname(data?.url) || undefined;
  const parts = [
    data?.fatal ? 'fatal' : 'non-fatal',
    formatCategoryLabel(getFailureCategory(data)),
    sanitizeText(data?.type),
    sanitizeText(data?.details),
    status !== undefined ? `HTTP ${status}` : undefined,
    hostname ? `host ${hostname}` : undefined,
  ].filter(Boolean);

  return parts.join(', ');
}

function getHlsEventDetails(name: string, data: any, hls: HLS) {
  if (name === 'ERROR') {
    return getErrorDetails(data);
  }

  if (name === 'LEVEL_SWITCHED') {
    const level = getFiniteNumber(data?.level);
    const height = level !== undefined ? getFiniteNumber(hls.levels?.[level]?.height) : undefined;

    return ['level switch', level !== undefined ? `level ${level}` : undefined, height ? `${height}p` : undefined]
      .filter(Boolean)
      .join(', ');
  }

  if (name === 'FRAG_CHANGED' || name === 'FRAG_BUFFERED' || name === 'FRAG_LOADED') {
    return formatLastFragment(getFragmentInfo(data, hls));
  }

  if (name === 'FRAG_LOADING') {
    return `${formatFragmentIdentity(data?.frag, hls)} - load start`;
  }

  if (name === 'FRAG_LOAD_EMERGENCY_ABORTED') {
    return `${formatFragmentIdentity(data?.frag, hls)} - emergency abort (low bandwidth)`;
  }

  if (name === 'BUFFER_APPENDING') {
    return `${sanitizeText(data?.type) || 'unknown'} - append start`;
  }

  if (name === 'BUFFER_APPENDED') {
    return `${sanitizeText(data?.type) || 'unknown'} - append complete`;
  }

  return undefined;
}

function PlaybackDiagnosticsOverlay({ visible, player }: Props) {
  const [target, setTarget] = useState<DiagnosticsTarget>({ video: null, hls: null, selectedQuality: null });
  const [snapshot, setSnapshot] = useState<Nullable<PlaybackSnapshot>>(null);
  const [history, setHistory] = useState<DiagnosticHistoryItem[]>([]);
  const [lastFragment, setLastFragment] = useState<LastFragmentInfo | undefined>();
  const [fragLoadStages, setFragLoadStages] = useState<FragLoadStagesByStream>({});
  const [bufferAppendStages, setBufferAppendStages] = useState<BufferAppendStagesByType>({});
  const [emergencyAbortCount, setEmergencyAbortCount] = useState(0);
  const [failureCounts, setFailureCounts] = useState<FailureCounts>({ network: 0, buffer: 0, media: 0, other: 0 });
  const [lastFailure, setLastFailure] = useState<Nullable<{ category: FailureCategory; timestamp: number }>>(null);
  const nextHistoryId = useRef(1);
  const pendingAppendStarts = useRef<Map<string, number>>(new Map());

  const pushHistory = useCallback((source: DiagnosticHistoryItem['source'], name: string, details?: string) => {
    setHistory((items) => [
      ...items.slice(Math.max(0, items.length - HISTORY_LIMIT + 1)),
      {
        id: nextHistoryId.current++,
        timestamp: Date.now(),
        source,
        name,
        details,
      },
    ]);
  }, []);

  const readMediaRef = useCallback(() => {
    return getVideoNode(player.current);
  }, [player]);

  useEffect(() => {
    const syncTarget = () => {
      const media = readMediaRef();
      const nextTarget = {
        video: media?.videoElement || null,
        hls: media?.hls || null,
        selectedQuality: media?.sourceTrack || null,
      };

      setTarget((current) =>
        current.video === nextTarget.video && current.hls === nextTarget.hls && current.selectedQuality === nextTarget.selectedQuality
          ? current
          : nextTarget,
      );
    };

    syncTarget();
    const intervalId = setInterval(syncTarget, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [readMediaRef]);

  useEffect(() => {
    if (!target.video) {
      return;
    }

    const video = target.video;
    const handlers = VIDEO_EVENTS.map((name) => {
      const handler = () => {
        const details = name === 'error' && video.error ? `code ${video.error.code}` : undefined;

        pushHistory('video', name, details);
      };

      video.addEventListener(name, handler);

      return { name, handler };
    });

    return () => {
      handlers.forEach(({ name, handler }) => {
        video.removeEventListener(name, handler);
      });
    };
  }, [target.video, pushHistory]);

  useEffect(() => {
    if (!target.hls) {
      return;
    }

    const hls = target.hls;
    const hlsEvents = (HLS as any).Events || {};
    const pendingAppends = pendingAppendStarts.current;

    // Reset lifecycle/failure state for the new HLS instance so it reflects only the current source.
    setFragLoadStages({});
    setBufferAppendStages({});
    setEmergencyAbortCount(0);
    setFailureCounts({ network: 0, buffer: 0, media: 0, other: 0 });
    setLastFailure(null);
    pendingAppends.clear();

    const handlers = HLS_EVENT_KEYS.map((key) => {
      const eventName = hlsEvents[key];
      const handler = (_event: string, data: any) => {
        if (key === 'FRAG_LOADING') {
          const frag = data?.frag;
          const streamType = typeof frag?.type === 'string' ? frag.type : 'main';
          const level = getFiniteNumber(frag?.level);

          setFragLoadStages((stages) => ({
            ...stages,
            [streamType]: {
              status: 'loading',
              level,
              height: level !== undefined ? getFiniteNumber(hls.levels?.[level]?.height) : undefined,
              sn: frag?.sn,
              startedAt: Date.now(),
            },
          }));
        }

        if (key === 'FRAG_LOADED') {
          const frag = data?.frag;
          const streamType = typeof frag?.type === 'string' ? frag.type : 'main';
          const info = getFragmentInfo(data, hls);

          setFragLoadStages((stages) => ({
            ...stages,
            [streamType]: {
              status: 'loaded',
              level: info.level,
              height: info.height,
              sn: frag?.sn,
              startedAt: Date.now() - (info.loadSeconds ? info.loadSeconds * 1000 : 0),
              durationSeconds: info.loadSeconds,
            },
          }));
        }

        if (key === 'FRAG_LOAD_EMERGENCY_ABORTED') {
          const frag = data?.frag;
          const streamType = typeof frag?.type === 'string' ? frag.type : 'main';

          setEmergencyAbortCount((count) => count + 1);
          setFragLoadStages((stages) =>
            stages[streamType] ? { ...stages, [streamType]: { ...stages[streamType], status: 'aborted' } } : stages,
          );
        }

        if (key === 'FRAG_BUFFERED') {
          setLastFragment(getFragmentInfo(data, hls));
        }

        if (key === 'BUFFER_APPENDING') {
          const bufferType = typeof data?.type === 'string' ? data.type : 'unknown';

          pendingAppends.set(bufferType, Date.now());
          setBufferAppendStages((stages) => ({ ...stages, [bufferType]: { status: 'appending', startedAt: Date.now() } }));
        }

        if (key === 'BUFFER_APPENDED') {
          const bufferType = typeof data?.type === 'string' ? data.type : 'unknown';
          const startedAt = pendingAppends.get(bufferType);

          pendingAppends.delete(bufferType);
          setBufferAppendStages((stages) => ({
            ...stages,
            [bufferType]: {
              status: 'appended',
              startedAt: startedAt ?? Date.now(),
              durationSeconds: startedAt !== undefined ? (Date.now() - startedAt) / 1000 : undefined,
            },
          }));
        }

        if (key === 'ERROR') {
          const category = getFailureCategory(data);

          setFailureCounts((counts) => ({ ...counts, [category]: counts[category] + 1 }));
          setLastFailure({ category, timestamp: Date.now() });
        }

        pushHistory('hls', key, getHlsEventDetails(key, data, hls));
      };

      return { eventName, handler };
    }).filter(({ eventName }) => Boolean(eventName));

    handlers.forEach(({ eventName, handler }) => {
      (hls as any).on(eventName, handler);
    });

    return () => {
      handlers.forEach(({ eventName, handler }) => {
        (hls as any).off(eventName, handler);
      });
      pendingAppends.clear();
    };
  }, [target.hls, pushHistory]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const updateSnapshot = () => setSnapshot(takeSnapshot(target.video, target.hls));

    updateSnapshot();
    const intervalId = setInterval(updateSnapshot, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [visible, target]);

  const lastSuccessfulFragmentAge = lastFragment ? (Date.now() - lastFragment.timestamp) / 1000 : undefined;

  if (!visible) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute z-101 top-14 left-6 right-6 max-h-screen overflow-hidden rounded bg-black bg-opacity-80 p-4 text-white ring">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-2xl font-bold">Диагностика воспроизведения</div>
        <div className="text-lg text-gray-300">Back: закрыть</div>
      </div>

      {!snapshot && <div className="text-xl">Видео еще не готово</div>}

      {snapshot && (
        <div className="grid grid-cols-3 gap-4 text-base leading-snug">
          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Playback</h3>
            <div>
              Time: {formatTime(snapshot.currentTime)} / {formatTime(snapshot.duration)}
            </div>
            <div>paused: {String(snapshot.paused)}</div>
            <div>seeking: {String(snapshot.seeking)}</div>
            <div>
              readyState: {snapshot.readyState} {snapshot.readyStateLabel}
            </div>
            <div>
              networkState: {snapshot.networkState} {snapshot.networkStateLabel}
            </div>
            <div>video error: {String(snapshot.videoError)}</div>
            {snapshot.videoError && (
              <div>
                error: {snapshot.videoErrorCode || 'n/a'} {snapshot.videoErrorMessage}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Buffer</h3>
            <div>ahead: {formatSeconds(snapshot.bufferAhead)}</div>
            <div>current range: {formatRange(snapshot.matchingRange)}</div>
            <div className={cx({ 'text-yellow-300': !snapshot.matchingRange })}>
              position buffered: {snapshot.matchingRange ? 'yes' : 'no'}
            </div>
            <div>ranges: {formatRanges(snapshot.ranges)}</div>
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">HLS</h3>
            <div>active: {String(snapshot.hls.active)}</div>
            <div>selected quality: {target.selectedQuality ?? 'n/a'}</div>
            <div>levels: {snapshot.hls.levelCount}</div>
            <div>mode: {snapshot.hls.mode}</div>
            <div>currentLevel: {snapshot.hls.currentLevel ?? 'n/a'}</div>
            <div>nextLevel: {snapshot.hls.nextLevel ?? 'n/a'}</div>
            <div>loadLevel: {snapshot.hls.loadLevel ?? 'n/a'}</div>
            <div>autoLevelCapping: {snapshot.hls.autoLevelCapping ?? 'n/a'}</div>
            <div>bandwidthEstimate: {formatBitrate(snapshot.hls.bandwidthEstimate)}</div>
            <div>available: {snapshot.hls.levels.join(', ') || 'n/a'}</div>
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Last Fragment</h3>
            <div>{formatLastFragment(lastFragment)}</div>
            <div>last successful: {formatSeconds(lastSuccessfulFragmentAge)} ago</div>
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Segment Pipeline</h3>
            <div
              className={cx({
                'text-yellow-300': Object.values(fragLoadStages).some((stage) => stage.status === 'loading'),
              })}
            >
              load: {formatFragLoadStages(fragLoadStages)}
            </div>
            <div
              className={cx({
                'text-yellow-300': Object.values(bufferAppendStages).some((stage) => stage.status === 'appending'),
              })}
            >
              append: {formatBufferAppendStages(bufferAppendStages)}
            </div>
            <div>emergency aborts: {emergencyAbortCount}</div>
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Failure Summary</h3>
            <div>network: {failureCounts.network}</div>
            <div>buffer starvation: {failureCounts.buffer}</div>
            <div>media/decode: {failureCounts.media}</div>
            <div>other: {failureCounts.other}</div>
            <div className={cx({ 'text-yellow-300': Boolean(lastFailure) })}>
              last:{' '}
              {lastFailure
                ? `${formatCategoryLabel(lastFailure.category)}, ${formatSeconds((Date.now() - lastFailure.timestamp) / 1000)} ago`
                : 'none'}
            </div>
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Decode Quality</h3>
            {snapshot.playbackQuality ? (
              <>
                <div>frames: {snapshot.playbackQuality.totalVideoFrames}</div>
                <div>dropped: {snapshot.playbackQuality.droppedVideoFrames}</div>
                <div>dropped %: {snapshot.playbackQuality.droppedPercent.toFixed(2)}%</div>
              </>
            ) : (
              <div>not available</div>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-xl font-bold text-blue-300">Recent Events</h3>
            <div className="max-h-58 overflow-hidden">
              {history
                .slice()
                .reverse()
                .map((item) => (
                  <div key={item.id}>
                    {formatTimestamp(item.timestamp)} {item.source} {item.name}
                    {item.details ? ` - ${item.details}` : ''}
                  </div>
                ))}
              {!history.length && <div>none</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default PlaybackDiagnosticsOverlay;
