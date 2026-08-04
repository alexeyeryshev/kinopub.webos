import cx from 'classnames';

import { DECODE_SEVERE_ERRORS, DecodeHealth } from 'utils/decodeHealth';

type Props = {
  health?: DecodeHealth;
  /** Hidden while the diagnostics overlay is up, which shows the same numbers in full. */
  hidden?: boolean;
};

/**
 * A quiet corner indicator for decoder trouble, in the spirit of a game's network-status icon:
 * absent while everything is fine, and specific enough when it appears that it says what is wrong
 * rather than merely that something is.
 *
 * It deliberately does not act on the problem — no quality reduction, no reload. Its job is to make
 * a failure that is otherwise invisible (hls.js absorbs non-fatal decode errors, and dropped frames
 * are reported nowhere) legible without opening the diagnostics overlay.
 */
function DecodeHealthIndicator({ health, hidden }: Props) {
  if (hidden || !health || health.severity === 'ok') {
    return null;
  }

  const severe = health.severity === 'severe';
  const droppedPercent = health.droppedRatio * 100;

  // Lead with whichever signal is actually driving the warning. Hard errors outrank dropped
  // frames: a rejected segment is a different failure from a late one.
  const errorsDominate = health.decodeErrors >= (severe ? DECODE_SEVERE_ERRORS : 1) && droppedPercent < 1;
  const label = errorsDominate ? `Ошибки декодера ×${health.decodeErrors}` : `Пропуск кадров ${droppedPercent.toFixed(1)}%`;

  return (
    <div
      className={cx(
        'pointer-events-none absolute z-10 top-14 left-6 flex items-center rounded border border-current px-3 py-1 bg-black bg-opacity-70',
        severe ? 'text-red-400' : 'text-yellow-300',
      )}
      role="status"
    >
      {/* Drawn rather than a Material Icons ligature: the bundled font is not guaranteed to carry
          the glyph on older webOS builds, and a missing icon renders as tofu. */}
      <svg className="mr-2" width="1.25em" height="1.25em" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3 L22 20 H2 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 9 v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17.2" r="1.1" fill="currentColor" />
      </svg>
      <span className="text-lg font-bold">{label}</span>
      {severe && health.decodeErrors > 0 && !errorsDominate && <span className="ml-2 text-lg">×{health.decodeErrors}</span>}
    </div>
  );
}

export default DecodeHealthIndicator;
