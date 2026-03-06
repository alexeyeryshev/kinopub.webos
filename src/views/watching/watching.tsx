import React, { useMemo } from 'react';
import { generatePath, useParams } from 'react-router-dom';
import capitalize from 'lodash/capitalize';
import map from 'lodash/map';
import sumBy from 'lodash/sumBy';

import { Item } from 'api';
import ItemsList from 'components/itemsList';
import Link from 'components/link';
import Seo from 'components/seo';
import Text from 'components/text';
import useApi from 'hooks/useApi';
import { PATHS, RouteParams } from 'routes';

const WATCHING_TYPES_MAP = {
  serials: 'Сериалы',
  movies: 'Фильмы',
} as const;

type WatchingTypes = keyof typeof WATCHING_TYPES_MAP;

const WatchingView: React.FC = () => {
  const { watchingType = 'serials' } = useParams<RouteParams>();
  const { data, isLoading } = useApi(`watching${capitalize(watchingType) as Capitalize<WatchingTypes>}`);
  const { data: historyData } = useApi('history', [0, 100]);
  const total = useMemo(() => sumBy(data?.items, (item) => +(item.new || 0)), [data?.items]);
  const sortedItems = useMemo(() => {
    const items = data?.items;
    if (!items?.length) return items;

    const watchingIds = new Set(items.map((i) => i.id));
    const seen = new Set<string>();
    const ordered: Item[] = [];

    for (const h of historyData?.history || []) {
      const id = h.item?.id;
      if (id && watchingIds.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(items.find((i) => i.id === id)!);
      }
    }

    for (const item of items) {
      if (!seen.has(item.id)) ordered.push(item);
    }

    return ordered;
  }, [data?.items, historyData?.history]);

  const seoTitle = watchingType === 'serials' ? 'Новые эпизоды' : 'Недосмотренные фильмы';
  const title = total ? `${seoTitle} (${total})` : seoTitle;

  return (
    <>
      <Seo title={seoTitle} />
      <ItemsList
        title={
          <>
            <Text>{title}</Text>

            <div className="flex">
              {map(WATCHING_TYPES_MAP, (watchingTypeName, watchingTypeKey) => (
                <Link
                  key={watchingTypeKey}
                  className="mr-2"
                  replace
                  active={watchingType === watchingTypeKey}
                  href={generatePath(PATHS.Watching, { watchingType: watchingTypeKey })}
                >
                  {watchingTypeName}
                </Link>
              ))}
            </div>
          </>
        }
        items={sortedItems}
        loading={isLoading}
      />
    </>
  );
};

export default WatchingView;
