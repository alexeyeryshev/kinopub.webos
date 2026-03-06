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
      // Find the latest season with any activity, then pick the next episode
      // after the highest-numbered episode that has been watched or started.
      let activeSeason: Season | undefined;
      let lastActiveIdx = -1;

      for (const s of item.seasons) {
        for (let i = s.episodes.length - 1; i >= 0; i--) {
          if (s.episodes[i].watching?.status !== WatchingStatus.NoWatched) {
            if (!activeSeason || s.number > activeSeason.number) {
              activeSeason = s;
              lastActiveIdx = i;
            }
            break;
          }
        }
      }

      if (activeSeason && lastActiveIdx >= 0) {
        const lastActive = activeSeason.episodes[lastActiveIdx];
        if (lastActive.watching?.status === WatchingStatus.Watched) {
          // Last active episode fully watched — suggest next one
          if (lastActiveIdx + 1 < activeSeason.episodes.length) {
            season = activeSeason;
            episode = activeSeason.episodes[lastActiveIdx + 1];
          } else {
            const nextSeason = item.seasons.find(({ number }) => number === activeSeason!.number + 1);
            if (nextSeason) {
              season = nextSeason;
              episode = nextSeason.episodes[0];
            } else {
              season = activeSeason;
              episode = lastActive;
            }
          }
        } else {
          // In-progress — resume this episode
          season = activeSeason;
          episode = lastActive;
        }
      } else {
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
