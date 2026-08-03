import { useCallback, useEffect, useMemo, useState } from 'react';
import { VideoPlayerBase } from '@enact/moonstone/VideoPlayer';
import map from 'lodash/map';

import Button from 'components/button';
import { AudioTrack, SourceTrack, SubtitleTrack } from 'components/media';
import Popup from 'components/popup';
import Select from 'components/select';
import useStorageState from 'hooks/useStorageState';

import { getVideoNode } from './getVideoNode';

const NONE = 'NONE';

const SUBTITLE_OPACITY_OPTIONS = [
  { title: '100%', value: 1 },
  { title: '75%', value: 0.75 },
  { title: '50%', value: 0.5 },
  { title: '25%', value: 0.25 },
];

type Props = {
  visible: boolean;
  diagnosticsVisible: boolean;
  onClose: () => void;
  onDiagnosticsToggle: () => void;
  onDiagnosticsExport: () => void;
  player: React.MutableRefObject<VideoPlayerBase | undefined>;
};

const Settings: React.FC<Props> = ({ visible, diagnosticsVisible, onClose, onDiagnosticsToggle, onDiagnosticsExport, player }) => {
  const [isOpen, setIsOpen] = useState(visible);
  const [audios, setAudios] = useState<AudioTrack[]>([]);
  const [currentAudio, setCurrentAudio] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceTrack[]>([]);
  const [currentSource, setCurrentSource] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<string | null>(NONE);
  const [subtitleOpacity, setSubtitleOpacity] = useStorageState<number>('subtitle_opacity', 1);

  const audioOptions = useMemo(() => map(audios, (audio) => ({ title: `${audio.number} ${audio.name}`, value: audio.name })), [audios]);
  const sourceOptions = useMemo(() => map(sources, (source) => ({ title: source.name, value: source.name })), [sources]);
  const subtitleOptions = useMemo(
    () => [
      { title: 'Нет', value: NONE },
      ...map(subtitles, (subtitle) => ({ title: `${subtitle.number} ${subtitle.name}`, value: subtitle.name })),
    ],
    [subtitles],
  );

  const handleVideoUpdate = useCallback(
    (name: string, value: string) => {
      if (player.current) {
        const video: any = getVideoNode(player.current);

        if (video) {
          video[name] = value;
        }
      }
    },
    [player],
  );

  const handleAudioChange = useCallback(
    (audio: string) => {
      setCurrentAudio(audio);
      handleVideoUpdate('audioTrack', audio);
    },
    [handleVideoUpdate],
  );
  const handleSourceChange = useCallback(
    (source: string) => {
      setCurrentSource(source);
      handleVideoUpdate('sourceTrack', source);
    },
    [handleVideoUpdate],
  );
  const handleSubtitleChange = useCallback(
    (subtitle: string) => {
      setCurrentSubtitle(subtitle);
      handleVideoUpdate('subtitleTrack', subtitle);
    },
    [handleVideoUpdate],
  );
  const handleSubtitleOpacityChange = useCallback(
    (opacity: number) => {
      setSubtitleOpacity(opacity);
    },
    [setSubtitleOpacity],
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);
  const handleDiagnosticsToggle = useCallback(() => {
    onDiagnosticsToggle();
    handleClose();
  }, [onDiagnosticsToggle, handleClose]);
  const handleDiagnosticsExport = useCallback(() => {
    onDiagnosticsExport();
    handleClose();
  }, [onDiagnosticsExport, handleClose]);

  useEffect(() => {
    if (visible && player.current) {
      const video = getVideoNode(player.current);

      if (!video) {
        return;
      }

      const { audioTracks, audioTrack, sourceTracks, sourceTrack, subtitleTracks, subtitleTrack } = video;

      setAudios(audioTracks || []);
      setCurrentAudio(audioTrack || null);

      setSources(sourceTracks || []);
      setCurrentSource(sourceTrack || null);

      setSubtitles(subtitleTracks || []);
      setCurrentSubtitle(subtitleTrack || NONE);
    }
  }, [visible, player]);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    if (visible) {
      timeoutId = setTimeout(() => {
        setIsOpen(true);
      }, 100);
    } else {
      setIsOpen(false);
    }

    return () => {
      clearTimeout(timeoutId);
    };
  }, [visible]);

  return (
    <Popup visible={isOpen} onClose={handleClose}>
      {audioOptions.length > 1 && (
        <Select className="my-1" label="Звук" value={currentAudio} options={audioOptions} onChange={handleAudioChange} splitIn={2} />
      )}
      {sourceOptions.length > 1 && (
        <Select className="my-1" label="Качество" value={currentSource} options={sourceOptions} onChange={handleSourceChange} splitIn={4} />
      )}
      {subtitleOptions.length > 1 && (
        <Select
          className="my-1"
          label="Субтитры"
          value={currentSubtitle}
          options={subtitleOptions}
          onChange={handleSubtitleChange}
          splitIn={4}
        />
      )}
      {subtitleOptions.length > 1 && (
        <Select
          className="my-1"
          label="Яркость субтитров"
          value={subtitleOpacity ?? 1}
          options={SUBTITLE_OPACITY_OPTIONS}
          onChange={handleSubtitleOpacityChange}
          splitIn={4}
        />
      )}
      <Button className="my-2 text-green-500" icon="bug_report" onClick={handleDiagnosticsToggle}>
        {diagnosticsVisible ? 'Скрыть диагностику воспроизведения' : 'Диагностика воспроизведения'}
      </Button>
      <Button className="my-2 text-green-500" icon="bug_report" onClick={handleDiagnosticsExport}>
        Экспорт диагностики (QR)
      </Button>
    </Popup>
  );
};

export default Settings;
