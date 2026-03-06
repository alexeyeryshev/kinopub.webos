import { useMemo } from 'react';
import dayjs from 'dayjs';

import { Item, ItemsParams } from 'api';
import ItemsList from 'components/itemsList';
import Link from 'components/link';
import Scrollable from 'components/scrollable';
import Seo from 'components/seo';
import useApi from 'hooks/useApi';
import { PATHS, generatePath } from 'routes';

const ItemsSection: React.FC<{ title: string; params: ItemsParams }> = ({ title, params }) => {
  const { data, isLoading } = useApi('items', [params, 0, 10]);
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

const lastMonth = dayjs().add(-1, 'month').unix();

const PopularMovies: React.FC = () => {
  return <ItemsSection title="Популярные фильмы" params={{ type: 'movie', sort: 'views-', conditions: [`created>=${lastMonth}`] }} />;
};

const NewMovies: React.FC = () => {
  return <ItemsSection title="Новые фильмы" params={{ type: 'movie', sort: 'created-' }} />;
};

const PopularSerials: React.FC = () => {
  return <ItemsSection title="Популярные сериалы" params={{ type: 'serial', sort: 'watchers-' }} />;
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

const ContinueWatching: React.FC = () => {
  const { data: serials, isLoading: serialsLoading } = useApi('watchingSerials');
  const { data: movies, isLoading: moviesLoading } = useApi('watchingMovies');
  const { data: historyData, isLoading: historyLoading } = useApi('history', [0, 100]);
  const items = useMemo(() => {
    const watchingItems = [...(serials?.items || []), ...(movies?.items || [])];
    if (!watchingItems.length) return [];

    const watchingIds = new Set(watchingItems.map((i) => i.id));

    // Build order from history: most recently watched first, deduplicated
    const seen = new Set<string>();
    const ordered: Item[] = [];

    for (const h of historyData?.history || []) {
      const id = h.item?.id;
      if (id && watchingIds.has(id) && !seen.has(id)) {
        seen.add(id);
        // Use history item (has full data with ratings/quality) over minimal watching item
        ordered.push(h.item);
      }
    }

    // Append any watching items not found in history
    for (const item of watchingItems) {
      if (!seen.has(item.id)) ordered.push(item);
    }

    return ordered.slice(0, 5).map((item) => ({ ...item, new: undefined }));
  }, [serials?.items, movies?.items, historyData?.history]);
  const isLoading = serialsLoading || moviesLoading || historyLoading;

  if (!isLoading && items.length === 0) return null;

  return (
    <div className="pb-2">
      <ItemsList
        title={
          <Link href={generatePath(PATHS.Watching, { watchingType: 'serials' })} className="w-full">
            Продолжить просмотр
          </Link>
        }
        titleClassName="ml-0"
        items={items}
        loading={isLoading}
        scrollable={false}
      />
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
