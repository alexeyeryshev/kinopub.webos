import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHistory } from 'react-router-dom';
import Spotlight from '@enact/spotlight';
import cx from 'classnames';

import { Item, Season, Video, WatchingStatus } from 'api';
import SpotlightContainer from 'components/spotlightContainer';
import Spottable from 'components/spottable';
import Text from 'components/text';
import useButtonEffect from 'hooks/useButtonEffect';
import useHashTrigger from 'hooks/useHashTrigger';
import { PATHS, generatePath } from 'routes';

import { secondsToDuration } from 'utils/date';

type Props = {
  item: Item;
  seasons: Season[];
  visible: boolean;
  onClose: () => void;
  onEpisodeSelect?: (episode: Video, season: Season) => void;
};

const EpisodePicker: React.FC<Props> = ({ item, seasons, visible, onClose, onEpisodeSelect }) => {
  const history = useHistory();
  const [selectedSeasonIdx, setSelectedSeasonIdx] = useState(0);
  const containerId = useMemo(() => Spotlight.add({}), []);

  const selectedSeason = seasons[selectedSeasonIdx];
  const episodes = selectedSeason?.episodes || [];

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleCloseIfVisible = useCallback(() => {
    if (visible) {
      handleClose();
      return false;
    }
  }, [visible, handleClose]);

  const handleSeasonFocus = useCallback(
    (idx: number) => () => {
      setSelectedSeasonIdx(idx);
    },
    [],
  );

  const handleEpisodeClick = useCallback(
    (episode: Video) => () => {
      if (episode?.id) {
        if (onEpisodeSelect) {
          onEpisodeSelect(episode, selectedSeason);
          onClose();
        } else {
          history.push(
            generatePath(PATHS.Video, { itemId: item.id }, { episodeId: `${episode.number}`, seasonId: `${selectedSeason.number}` }),
            { item },
          );
        }
      }
    },
    [item, selectedSeason, history, onEpisodeSelect, onClose],
  );

  const spotContent = useCallback(() => {
    if (!Spotlight.focus(containerId)) {
      const current = Spotlight.getCurrent();
      if (current) {
        // @ts-expect-error
        current.blur();
      }
      Spotlight.setActiveContainer(containerId);
      setTimeout(() => {
        Spotlight.setPointerMode(false);
        Spotlight.focus(containerId);
      }, 500);
    }
  }, [containerId]);

  const scrollActiveElementIntoView = useCallback(() => {
    const current = Spotlight.getCurrent();
    requestAnimationFrame(() => {
      // @ts-expect-error
      current?.scrollIntoViewIfNeeded();
    });
  }, []);

  useButtonEffect('Back', handleCloseIfVisible);
  useButtonEffect('ArrowUp', scrollActiveElementIntoView);
  useButtonEffect('ArrowDown', scrollActiveElementIntoView);
  const hashTrigger = useHashTrigger('episodes', handleCloseIfVisible);

  useEffect(() => {
    if (visible) {
      spotContent();
      hashTrigger.open();
    } else {
      hashTrigger.close();
    }
  }, [visible, spotContent, hashTrigger]);

  return (
    <>
      <div
        className={cx('fixed z-999 top-0 left-0 right-0 bottom-0 bg-black bg-opacity-70', {
          hidden: !visible,
        })}
        onClick={handleClose}
      />
      <SpotlightContainer
        spotlightId={containerId}
        spotlightRestrict="self-only"
        spotlightDisabled={!visible}
        className={cx('fixed z-999 top-0 left-0 right-0 bottom-0 flex', {
          hidden: !visible,
        })}
      >
        <div className="flex w-full h-full p-8">
          {/* Seasons column */}
          <div className="flex flex-col w-48 flex-shrink-0 overflow-y-auto pr-4 border-r border-gray-700">
            <Text className="text-gray-500 mb-2 text-sm">Сезоны</Text>
            {seasons.map((season, idx) => (
              <Spottable
                key={season.id}
                className={cx(
                  'px-3 py-2 rounded cursor-pointer whitespace-nowrap text-sm',
                  idx === selectedSeasonIdx ? 'bg-white bg-opacity-20 text-white' : 'text-gray-400',
                )}
                onFocus={handleSeasonFocus(idx)}
              >
                <div className="flex items-center justify-between">
                  <Text>{season.title || `Сезон ${season.number}`}</Text>
                  {season.watched === WatchingStatus.Watched && <Text className="text-green-500 ml-2 text-xs">✓</Text>}
                </div>
              </Spottable>
            ))}
          </div>

          {/* Episodes column */}
          <div className="flex flex-col flex-1 overflow-y-auto pl-4">
            <Text className="text-gray-500 mb-2 text-sm">{selectedSeason?.title || `Сезон ${selectedSeason?.number}`}</Text>
            {episodes.map((episode) => (
              <Spottable
                key={episode.id}
                className={cx(
                  'px-3 py-1 rounded cursor-pointer text-sm',
                  episode.watched === WatchingStatus.Watched ? 'text-gray-500' : 'text-gray-200',
                )}
                onClick={handleEpisodeClick(episode)}
              >
                <div className="flex items-center">
                  {episode.thumbnail && (
                    <img
                      loading="lazy"
                      src={episode.thumbnail}
                      alt={episode.title}
                      className="w-24 h-14 object-cover rounded flex-shrink-0 mr-3"
                    />
                  )}
                  <div className="flex items-center justify-between flex-1 min-w-0">
                    <div className="flex items-center flex-1 min-w-0">
                      <Text className="flex-shrink-0 w-8 text-gray-500">{episode.number}</Text>
                      <Text className="truncate">{episode.title || `Эпизод ${episode.number}`}</Text>
                    </div>
                    <div className="flex items-center flex-shrink-0 ml-4">
                      {episode.duration > 0 && <Text className="text-gray-400 text-xs mr-3">{secondsToDuration(episode.duration)}</Text>}
                      {episode.watched === WatchingStatus.Watched && <Text className="text-green-500 text-xs">✓</Text>}
                      {episode.watching?.status === WatchingStatus.Watching && <Text className="text-yellow-500 text-xs">▶</Text>}
                    </div>
                  </div>
                </div>
              </Spottable>
            ))}
          </div>
        </div>
      </SpotlightContainer>
    </>
  );
};

export default EpisodePicker;
