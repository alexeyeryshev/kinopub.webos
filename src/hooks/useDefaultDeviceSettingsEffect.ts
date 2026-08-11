import { useEffect, useRef } from 'react';
import { useQueryClient } from 'react-query';
import isEmpty from 'lodash/isEmpty';

import type { Response as ApiResponse } from 'api';
import useApi from 'hooks/useApi';
import useApiMutation from 'hooks/useApiMutation';
import useStorageState from 'hooks/useStorageState';
import { Logger } from 'logger';

import { getDefaultDeviceSettingsParams } from 'utils/deviceSettings';
import { logException } from 'utils/logging';

const logger = new Logger('settings');

/**
 * Выставляет настройки устройства по умолчанию один раз после привязки устройства,
 * чтобы они не терялись при переустановке приложения
 */
function useDefaultDeviceSettingsEffect(isAuthorized: boolean) {
  const queryClient = useQueryClient();
  const [isApplied, setIsApplied] = useStorageState<boolean>('is_default_device_settings_applied');
  const { data: deviceInfo } = useApi('deviceInfo', [], { enabled: isAuthorized && !isApplied });
  const { saveDeviceSettingsAsync } = useApiMutation('saveDeviceSettings');
  const isApplyingRef = useRef(false);

  useEffect(() => {
    const device = deviceInfo?.device;

    if (isApplied || !device || isApplyingRef.current) {
      return;
    }

    const settings = getDefaultDeviceSettingsParams(device.settings);

    isApplyingRef.current = true;

    (async () => {
      try {
        if (!isEmpty(settings)) {
          const response = (await saveDeviceSettingsAsync([device.id, settings])) as ApiResponse | undefined;

          // На отказ kinopub отвечает `{ status: 400, error: null }`, поэтому одного `error` мало:
          // при проверке только по нему настройки помечались применёнными, хотя не сохранялись
          if (response?.error || (typeof response?.status === 'number' && response.status >= 400)) {
            // не помечаем настройки применёнными, чтобы попробовать ещё раз при следующем запуске
            logger.warn('failed to apply default device settings', { settings, response });
            return;
          }

          await queryClient.invalidateQueries('deviceInfo');
        }

        setIsApplied(true);
      } catch (ex) {
        logException(ex);
      } finally {
        isApplyingRef.current = false;
      }
    })();
  }, [deviceInfo?.device, isApplied, setIsApplied, saveDeviceSettingsAsync, queryClient]);
}

export default useDefaultDeviceSettingsEffect;
