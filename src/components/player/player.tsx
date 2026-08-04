import React, { useCallback, useEffect, useRef, useState } from 'react';
import VideoPlayer, { VideoPlayerBase, VideoPlayerBaseProps } from '@enact/moonstone/VideoPlayer';
import Spotlight from '@enact/spotlight';

import { Item, Season, Video } from 'api';
import BackButton from 'components/backButton';
import Button from 'components/button';
import EpisodePicker from 'components/episodePicker';
import Media, { AUTO_SOURCE_NAME, AudioTrack, PlaybackFailure, SourceTrack, StreamingType, SubtitleTrack } from 'components/media';
import Text from 'components/text';
import useButtonEffect from 'hooks/useButtonEffect';
import useStorageState from 'hooks/useStorageState';

import DecodeHealthIndicator from './decodeHealthIndicator';
import { getVideoNode } from './getVideoNode';
import PlaybackDiagnosticsOverlay from './playbackDiagnostics';
import PlaybackFailureNotice from './playbackFailureNotice';
import Settings from './settings';
import StartFrom from './startFrom';

import { DecodeHealth } from 'utils/decodeHealth';

export type PlayerProps = {
  title: string;
  description?: string;
  poster: string;
  audios?: AudioTrack[];
  sources: SourceTrack[];
  subtitles?: SubtitleTrack[];
  startTime?: number;
  timeSyncInterval?: number;
  streamingType?: StreamingType;
  item?: Item;
  seasons?: Season[];
  currentSeasonNumber?: number;
  onPlay?: () => void;
  onPause?: (currentTime: number) => void;
  onEnded?: (currentTime: number) => void;
  onTimeSync?: (currentTime: number) => void | Promise<void>;
  onEpisodeSelect?: (episode: Video, season: Season) => void;
} & VideoPlayerBaseProps;

const Player: React.FC<PlayerProps> = ({
  title,
  description,
  poster,
  audios,
  sources,
  subtitles,
  startTime,
  timeSyncInterval = 30,
  streamingType,
  item,
  seasons,
  currentSeasonNumber,
  onPlay,
  onPause,
  onEnded,
  onTimeSync,
  onEpisodeSelect,
  ...props
}) => {
  const playerRef = useRef<VideoPlayerBase>();
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isEpisodesOpen, setIsEpisodesOpen] = useState(false);
  const [isDiagnosticsVisible, setIsDiagnosticsVisible] = useState(false);
  const [isDiagnosticsExportVisible, setIsDiagnosticsExportVisible] = useState(false);
  const [decodeHealth, setDecodeHealth] = useState<DecodeHealth>();
  const [failure, setFailure] = useState<PlaybackFailure>();
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPauseByOKClickActive] = useStorageState<boolean>('is_pause_by_ok_click_active');
  // Subtitle brightness is remembered per title as well as globally. The right value is not one
  // number: on the TV an HDR title wanted 25% while SDR sat around 50-75%, and nothing available to
  // the app reliably says which is playing (see `utils/hdr`). Per-title memory sidesteps the
  // question -- a film, or a series, keeps whatever was chosen for it -- while the global value
  // seeds anything not seen before.
  const [globalSubtitleOpacity, setGlobalSubtitleOpacity] = useStorageState<number>('subtitle_opacity', 1);
  const subtitleOpacityKey = `item_${item?.id ?? 'default'}_saved_subtitle_opacity` as const;
  const [itemSubtitleOpacity, setItemSubtitleOpacity] = useStorageState<number>(subtitleOpacityKey, globalSubtitleOpacity);
  const subtitleOpacity = item ? itemSubtitleOpacity : globalSubtitleOpacity;

  const handleSubtitleOpacityChange = useCallback(
    (opacity: number) => {
      // Both: this title keeps the choice, and the next unseen one starts from it rather than from
      // whatever was set months ago.
      setGlobalSubtitleOpacity(opacity);

      if (item) {
        setItemSubtitleOpacity(opacity);
      }
    },
    [item, setGlobalSubtitleOpacity, setItemSubtitleOpacity],
  );
  const [currentSourceName, setCurrentSourceName] = useState<string | null>(null);

  const isAutoQuality = currentSourceName === AUTO_SOURCE_NAME;
  const activeSource = sources?.find((s) => s.name === currentSourceName) || sources?.find((s) => s.default) || sources?.[0];
  const qualityLabel = isAutoQuality ? `${AUTO_SOURCE_NAME} (${activeSource?.name})` : activeSource?.name;
  const isHDR =
    activeSource?.codec?.toLowerCase().includes('hevc') ||
    activeSource?.codec === 'h265' ||
    activeSource?.name?.toLowerCase().includes('hdr');

  const handlePlay = useCallback(() => {
    setIsSettingsOpen(false);
    onPlay?.();
  }, [onPlay]);
  const handlePause = useCallback(
    (e) => {
      onPause?.(e.currentTime);
    },
    [onPause],
  );
  const handlePlayPause = useCallback(
    (e: KeyboardEvent) => {
      const current: any = Spotlight.getCurrent();
      if ((!current || !current.offsetHeight || !current.offsetWidth) && playerRef.current && isPauseByOKClickActive) {
        const video = getVideoNode(playerRef.current);
        video?.playPause();
        return false;
      }
    },
    [playerRef, isPauseByOKClickActive],
  );
  const handleEnded = useCallback(
    (e) => {
      onEnded?.(e.target.currentTime);
    },
    [onEnded],
  );
  const handleTimeSync = useCallback(async () => {
    if (playerRef.current && onTimeSync) {
      const video = getVideoNode(playerRef.current);

      const currentTime = video?.currentTime || 0;

      await onTimeSync(currentTime);
    }
  }, [onTimeSync, playerRef]);
  const handleLoadedMetadata = useCallback(() => {
    setIsLoaded(true);
  }, []);
  const handleSettingsOpen = useCallback(() => {
    if (playerRef.current) {
      setIsSettingsOpen(true);

      const video = getVideoNode(playerRef.current);
      video?.pause();
    }
  }, [playerRef]);
  const handleSettingsClose = useCallback(() => {
    if (playerRef.current) {
      setIsSettingsOpen(false);

      const video = getVideoNode(playerRef.current);
      setCurrentSourceName(video?.sourceTrack || null);
      video?.play();
    }
  }, []);
  const handleEpisodesOpen = useCallback(() => {
    if (playerRef.current && seasons?.length) {
      setIsEpisodesOpen(true);

      const video = getVideoNode(playerRef.current);
      video?.pause();
    }
  }, [playerRef, seasons]);
  const handleEpisodesClose = useCallback(() => {
    if (playerRef.current) {
      setIsEpisodesOpen(false);

      const video = getVideoNode(playerRef.current);
      video?.play();
    }
  }, []);
  const handleControlsAvailable = useCallback((e: { available: boolean }) => {
    setControlsVisible(e.available);
  }, []);
  const handlePauseButton = useCallback(() => {
    if (playerRef.current) {
      const video = getVideoNode(playerRef.current);
      video?.pause();
    }
  }, [playerRef]);
  const handleDiagnosticsToggle = useCallback(() => {
    setIsDiagnosticsVisible((visible) => !visible);
  }, []);
  const handleDiagnosticsExportToggle = useCallback(() => {
    setIsDiagnosticsExportVisible((visible) => !visible);
  }, []);
  const handleDiagnosticsExportButton = useCallback(() => {
    // Only meaningful while the diagnostics panels are up; otherwise leave the key to anything else.
    if (isDiagnosticsVisible) {
      setIsDiagnosticsExportVisible((visible) => !visible);

      return false;
    }
  }, [isDiagnosticsVisible]);
  const handleDiagnosticsClose = useCallback(() => {
    if (!isSettingsOpen && !isEpisodesOpen) {
      // The export view sits on top of the panels, so Back peels it off first.
      if (isDiagnosticsExportVisible) {
        setIsDiagnosticsExportVisible(false);

        return false;
      }

      if (isDiagnosticsVisible) {
        setIsDiagnosticsVisible(false);

        return false;
      }
    }
  }, [isDiagnosticsVisible, isDiagnosticsExportVisible, isSettingsOpen, isEpisodesOpen]);

  useEffect(() => {
    const styleId = 'subtitle-opacity-style';
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `video::cue { opacity: ${subtitleOpacity ?? 1}; }`;
  }, [subtitleOpacity]);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    if (onTimeSync) {
      intervalId = setInterval(handleTimeSync, timeSyncInterval * 1000);
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [timeSyncInterval, onTimeSync, handleTimeSync]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      const video = getVideoNode(playerRef.current);
      const next = video?.decodeHealth;

      // Re-render only when something a viewer would see actually changed, so a healthy stream
      // does not re-render the player every two seconds for nothing.
      setDecodeHealth((current) =>
        current?.severity === next?.severity && current?.droppedRatio === next?.droppedRatio && current?.decodeErrors === next?.decodeErrors
          ? current
          : next,
      );

      const nextFailure = video?.failure;

      setFailure((current) => (current?.since === nextFailure?.since ? current : nextFailure));
    }, 2000);

    return () => {
      clearInterval(intervalId);
    };
  }, [playerRef]);

  const handleRetry = useCallback(() => {
    getVideoNode(playerRef.current)?.reload();
    // Clear it here too rather than waiting up to two seconds for the next poll: the notice has to
    // go the moment it is acted on, or the retry reads as if it did nothing.
    setFailure(undefined);
  }, []);

  useButtonEffect('Back', handleTimeSync);
  useButtonEffect('Blue', handleSettingsOpen);
  useButtonEffect('Play', handleSettingsClose);
  useButtonEffect('Pause', handlePauseButton);
  useButtonEffect('Enter', handlePlayPause);
  useButtonEffect('ArrowUp', handleSettingsOpen);
  useButtonEffect('Back', handleDiagnosticsClose);
  useButtonEffect('Yellow', handleDiagnosticsExportButton);

  return (
    <>
      <Settings
        visible={isSettingsOpen}
        diagnosticsVisible={isDiagnosticsVisible}
        subtitleOpacity={subtitleOpacity ?? 1}
        onSubtitleOpacityChange={handleSubtitleOpacityChange}
        onClose={handleSettingsClose}
        onDiagnosticsToggle={handleDiagnosticsToggle}
        player={playerRef}
      />
      <PlaybackDiagnosticsOverlay
        visible={isDiagnosticsVisible}
        exportVisible={isDiagnosticsExportVisible}
        onExportToggle={handleDiagnosticsExportToggle}
        player={playerRef}
      />
      <DecodeHealthIndicator health={decodeHealth} hidden={isDiagnosticsVisible || isDiagnosticsExportVisible} />
      <PlaybackFailureNotice
        failure={failure}
        // Anything that owns the screen outranks it: the state is terminal and will still be there
        // when the viewer comes back, and stealing focus out from under a popup would be worse.
        hidden={isDiagnosticsVisible || isDiagnosticsExportVisible || isSettingsOpen || isEpisodesOpen}
        onRetry={handleRetry}
      />
      {controlsVisible && (
        <div className="absolute z-10 top-0 px-4 pt-2 flex items-center">
          <BackButton className="mr-2" />
          <Text>{title}</Text>
          {qualityLabel && <Text className="ml-3 px-2 py-0 text-xs font-bold rounded bg-gray-600 text-white">{qualityLabel}</Text>}
          {isHDR && <Text className="ml-3 px-2 py-0 text-xs font-bold rounded bg-yellow-600 text-black">HDR</Text>}
        </div>
      )}
      {controlsVisible && (
        <div className="absolute z-101 bottom-8 right-10 flex items-center">
          {seasons?.length && (
            <Button className="text-purple-500 mr-2" icon="list" onClick={handleEpisodesOpen}>
              Эпизоды
            </Button>
          )}
          <Button className="text-blue-600" icon="settings" onClick={handleSettingsOpen} />
        </div>
      )}
      {item && seasons?.length && (
        <EpisodePicker
          item={item}
          seasons={seasons}
          currentSeasonNumber={currentSeasonNumber}
          visible={isEpisodesOpen}
          onClose={handleEpisodesClose}
          onEpisodeSelect={onEpisodeSelect}
        />
      )}
      {isLoaded && startTime! > 0 && <StartFrom startTime={startTime} player={playerRef} />}

      <VideoPlayer
        {...props}
        //@ts-expect-error
        ref={playerRef}
        locale="ru"
        poster={poster}
        title={description}
        jumpBy={15}
        onPlay={handlePlay}
        onPause={handlePause}
        onEnded={handleEnded}
        onLoadedMetadata={handleLoadedMetadata}
        onControlsAvailable={handleControlsAvailable}
        streamingType={streamingType}
        isSettingsOpen={isSettingsOpen}
        audioTracks={audios}
        sourceTracks={sources}
        subtitleTracks={subtitles}
        videoComponent={<Media />}
      />
    </>
  );
};

export default Player;
