import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import map from 'lodash/map';
import sample from 'lodash/sample';

import Button from 'components/button';
import Seo from 'components/seo';
import Text from 'components/text';
import Title from 'components/title';

/**
 * Серверы для замера скорости.
 * Совпадают с теми, что использует замер на сайте kino.pub (zamerka.com):
 * несколько пронумерованных хостов на регион, номер выбирается случайно.
 */
const SPEEDTEST_SERVERS = [
  { name: 'Амстердам', location: 'ams', hosts: ['01', '02', '03'] },
  { name: 'Москва', location: 'msk', hosts: ['05', '06', '07'] },
];

function updateSpeedReducer(state: { [location: string]: string }, action: { type: string; payload: string }) {
  return {
    ...state,
    [action.type]: action.payload,
  };
}

const SpeedView: React.FC = () => {
  const [speed, setSpeed] = useReducer(updateSpeedReducer, {});
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const servers = useMemo(
    () =>
      map(SPEEDTEST_SERVERS, ({ name, location, hosts }) => ({
        name,
        location,
        server: `https://speed.${location}-static-${sample(hosts)}.cdntogo.net/speedtest/`,
        dlURL: `garbage.php`,
        ulURL: `empty.php`,
        pingURL: `empty.php`,
        getIpURL: `getIP.php`,
      })),
    [],
  );
  const workers = useMemo(() => {
    // @ts-expect-error
    if (!loaded && !window['Speedtest']) {
      return [];
    }

    return map(servers, (server) => {
      // @ts-expect-error
      const worker = new window['Speedtest']();

      worker._settings.test_order = 'IP_D';
      worker._settings.xhr_dlMultistream = 1;

      worker.setSelectedServer(server);

      worker.onupdate = ({ testState, dlStatus }: { testState: number; dlStatus: string }) => {
        setSpeed({
          type: server.location,
          payload: dlStatus || ((testState === 1 || testState === 2) && 'Начинаем') || '',
        });
      };

      return worker;
    });
  }, [servers, setSpeed, loaded]);
  const [currentWorkerIndex, setCurrentWorkerIndex] = useState(0);

  const handleStart = useCallback(() => {
    setStarted(true);
    setCurrentWorkerIndex(0);
  }, []);

  const handleStop = useCallback(() => {
    setStarted(false);
  }, []);

  useEffect(() => {
    if (workers[currentWorkerIndex]) {
      if (started) {
        workers[currentWorkerIndex].onend = () => {
          setCurrentWorkerIndex(currentWorkerIndex + 1);
        };

        if (workers[currentWorkerIndex]._state !== 3) {
          workers[currentWorkerIndex].start();
        }
      } else {
        if (workers[currentWorkerIndex]._state === 3) {
          workers[currentWorkerIndex].abort();
        }
      }
    } else {
      handleStop();
    }
  }, [started, workers, currentWorkerIndex, handleStop]);

  useEffect(() => {
    return () => {
      handleStop();
    };
  }, [handleStop]);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = './speedtest.js';
    script.async = true;
    script.onload = () => {
      setLoaded(true);
    };
    script.onerror = (error) => {
      setError(`Не удалось загрузить скрипт для замера скорости: ${error}`);
    };

    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  return (
    <>
      <Seo title="Проверка скорости" />
      <Title className="mb-10">Проверка скорости</Title>

      {error ? (
        <div className="m-1 mb-10">
          <Text className="text-red-600">{error}</Text>
        </div>
      ) : (
        loaded &&
        servers.length > 0 &&
        !workers.length && (
          <div className="m-1 mb-10">
            <Text className="text-red-600">Не удалось создать ни одного воркера для замера скорости</Text>
          </div>
        )
      )}

      <div className="flex justify-around">
        {map(SPEEDTEST_SERVERS, ({ name, location }) => (
          <div className="flex flex-col items-center w-1/2" key={location}>
            <Text>{name}</Text>
            {speed[location] || '0.00'}
            <Text>Mbit/s</Text>
          </div>
        ))}
      </div>

      <div className="flex justify-center pt-12">
        {started ? (
          <Button icon="stop" onClick={handleStop}>
            Стоп
          </Button>
        ) : (
          <Button icon="play_arrow" onClick={handleStart} disabled={!workers.length}>
            Начать
          </Button>
        )}
      </div>
    </>
  );
};

export default SpeedView;
