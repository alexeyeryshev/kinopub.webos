import type { DeviceSettingBoolean, DeviceSettings } from 'api';
import type { Key, Value } from 'storage';

/**
 * ВНИМАНИЕ: модуль называется appDefaults, а не defaults, намеренно.
 * В node_modules есть пакет `defaults`, а webpack в react-scripts ищет по `modules: ['node_modules', ...]`
 * раньше, чем по baseUrl проекта. Из-за этого `from 'defaults'` подключал пакет, а не этот файл:
 * экспортов в нём нет, все константы молча становились undefined, и настройки по умолчанию не применялись.
 * TypeScript при этом резолвит baseUrl и ошибок не показывает, поэтому имя, совпадающее с пакетом, брать нельзя
 */

/**
 * Настройки приложения по умолчанию, зашитые в сборку.
 * Применяются, пока пользователь ничего не менял в настройках, поэтому переживают переустановку приложения.
 */
export const DEFAULT_SETTINGS: Partial<Record<Key, Value>> = {
  // hls.js проигрывает через MSE и не тянет 4K HEVC/HDR, поэтому отдаём поток нативному плееру webOS.
  // Звук при этом выбирается ссылкой на плейлист (см. streaming_type ниже), а не переключением дорожки
  'is_hls.js_active': false,
  is_ac3_by_default_active: false,
  is_forced_by_default_active: false,
  is_pause_by_ok_click_active: false,
  default_quality: 'best',
  default_audio_lang: 'eng',
  default_subtitle_lang: '',

  // Дублирует настройку устройства `streamingType`, обновляется из неё при открытии контента.
  // В hls1 номер аудиодорожки зашит в ссылку (master-v1aN), поэтому звук выбирается без hls.js,
  // в отличие от hls4, где дорожки лежат в одном плейлисте и нативный плеер их не переключает
  streaming_type: 'hls',
};

export type DeviceSettingsDefaults = {
  [key in keyof DeviceSettings]?: DeviceSettings[key] extends DeviceSettingBoolean ? boolean : string;
};

/**
 * Настройки устройства по умолчанию (хранятся на стороне kinopub).
 * При переустановке приложение привязывается заново и получает новое устройство с настройками kinopub,
 * поэтому эти значения выставляются один раз после привязки.
 * Списочные настройки задаются подписью пункта (label), т.к. их идентификаторы зависят от аккаунта.
 */
export const DEFAULT_DEVICE_SETTINGS: DeviceSettingsDefaults = {
  supportSsl: true,

  // Без этих трёх kinopub не отдаёт 4K HEVC/HDR файлы: в ответе остаются только h264 до 1080p
  supportHevc: true,
  supportHdr: true,
  support4k: true,

  // Раздельные плейлисты на дорожку — на них и рассчитан выбор звука ссылкой master-v1aN в hls1
  mixedPlaylist: false,

  // Именно hls1: в hls4 дорожки лежат в одном плейлисте, а нативный плеер webOS их не переключает
  streamingType: 'HLS',
  serverLocation: 'Нидерланды',
};
