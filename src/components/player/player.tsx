import React, { useCallback, useEffect, useRef, useState } from 'react';
import VideoPlayer, { VideoPlayerBase, VideoPlayerBaseProps } from '@enact/moonstone/VideoPlayer';
import Spotlight from '@enact/spotlight';

import { Item, Season, Video } from 'api';
import BackButton from 'components/backButton';
import Button from 'components/button';
import EpisodePicker from 'components/episodePicker';
import Media, { AudioTrack, SourceTrack, StreamingType, SubtitleTrack } from 'components/media';
import Text from 'components/text';
import useButtonEffect from 'hooks/useButtonEffect';
import useStorageState from 'hooks/useStorageState';

import Settings from './settings';
import StartFrom from './startFrom';

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
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isPauseByOKClickActive] = useStorageState<boolean>('is_pause_by_ok_click_active');
  const [currentSourceName, setCurrentSourceName] = useState<string | null>(null);

  const activeSource = sources?.find((s) => s.name === currentSourceName) || sources?.find((s) => s.default) || sources?.[0];
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
        const video: any = playerRef.current.getVideoNode();
        video.playPause();
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
      const video: any = playerRef.current.getVideoNode();

      const currentTime = video['currentTime'];

      await onTimeSync(currentTime);
    }
  }, [onTimeSync, playerRef]);
  const handleLoadedMetadata = useCallback(() => {
    setIsLoaded(true);
  }, []);
  const handleSettingsOpen = useCallback(() => {
    if (playerRef.current) {
      setIsSettingsOpen(true);

      const video: any = playerRef.current.getVideoNode();
      video.pause();
    }
  }, [playerRef]);
  const handleSettingsClose = useCallback(() => {
    if (playerRef.current) {
      setIsSettingsOpen(false);

      const video: any = playerRef.current.getVideoNode();
      setCurrentSourceName(video.sourceTrack || null);
      video.play();
    }
  }, []);
  const handleEpisodesOpen = useCallback(() => {
    if (playerRef.current && seasons?.length) {
      setIsEpisodesOpen(true);

      const video: any = playerRef.current.getVideoNode();
      video.pause();
    }
  }, [playerRef, seasons]);
  const handleEpisodesClose = useCallback(() => {
    if (playerRef.current) {
      setIsEpisodesOpen(false);

      const video: any = playerRef.current.getVideoNode();
      video.play();
    }
  }, []);
  const handleControlsAvailable = useCallback((e: { available: boolean }) => {
    setControlsVisible(e.available);
  }, []);
  const handlePauseButton = useCallback(() => {
    if (playerRef.current) {
      const video: any = playerRef.current.getVideoNode();
      video.pause();
    }
  }, [playerRef]);

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

  useButtonEffect('Back', handleTimeSync);
  useButtonEffect('Blue', handleSettingsOpen);
  useButtonEffect('Play', handleSettingsClose);
  useButtonEffect('Pause', handlePauseButton);
  useButtonEffect('Enter', handlePlayPause);
  useButtonEffect('ArrowUp', handleSettingsOpen);

  return (
    <>
      <Settings visible={isSettingsOpen} onClose={handleSettingsClose} player={playerRef} />
      {controlsVisible && (
        <div className="absolute z-10 top-0 px-4 pt-2 flex items-center">
          <BackButton className="mr-2" />
          <Text>{title}</Text>
          {activeSource && <Text className="ml-3 px-2 py-0 text-xs font-bold rounded bg-gray-600 text-white">{activeSource.name}</Text>}
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
