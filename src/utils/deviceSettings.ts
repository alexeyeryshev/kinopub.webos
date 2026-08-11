import find from 'lodash/find';
import forEach from 'lodash/forEach';

import { Bool, DeviceSettingBoolean, DeviceSettingList, DeviceSettings, DeviceSettingsParams } from 'api';
import { DEFAULT_DEVICE_SETTINGS } from 'appDefaults';
import { Logger } from 'logger';

const logger = new Logger('settings');

const normalizeLabel = (label: string) => label.trim().toLowerCase();

/**
 * Собирает настройки устройства, которые отличаются от зашитых в сборку значений по умолчанию
 */
export function getDefaultDeviceSettingsParams(settings?: DeviceSettings) {
  const params: Record<string, string | number> = {};

  forEach(DEFAULT_DEVICE_SETTINGS, (defaultValue, key) => {
    const setting = settings?.[key as keyof DeviceSettings];

    if (!setting || typeof defaultValue === 'undefined') {
      return;
    }

    if (typeof defaultValue === 'boolean') {
      const value = defaultValue ? Bool.True : Bool.False;

      if ((setting as DeviceSettingBoolean).value !== value) {
        params[key] = value;
      }

      return;
    }

    const option = find((setting as DeviceSettingList).value, ({ label }) => normalizeLabel(label) === normalizeLabel(defaultValue));

    if (!option) {
      logger.warn('default device setting is not available', { setting: key, value: defaultValue });
      return;
    }

    if (option.selected !== Bool.True) {
      // id отправляем как есть — он не всегда числовой
      params[key] = option.id;
    }
  });

  return params as DeviceSettingsParams;
}
