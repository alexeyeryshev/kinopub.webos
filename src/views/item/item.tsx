import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import map from 'lodash/map';

import { Bool, Season, Video, WatchingStatus } from 'api';
import Button from 'components/button';
import EpisodePicker from 'components/episodePicker';
import ItemsList from 'components/itemsList';
import Link from 'components/link';
import Popup from 'components/popup';
import Scrollable from 'components/scrollable';
import SeasonsList from 'components/seasonsList';
import Seo from 'components/seo';
import Spottable from 'components/spottable';
import Text from 'components/text';
import VideoItem from 'components/videoItem';
import Bookmarks from 'containers/bookmarks';
import useApi from 'hooks/useApi';
import useApiMutation from 'hooks/useApiMutation';
import useButtonEffect from 'hooks/useButtonEffect';
import useStreamingTypeEffect from 'hooks/useStreamingTypeEffect';
import { PATHS, RouteParams, generatePath } from 'routes';

import { secondsToDuration } from 'utils/date';
import { getItemTitle, getItemVideoToPlay } from 'utils/item';
import { mapAudios, mapSubtitles } from 'utils/video';

const SimilarItems: React.FC<{ itemId: string; className?: string }> = ({ itemId, className }) => {
  const { data } = useApi('itemSmiliar', [itemId]);

  if (data && data.items?.length > 0) {
    return (
      <div className={className}>
        <ItemsList title="Похожие" titleClassName="text-gray-500" items={data.items} scrollable={false} />
      </div>
    );
  }

  return null;
};

const ItemView: React.FC = () => {
  const history = useHistory();
  const { itemId } = useParams<RouteParams>();
  const posterRef = useRef<HTMLImageElement>(null);
  const [bookmarksPopupVisible, setBookmarksPopupVisible] = useState(false);
  const [episodePickerVisible, setEpisodePickerVisible] = useState(false);
  const { data, refetch } = useApi('itemMedia', [itemId!], { staleTime: 0 });
  const { data: watchingData, refetch: refetchWatching } = useApi('watchingItem', [itemId!], { staleTime: 0 });

  const { watchingToggleAsync } = useApiMutation('watchingToggle');
  const { watchingToggleWatchlistAsync } = useApiMutation('watchingToggleWatchlist');
  const { watchingMarkTimeAsync } = useApiMutation('watchingMarkTime');

  // Merge watching data from /v1/watching into item data
  // The watching API returns {status, time} at top level, not nested under "watching"
  const itemWithWatching = useMemo(() => {
    if (!data?.item) return data?.item;
    if (!watchingData?.item) return data.item;

    const item = { ...data.item };

    if (item.seasons && watchingData.item.seasons) {
      item.seasons = item.seasons.map((season) => {
        const ws = watchingData.item.seasons?.find((s: any) => s.number === season.number);
        if (!ws) return season;

        return {
          ...season,
          watched: (ws as any).status ?? season.watched,
          watching: { status: (ws as any).status ?? season.watching?.status, time: (ws as any).time ?? season.watching?.time },
          episodes: season.episodes.map((episode) => {
            const we = ws.episodes?.find((e: any) => e.number === episode.number);
            if (!we) return episode;

            return {
              ...episode,
              watched: (we as any).status ?? episode.watched,
              watching: { status: (we as any).status ?? episode.watching?.status, time: (we as any).time ?? episode.watching?.time },
            };
          }),
        };
      });
    } else if (item.videos && watchingData.item.videos) {
      item.videos = item.videos.map((video) => {
        const wv = watchingData.item.videos?.find((v: any) => v.number === video.number);
        if (!wv) return video;

        return {
          ...video,
          watched: (wv as any).status ?? video.watched,
          watching: { status: (wv as any).status ?? video.watching?.status, time: (wv as any).time ?? video.watching?.time },
        };
      });
    }

    return item;
  }, [data?.item, watchingData?.item]);

  const trailer = useMemo(() => data?.item.trailer, [data?.item]);
  const [videoToPlay, season] = useMemo(() => getItemVideoToPlay(itemWithWatching), [itemWithWatching]);
  const title = useMemo(() => getItemTitle(data?.item, videoToPlay, season), [data?.item, season, videoToPlay]);
  const durationAverage = useMemo(() => secondsToDuration(data?.item?.duration?.average), [data?.item]);
  const durationTotal = useMemo(() => secondsToDuration(data?.item?.duration?.total), [data?.item]);
  const audios = useMemo(() => mapAudios(videoToPlay?.audios || []), [videoToPlay]);
  const subtitles = useMemo(() => mapSubtitles(videoToPlay?.subtitles || []), [videoToPlay]);
  const isSerial = useMemo(() => Boolean(data?.item?.seasons), [data?.item]);
  const isWatching = useMemo(
    () => (isSerial ? data?.item?.subscribed : videoToPlay?.watching.status === WatchingStatus.Watching),
    [data?.item, isSerial, videoToPlay],
  );

  const handleOnPlayClick = useCallback(() => {
    if (itemWithWatching) {
      history.push(
        generatePath(PATHS.Video, {
          itemId: itemWithWatching.id,
        }),
        {
          item: itemWithWatching,
        },
      );
    }
  }, [history, itemWithWatching]);

  const handleOnTrailerClick = useCallback(() => {
    if (trailer?.id) {
      history.push(
        generatePath(PATHS.Trailer, {
          trailerId: trailer.id,
        }),
        {
          item: data?.item,
          trailer,
        },
      );
    }
  }, [history, data?.item, trailer]);

  const handleOnBookmarksClick = useCallback(() => {
    setBookmarksPopupVisible(true);
  }, []);
  const handleBookmarksPopupClose = useCallback(() => {
    setBookmarksPopupVisible(false);
  }, []);
  const handleOnEpisodesClick = useCallback(() => {
    setEpisodePickerVisible(true);
  }, []);
  const handleEpisodePickerClose = useCallback(() => {
    setEpisodePickerVisible(false);
  }, []);
  const refetchAll = useCallback(() => {
    refetch();
    refetchWatching();
  }, [refetch, refetchWatching]);
  const handleSeasonToggle = useCallback(
    async (season?: Season | null) => {
      await watchingToggleAsync([itemId!, undefined, season?.number]);
      refetchAll();
    },
    [itemId, refetchAll, watchingToggleAsync],
  );
  const handleEpisodeToggle = useCallback(
    async (episode: Video, season?: Season | null) => {
      await watchingToggleAsync([itemId!, episode.number, season?.number]);
      refetchAll();
    },
    [itemId, refetchAll, watchingToggleAsync],
  );

  const handleOnVisibilityClick = useCallback(async () => {
    if (isSerial) {
      await watchingToggleWatchlistAsync([itemId!]);
    } else {
      if (isWatching) {
        await watchingToggleAsync([itemId!, videoToPlay.number, 0, Bool.False]);
      } else {
        await watchingMarkTimeAsync([itemId!, 30, videoToPlay.number]);
      }
    }
    refetchAll();
  }, [itemId, isSerial, isWatching, videoToPlay, watchingToggleWatchlistAsync, watchingToggleAsync, watchingMarkTimeAsync, refetchAll]);

  useEffect(() => {
    requestAnimationFrame(() => {
      posterRef.current?.scrollIntoView();
    });
  }, [history.location.pathname]);

  useStreamingTypeEffect();
  useButtonEffect(['Play', 'Red'], handleOnPlayClick);
  useButtonEffect('Green', handleOnTrailerClick);
  useButtonEffect('Yellow', handleOnBookmarksClick);
  useButtonEffect('Blue', handleOnVisibilityClick);

  return (
    <>
      <Seo title={`Просмотр: ${title}`} />
      <Scrollable>
        <div className="relative w-screen h-screen">
          <Spottable />
          <img
            ref={posterRef}
            className="absolute w-screen h-screen object-cover -z-1"
            src={(data?.item?.posters.wide || data?.item?.posters.big)!}
            alt={title}
          />

          {data?.item && (
            <div className="absolute flex p-4 bottom-0 left-0 right-0 bg-black bg-opacity-70">
              <Button icon="play_circle_outline" onClick={handleOnPlayClick} className="text-red-600">
                Смотреть{isSerial ? ` s${videoToPlay.snumber}e${videoToPlay.number}` : ''}
              </Button>

              {isSerial && data?.item?.seasons && (
                <Button icon="list" onClick={handleOnEpisodesClick} className="text-purple-500">
                  Эпизоды
                </Button>
              )}

              <Button icon="bookmark" onClick={handleOnBookmarksClick} className="text-yellow-600">
                В закладки
              </Button>

              <Popup visible={bookmarksPopupVisible} onClose={handleBookmarksPopupClose} closeButton="Yellow">
                <Bookmarks key={`${itemId}-${bookmarksPopupVisible}`} itemId={itemId!} />
              </Popup>

              {isSerial && itemWithWatching?.seasons && (
                <EpisodePicker
                  item={itemWithWatching}
                  seasons={itemWithWatching.seasons}
                  visible={episodePickerVisible}
                  onClose={handleEpisodePickerClose}
                />
              )}

              {trailer ? (
                <Button icon="videocam" onClick={handleOnTrailerClick} className="text-green-600">
                  Трейлер
                </Button>
              ) : (
                <div />
              )}

              <Button icon={isWatching ? 'visibility_off' : 'visibility'} onClick={handleOnVisibilityClick} className="text-blue-600">
                {isWatching ? 'Не буду смотреть' : 'Буду смотреть'}
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col p-6">
          <div className="flex pb-6">
            <div className="flex flex-shrink-0 items-start w-58 pr-8">
              <VideoItem item={data?.item} wrapperClassName="w-full" showViews noCaption disableNavigation />
            </div>

            <div className="flex flex-col">
              <Text className="text-2xl">{data?.item?.title}</Text>
              <div className="flex items-center">
                <Text className="text-gray-500">
                  {data?.item?.year}
                  {map(data?.item?.countries, (country) => (
                    <span key={country.id} className="ml-2">
                      {country.title}
                    </span>
                  ))}
                </Text>
                {isSerial && !data?.item?.finished && (
                  <Text className="ml-2 px-3 text-xs rounded-xl border-gray-200 border-2 bg-red-700">ON AIR</Text>
                )}
              </div>

              {!!data?.item?.genres?.length && (
                <div className="flex py-2">
                  {map(data?.item?.genres, (genre) => (
                    <Link
                      key={genre.id}
                      href={generatePath(PATHS.Category, { categoryType: data?.item?.type }, { genre: genre.id })}
                      className="border-2 border-gray-200 rounded-xl px-2 mr-2"
                    >
                      {genre.title}
                    </Link>
                  ))}
                </div>
              )}

              {(durationTotal || durationAverage) && (
                <div className="py-2">
                  <Text className="text-gray-500">Длительность</Text>
                  <div className="flex">
                    {durationTotal === durationAverage ? (
                      <Text className="pl-2">{durationTotal}</Text>
                    ) : (
                      <>
                        <div className="flex mr-2">
                          <Text className="text-gray-500 mr-2">Серия:</Text>
                          <Text>≈{durationAverage}</Text>
                        </div>
                        <div className="flex mr-2">
                          <Text className="text-gray-500 mr-2">Сериал:</Text>
                          <Text>{durationTotal}</Text>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {data?.item?.plot && (
                <div className="py-2">
                  <Text className="text-gray-500">Описание</Text>
                  <Text className="text-gray-300 pl-2">{data?.item?.plot}</Text>
                </div>
              )}

              {audios.length > 0 && (
                <div className="py-2">
                  <Text className="text-gray-500">Перевод</Text>
                  <div className="flex flex-wrap pl-2">
                    {map(audios, (voice, idx) => (
                      <Text className="w-1/2" key={idx}>
                        {voice.name}
                      </Text>
                    ))}
                  </div>
                </div>
              )}

              {subtitles.length > 0 && (
                <div className="py-2">
                  <Text className="text-gray-500">Субтитры</Text>
                  <div className="flex flex-wrap pl-2">
                    {map(subtitles, (subtitle, idx) => (
                      <Text className="w-1/6" key={idx}>
                        {subtitle.name}
                      </Text>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {!!data?.item?.tracklist?.length && (
            <div className="flex flex-col pb-6">
              <Text className="text-gray-500">Треклист</Text>
              <div className="flex flex-wrap flex-col">
                {map(data?.item.tracklist, (track, idx) => (
                  <Text key={idx}>
                    {idx + 1}. {track.title}
                  </Text>
                ))}
              </div>
            </div>
          )}

          <SeasonsList
            className="pb-6"
            item={itemWithWatching!}
            seasons={itemWithWatching?.seasons}
            onSeasonToggle={handleSeasonToggle}
            onEpisodeToggle={handleEpisodeToggle}
          />

          {(data?.item?.director || data?.item?.cast) && (
            <div className="flex pb-6">
              {data?.item?.director && (
                <div className="flex-shrink-0 w-58 pr-8">
                  <Text className="text-gray-500">Создатели</Text>
                  {map(data?.item?.director.split(', '), (director) => (
                    <Link key={director} href={generatePath(PATHS.Search, null, { q: director, mode: 'director' })}>
                      {director}
                    </Link>
                  ))}
                </div>
              )}
              {data?.item?.cast && (
                <div className="flex flex-col">
                  <Text className="text-gray-500">В ролях</Text>
                  <div className="flex flex-wrap">
                    {map(data?.item?.cast.split(', '), (actor, idx, arr) => (
                      <Link key={actor} href={generatePath(PATHS.Search, null, { q: actor, mode: 'actor' })}>
                        {actor}
                        {idx !== arr.length - 1 && ', '}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <SimilarItems className="pb-6" itemId={itemId!} />
        </div>
      </Scrollable>
    </>
  );
};

export default ItemView;
