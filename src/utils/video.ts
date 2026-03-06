import filter from 'lodash/filter';
import map from 'lodash/map';
import orderBy from 'lodash/orderBy';
import toUpper from 'lodash/toUpper';

import { Audio, Streaming, Subtitle } from 'api';
import { AudioTrack, SourceTrack, SubtitleTrack } from 'components/media';

const formatIdx = (idx: number) => (idx < 10 ? `0${idx}` : idx);

export function mapAudios(audios: Audio[], ac3ByDefault?: boolean, savedAudioName?: string, defaultAudioLang?: string): AudioTrack[] {
  const tracks = map(audios, (audio, idx) => {
    const name = filter([
      audio.type?.title && audio.author?.title ? `${audio.type?.title}.` : audio.type?.title,
      audio.author?.title,
      audio.type?.title || audio.author?.title ? `(${toUpper(audio.lang)})` : toUpper(audio.lang),
      audio.codec === 'ac3' && toUpper(audio.codec),
    ]).join(' ');
    const number = `${formatIdx(idx + 1)}.`;

    return {
      name,
      number,
      lang: audio.lang,
      default: (savedAudioName && savedAudioName === name) || (!savedAudioName && ac3ByDefault && audio.codec === 'ac3'),
    };
  });

  // If no track selected yet and defaultAudioLang is set, select first matching lang
  if (!tracks.some((t) => t.default) && defaultAudioLang) {
    const match = tracks.find((t) => t.lang === defaultAudioLang);
    if (match) match.default = true;
  }

  return tracks;
}

export function mapSources(
  files: { url: string | { [key in Streaming]?: string }; quality?: string; codec?: string }[],
  streamingType?: Streaming,
  savedSourceName?: string,
  defaultQuality?: string,
): SourceTrack[] {
  const sorted = orderBy(
    map(files, (file) => {
      const src = (typeof file.url === 'string' ? file.url : file.url[streamingType!] || file.url.http!) as string;
      const name = file.quality!;

      return {
        src,
        name,
        codec: file.codec,
        type: src.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4',
        default: false,
      };
    }),
    ({ name }) => parseInt(name),
    'desc',
  );

  // Priority: per-item saved source > default quality setting > first (highest)
  const hasSaved = savedSourceName && sorted.some((s) => s.name === savedSourceName);
  sorted.forEach((source) => {
    if (hasSaved) {
      source.default = source.name === savedSourceName;
    } else if (defaultQuality && defaultQuality !== 'best') {
      source.default = source.name === defaultQuality;
    }
  });

  // "best" or no match: mark the first (highest quality) as default
  if (!sorted.some((s) => s.default) && sorted.length > 0) {
    sorted[0].default = true;
  }

  return sorted;
}

export function mapSubtitles(
  subtitles: Subtitle[],
  forcedByDefault?: boolean,
  savedSubtitleName?: string,
  defaultSubtitleLang?: string,
): SubtitleTrack[] {
  const tracks = map(subtitles, (subtitle, idx) => {
    const name = `${toUpper(subtitle.lang)}${subtitle.forced ? ' Forced' : ''}`;
    const number = `${formatIdx(idx + 1)}.`;

    return {
      name,
      number,
      src: subtitle.url,
      lang: subtitle.lang,
      default:
        (savedSubtitleName && savedSubtitleName === name) ||
        (!savedSubtitleName && forcedByDefault && subtitle.forced && subtitle.lang === 'rus'),
    };
  });

  // If no track selected yet and defaultSubtitleLang is set, select first matching lang
  if (!tracks.some((t) => t.default) && defaultSubtitleLang) {
    const match = tracks.find((t) => t.lang === defaultSubtitleLang);
    if (match) match.default = true;
  }

  return tracks;
}
