import { ItemDetails, Season, Video, WatchingStatus } from 'api';

export function getItemVideoToPlay(item?: ItemDetails, episodeId?: string, seasonId?: string) {
  const video =
    item?.videos?.find(({ number, watching }) => (episodeId ? +episodeId === +number : watching.status !== WatchingStatus.Watched)) ||
    item?.videos?.[0];

  // Find the next episode after the last watched one
  let season: Season | undefined;
  let episode: Video | undefined;

  if (item?.seasons) {
    if (seasonId) {
      season = item.seasons.find(({ number }) => +seasonId === +number);
      episode = season?.episodes.find(({ number }) => (episodeId ? +episodeId === +number : false)) || season?.episodes[0];
    } else if (episodeId) {
      season = item.seasons[0];
      episode = season?.episodes.find(({ number }) => +episodeId === +number) || season?.episodes[0];
    } else {
      // Find the last watched episode across all seasons, then return the next one
      let lastWatchedSeason: Season | undefined;
      let lastWatchedEpisodeIdx = -1;

      for (const s of item.seasons) {
        for (let i = 0; i < s.episodes.length; i++) {
          if (s.episodes[i].watching.status === WatchingStatus.Watched) {
            lastWatchedSeason = s;
            lastWatchedEpisodeIdx = i;
          }
        }
      }

      if (lastWatchedSeason && lastWatchedEpisodeIdx >= 0) {
        // Try next episode in the same season
        if (lastWatchedEpisodeIdx + 1 < lastWatchedSeason.episodes.length) {
          season = lastWatchedSeason;
          episode = lastWatchedSeason.episodes[lastWatchedEpisodeIdx + 1];
        } else {
          // Try first episode of the next season
          const nextSeason = item.seasons.find(({ number }) => number === lastWatchedSeason!.number + 1);
          if (nextSeason) {
            season = nextSeason;
            episode = nextSeason.episodes[0];
          } else {
            // All watched, fall back to last episode
            season = lastWatchedSeason;
            episode = lastWatchedSeason.episodes[lastWatchedEpisodeIdx];
          }
        }
      } else {
        // Nothing watched yet, start from the beginning
        season = item.seasons[0];
        episode = season?.episodes[0];
      }
    }
  }

  return [(video || episode)!, season] as const;
}

export function getItemTitle(item?: ItemDetails, video?: Video, season?: Season) {
  const title = item?.title || '';

  return season ? `${title} (s${video?.snumber || 1}e${video?.number || 1})` : title;
}

export function getItemDescription(item?: ItemDetails, video?: Video, season?: Season) {
  const title = video?.title || '';
  const episode = `s${video?.snumber || 1}e${video?.number || 1}`;

  return season ? (title ? `${title} (${episode})` : episode) : title;
}

export function getItemQualityIcon(item?: ItemDetails) {
  return item?.quality ? (item.quality === 2160 ? '4k' : item.quality === 1080 || item.quality === 720 ? 'hd' : 'sd') : null;
}
