import { useCallback, useMemo } from 'react';
import { useHistory } from 'react-router-dom';
import dayjs from 'dayjs';

import { Item, ItemsParams } from 'api';
import ItemsList from 'components/itemsList';
import Link from 'components/link';
import Scrollable from 'components/scrollable';
import Seo from 'components/seo';
import Spottable from 'components/spottable';
import Text from 'components/text';
import VideoItem from 'components/videoItem';
import useApi from 'hooks/useApi';
import { PATHS, generatePath } from 'routes';

const ItemsSection: React.FC<{ title: string; params: ItemsParams }> = ({ title, params }) => {
  const { data, isLoading } = useApi('items', [params, 0, 5]);
  const href = useMemo(() => generatePath(PATHS.Category, { categoryType: params.type }), [params]);

  return (
    <div className="pb-2">
      <ItemsList
        title={
          <Link href={href} state={{ params, title }} className="w-full">
            {title}
          </Link>
        }
        titleClassName="ml-0"
        items={data?.items}
        loading={isLoading}
        scrollable={false}
      />
    </div>
  );
};

/**
 * Граница окна для подборок «Популярные».
 *
 * Считаем на монтировании, а не на загрузке модуля: приложение на телевизоре не перезапускают
 * неделями, и окно иначе застывает на дате запуска. Мемоизация обязательна — значение попадает
 * в ключ запроса, и пересчёт на каждый рендер запускал бы перезагрузку подборок раз в секунду
 */
function useMonthAgo() {
  return useMemo(() => dayjs().add(-1, 'month').unix(), []);
}

const PopularMovies: React.FC = () => {
  const monthAgo = useMonthAgo();

  return <ItemsSection title="Популярные фильмы" params={{ type: 'movie', sort: 'views-', conditions: [`created>=${monthAgo}`] }} />;
};

const NewMovies: React.FC = () => {
  return <ItemsSection title="Новые фильмы" params={{ type: 'movie', sort: 'created-' }} />;
};

const PopularSerials: React.FC = () => {
  const monthAgo = useMonthAgo();

  return <ItemsSection title="Популярные сериалы" params={{ type: 'serial', sort: 'watchers-', conditions: [`updated>=${monthAgo}`] }} />;
};

const NewSerials: React.FC = () => {
  return <ItemsSection title="Новые сериалы" params={{ type: 'serial', sort: 'created-' }} />;
};

const NewConcerts: React.FC = () => {
  return <ItemsSection title="Новые концерты" params={{ type: 'concert', sort: 'created-' }} />;
};

const NewDocuMovies: React.FC = () => {
  return <ItemsSection title="Новые документальные фильмы" params={{ type: 'documovie', sort: 'created-' }} />;
};

const NewDocuSerials: React.FC = () => {
  return <ItemsSection title="Новые документальные сериалы" params={{ type: 'docuserial', sort: 'created-' }} />;
};

const NewTVShows: React.FC = () => {
  return <ItemsSection title="Новые ТВ шоу" params={{ type: 'tvshow', sort: 'created-' }} />;
};

const CONTINUE_WATCHING_LIMIT = 4;

// Доля длительности, после которой считаем серию/фильм досмотренными и не предлагаем продолжить
const WATCHED_THRESHOLD = 0.9;

const ContinueWatching: React.FC = () => {
  const history = useHistory();
  // История — единственный источник, который знает, где именно остановился просмотр:
  // в /watching лежат сериалы с новыми эпизодами, а не то, что смотрели последним.
  // perpage ограничен 50 (максимум по документации API)
  const { data: historyData, isLoading: historyLoading } = useApi('history', [1, 50]);
  const { data: serials, isLoading: serialsLoading } = useApi('watchingSerials');
  const { data: movies, isLoading: moviesLoading } = useApi('watchingMovies');

  const items = useMemo(() => {
    // Счётчик недосмотренных эпизодов отдаёт только /watching, в истории его нет
    const episodesLeft = new Map<string, Item['new']>();

    for (const item of [...(serials?.items || []), ...(movies?.items || [])]) {
      episodesLeft.set(item.id, item.new);
    }

    const seen = new Set<string>();
    const ordered: Item[] = [];

    for (const record of historyData?.history || []) {
      const item = record.item;

      if (!item?.id || seen.has(item.id)) {
        continue;
      }

      // В /v1/history у media нет поля watching: позиция остановки лежит в самой записи,
      // поэтому недосмотренность считаем по record.time и длительности
      const duration = record.media?.duration || 0;
      const isInProgress = record.time > 0 && (!duration || record.time < duration * WATCHED_THRESHOLD);
      const left = episodesLeft.get(item.id);

      if (!isInProgress && !left) {
        continue;
      }

      seen.add(item.id);
      ordered.push({ ...item, new: left });
    }

    return ordered.slice(0, CONTINUE_WATCHING_LIMIT);
  }, [historyData?.history, serials?.items, movies?.items]);

  const isLoading = historyLoading || serialsLoading || moviesLoading;

  const handleShowAll = useCallback(() => {
    history.push(generatePath(PATHS.Watching, { watchingType: 'serials' }));
  }, [history]);

  if (!isLoading && items.length === 0) return null;

  return (
    <div className="pb-2 pt-4">
      <div className="flex flex-wrap">
        {items.map((item) => (
          <VideoItem key={item.id} item={item} />
        ))}
        <Spottable className="rounded-xl w-1/5 cursor-pointer" onClick={handleShowAll}>
          <div className="h-72 m-1 flex flex-col items-center justify-center rounded-xl border-2 border-gray-700 bg-black bg-opacity-50">
            <Text className="text-4xl text-gray-200 mb-2">▶</Text>
            <Text className="text-gray-200 text-sm">Продолжить просмотр</Text>
          </div>
        </Spottable>
      </div>
    </div>
  );
};

const HomeView: React.FC = () => {
  return (
    <>
      <Seo title="Главная" />
      <Scrollable>
        <ContinueWatching />

        <PopularSerials />

        <NewSerials />

        <PopularMovies />

        <NewMovies />

        <NewDocuSerials />

        <NewDocuMovies />

        <NewTVShows />

        <NewConcerts />
      </Scrollable>
    </>
  );
};

export default HomeView;
