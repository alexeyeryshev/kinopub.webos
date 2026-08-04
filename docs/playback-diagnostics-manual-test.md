# Playback Diagnostics Manual Test Checklist

Use this checklist on an LG webOS TV after installing a build that includes the playback diagnostics overlay.

## Open And Close

- Start normal playback.
- Open player settings with the Blue button or ArrowUp.
- Select `Диагностика воспроизведения`.
- Confirm the overlay appears above the video.
- Press Back and confirm the overlay closes.
- Open and close the overlay repeatedly.
- Confirm playback continues and the UI remains responsive.

## Normal Playback

- Let a video play for several minutes.
- Confirm playback time and duration update about once per second.
- Confirm `paused`, `seeking`, `readyState`, and `networkState` are readable.
- Confirm recent video events appear in the history.
- Confirm buffered ranges and buffer ahead are shown.

## Pause And Resume

- Pause playback while the overlay is visible.
- Confirm `paused: true`.
- Resume playback.
- Confirm `paused: false`.
- Confirm the overlay remains readable and does not block playback.

## Seek

- Seek forward.
- Confirm `seeking` and `seeked` events appear.
- Confirm buffer state updates after the seek.
- Confirm the overlay clearly indicates if the current position is not buffered.

## Fixed-Quality Playback

- Select a fixed quality from the player settings.
- Reopen diagnostics.
- Confirm HLS level state shows fixed mode when HLS.js exposes enough information.
- Confirm no unexpected automatic quality or source behavior changed.

## Adaptive HLS Playback

- Play an adaptive/master-playlist stream when available.
- Confirm HLS.js is shown as active.
- Confirm available levels are listed compactly.
- Confirm level switches appear as normal diagnostic events.
- Confirm bandwidth estimate is shown when the installed HLS.js runtime exposes it.

## Segment Pipeline

- While playback runs normally, confirm the `Segment Pipeline` section alternates between `load: ... loading`
  and `load: ... loaded in Ns`, and similarly for `append`, roughly once per fragment.
- Confirm `emergency aborts` stays at `0` during normal playback.
- If a level switch is forced under changing bandwidth, confirm `emergency aborts` increments only when
  HLS.js actually aborts an in-flight fragment load, and that the load stage shows `aborted (low bandwidth)`.

## Network Interruption

- If possible, temporarily interrupt network connectivity.
- Confirm the overlay records HLS errors such as load timeout, manifest failure, fragment failure, or HTTP status.
- Confirm the `Failure Summary` section increments the `network` counter for connectivity/load failures, and
  that `last` reflects the most recent failure category and its age.
- Confirm the `Segment Pipeline` load stage reflects a stalled/retrying fragment load during the interruption
  (elapsed loading time keeps increasing instead of completing).
- Confirm any request location shows hostname only, not full URLs or query parameters.
- Restore connectivity and observe whether successful fragment information updates.

## Buffer Starvation

- If reproducible, let playback stall due to an empty buffer without a network interruption.
- Confirm the `Failure Summary` `buffer starvation` counter increments rather than `media/decode`, since
  hls.js reports buffer-stall symptoms as a media error that this overlay recategorizes using the error
  `details` field.
- Confirm normal `LEVEL_SWITCHED` events during recovery are shown as `level switch` entries in Recent Events
  and are never counted in the Failure Summary.

## Decode Quality

- Check the Decode Quality section.
- If supported, confirm total frames, dropped frames, and dropped percentage update.
- If unsupported on the TV firmware, confirm the overlay shows `not available`.

## Fragment Labelling

- Play a stream with a separate audio track at a quality that is not 1080p (2160p is a good test).
- Confirm `Last Fragment` shows one line per stream — `main: 2160p, …` and `audio: track N, …` —
  and that neither flickers between resolutions.
- Confirm the audio line is never labelled with a video resolution. An audio fragment's `level` is a
  track index, so resolving it against the video levels would name it after an unrelated quality.
- Sanity-check the sizes: a 2160p video fragment is megabytes, an audio fragment a few hundred KB.
- Confirm `main last successful` tracks the video stream, so it keeps climbing if video stalls while
  audio keeps arriving.

## Overlay Layout

- Open the overlay during normal playback.
- Confirm the left column shows `Playback`, `Buffer`, `Segment Pipeline`, `Decode Quality`.
- Confirm the middle column shows only `Recent Events`, and that it runs from the top of the column
  down to the bottom of the panel rather than stopping after a few entries.
- Confirm the right column shows `HLS`, `Last Fragment`, `Failure Summary`.
- Confirm a `QR` button is visible in the panel header, left of the `Back: закрыть` hint.
- Let several events accumulate and confirm noticeably more of them are visible than before.

## Capture Export

- With the diagnostics panels open, activate the `QR` button in the header (Magic Remote pointer),
  and separately confirm the `Yellow` colour key does the same thing.
- Confirm `Yellow` does nothing when the diagnostics panels are closed.
- Confirm a QR code appears with the caption showing the payload length and `(сжато)`. If it says
  `(без сжатия)`, the TV runtime has no `CompressionStream`; note that, since it roughly doubles the
  code size.
- Confirm a single code is shown for a normal capture; `Часть N из M` labels only appear if the
  payload needed splitting.
- Scan it with a phone camera and confirm it decodes to a text string starting with `KPD1`.
- Run the decoder and confirm the report matches what the overlay showed:

  ```sh
  node scripts/decode-diagnostics.js "<scanned text>"
  ```

- Confirm the decoded event list is newest-first and its timestamps line up with the overlay.
- Press Back and confirm the export view closes back to the diagnostics panels, and that a second
  Back then closes the panels themselves. Playback must be unaffected throughout.
- Open the export again and confirm the QR does not change or flicker while it is on screen (the
  capture is frozen at the moment it was opened).

## Recovery Budget

- Reproduce a segment the CDN refuses (seek into an unbuffered region of a title that has shown
  `HTTP 0` before).
- Watch the `recovery:` line in `Failure Summary`. The attempt count must **climb** — `1/6`, `2/6`,
  … — with the gap between retries growing (1, 2, 4, 8, 8, 8 s).
- Confirm it reaches `gave up after 6, networkError / fragLoadError` within roughly a minute, and
  that `FRAG_LOADING` events then stop entirely.
- A count that sits at `1/6` while the `network` failure counter keeps climbing is the regression
  this guards against: recovery restarting the loading engine refetches the init segment, and
  counting that as proof of recovery refills the budget forever. `src/utils/hlsRecovery.test.ts`
  covers the rule.
- Confirm that once playback genuinely resumes, a later unrelated failure starts again from `1/6`
  rather than inheriting the spent budget.

## Decode Health Indicator

- During clean playback, confirm no badge is shown at the top left.
- On content that stutters, confirm a badge appears below the title row reading
  `Пропуск кадров N%`, yellow from 1% and red from 5%.
- Confirm it disappears again once playback is clean for the length of the window (30 s).
- Confirm the badge is hidden while the diagnostics overlay or the QR export is open.
- Confirm it never intercepts the remote: pressing directions/OK must behave exactly as without it.
- If a decoder error occurs, confirm the badge reads `Ошибки декодера ×N` instead, and that the
  `media/decode` counter in `Failure Summary` moves by the same amount — the two read the same
  categorisation and must agree.

## Recovery Episodes In Sentry

- Reproduce a stall, then let it run to completion rather than restarting playback.
- In Sentry, find the `playback: recovered …` or `playback: recovery abandoned …` event.
- Confirm its breadcrumbs show the whole chain in order: the episode start, each fatal error, each
  `fatal-retry` with its attempt number and delay, any `watchdog-restart` / `watchdog-reload`, and
  the budget-exhausted entries.
- Confirm the non-fatal error flood appears as periodic `N non-fatal errors` summaries rather than
  hundreds of individual breadcrumbs, and that `errorCounts` in the event context still totals them
  all.
- For a recovered episode, confirm the `playback_recovered_after` tag names the action that came
  last — this is what says which recovery path works.
- Confirm exactly one event is sent per episode, not one per error.

## Privacy Check

- Inspect the overlay during HLS errors.
- Confirm no full stream URLs, authorization tokens, cookies, or query parameters are visible.
- Confirm only hostnames are shown for request diagnostics.
- Decode an exported capture taken during an error and confirm the same holds in the decoded text —
  the export must never carry more than the overlay displays.
- Confirm a Sentry event for a playback issue contains hostnames only — no full stream URLs, tokens
  or query parameters in the message, the `playback` context, or the breadcrumbs.
