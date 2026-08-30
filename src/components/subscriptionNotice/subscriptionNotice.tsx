import { useCallback, useState } from 'react';

import Button from 'components/button';
import Text from 'components/text';
import useApi from 'hooks/useApi';

/**
 * Предупреждение о законченной подписке.
 *
 * Без активной подписки kinopub отдаёт ссылки на demo-версии файлов вместо самих файлов,
 * и воспроизведение просто не начинается — ни ошибки, ни объяснения. Баннер показываем,
 * чтобы причина была видна сразу.
 *
 * Состояние скрытия держим в памяти компонента: закрытый баннер появляется снова
 * при следующем запуске приложения, чтобы про подписку нельзя было забыть насовсем
 */
const SubscriptionNotice: React.FC = () => {
  const [isDismissed, setIsDismissed] = useState(false);
  const { data } = useApi('user');

  const handleDismiss = useCallback(() => setIsDismissed(true), []);

  const subscription = data?.user?.subscription;

  if (isDismissed || !subscription) {
    return null;
  }

  // days бывает дробным, поэтому неполный день считаем уже законченной подпиской
  const days = Math.floor(subscription.days);

  if (subscription.active && days >= 1) {
    return null;
  }

  return (
    <div className="fixed top-2 left-1/2 transform -translate-x-1/2 z-999 flex items-center px-4 py-3 rounded-xl shadow-xl bg-red-700">
      <Text className="mr-4">
        Подписка закончилась — kinopub отдаёт только demo-версии, и видео не запускается.
        <br />
        Продлите подписку на kino.pub, чтобы смотреть дальше.
      </Text>
      <Button onClick={handleDismiss} className="bg-red-900">
        Скрыть
      </Button>
    </div>
  );
};

export default SubscriptionNotice;
