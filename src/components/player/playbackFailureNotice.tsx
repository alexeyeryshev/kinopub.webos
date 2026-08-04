import Button from 'components/button';
import { PlaybackFailure } from 'components/media';

type Props = {
  failure?: PlaybackFailure;
  /** Hidden while a popup or the diagnostics overlay owns the screen. */
  hidden?: boolean;
  onRetry: () => void;
};

/**
 * What the player says once it has run out of ways to fix playback.
 *
 * Until this existed the end state was a frozen frame and nothing else: the retry budget draining
 * turned an endless retry loop into a silent failure, and the only surface that admitted it was a
 * `recovery:` line inside a diagnostics overlay nobody opens by accident. A viewer could sit in
 * front of a still picture indefinitely with no way to tell whether anything was still being tried.
 *
 * It appears only when every recovery path is spent, so it never argues with a recovery that is
 * still working, and it offers the one action the player cannot take on its own behalf.
 */
function PlaybackFailureNotice({ failure, hidden, onRetry }: Props) {
  if (hidden || !failure) {
    return null;
  }

  const explanation =
    failure.kind === 'media-error'
      ? 'Телевизор не смог воспроизвести этот файл.'
      : 'Не удалось загрузить видео: попытки восстановления исчерпаны.';

  return (
    // `pointer-events-none` on the panel with the button opting back in, matching the diagnostics
    // overlay: the notice must never swallow a remote press meant for the player underneath.
    <div className="pointer-events-none absolute z-101 top-0 left-0 right-0 bottom-0 flex items-center justify-center" role="alert">
      <div className="mx-8 flex max-w-3xl flex-col items-center rounded bg-black bg-opacity-90 px-8 py-6 text-center text-white ring">
        <div className="mb-2 text-3xl font-bold">Воспроизведение остановлено</div>
        <div className="mb-1 text-xl">{explanation}</div>
        {failure.reason && <div className="mb-4 text-base text-gray-400">{failure.reason}</div>}

        <div className="flex items-center">
          {/* Focused on appearance so the action is reachable from a remote without a pointer. */}
          <Button className="pointer-events-auto bg-gray-800 text-green-400" icon="refresh" autoFocus onClick={onRetry}>
            Повторить
          </Button>
          <div className="ml-6 text-lg text-gray-300">Back: выйти</div>
        </div>
      </div>
    </div>
  );
}

export default PlaybackFailureNotice;
