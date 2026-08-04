# Playback Diagnostics Overlay Spec

## Goal

Add a user-accessible diagnostics overlay for the HLS player to help investigate intermittent playback stalls on LG webOS TVs, especially when the same KinoPub stream works normally on another device on the same network.

## Scope

This feature is diagnostics only.

Do not change:

- playback quality selection;
- ABR behavior;
- source selection;
- retry strategy;
- network logic.

The implementation must remain compatible with the current React, TypeScript, Enact/webOS runtime, and pinned `hls.js` version.

Runtime dependencies were originally frozen outright. That rule is now narrowed: the pinned React,
Enact/webOS, TypeScript, and `hls.js` versions still must not move, but a small, self-contained
dependency may be added when it is the only thing standing between the diagnostics and a usable
workflow. The single approved addition so far is `qrcode-generator`, used by the capture export
below; it pulls in no transitive dependencies and touches nothing on the playback path.

## Entry Point

The active media implementation is exported from `src/components/media/index.ts` and points to `src/components/media/media.new.tsx`.

The player shell and user-facing settings menu live in:

- `src/components/player/player.tsx`;
- `src/components/player/settings.tsx`.

The settings UI is Russian, so the diagnostics menu item should use:

```text
Диагностика воспроизведения
```

Selecting the item toggles a compact overlay above the video.

## Overlay Behavior

The overlay should:

- be readable from a TV viewing distance;
- use a high-contrast semi-transparent background;
- update roughly once per second;
- not block normal playback or pointer/remote interaction;
- close with existing Back/player-menu behavior;
- keep event history only in memory for the current playback session;
- avoid console logging in normal use.

## Overlay Layout

The panels are laid out in three fixed columns, grouped by what a reader is trying to answer rather
than by source:

- column 1 — what the local pipeline is doing: `Playback`, `Buffer`, `Segment Pipeline`,
  `Decode Quality`;
- column 2 — `Recent Events`, alone;
- column 3 — what HLS chose and what came of it: `HLS`, `Last Fragment`, `Failure Summary`
  (including the recovery budget).

`Recent Events` gets a column to itself because it is the only unbounded section: sharing a column
capped it to a handful of visible entries, which hid exactly the run-up to a stall that the history
exists to show. The overlay is anchored to both the top and bottom edges and the columns are laid
out with flex, so the event list fills the available height and clips against the panel instead of
an arbitrary `max-height`.

## Privacy Requirements

The overlay must not expose:

- full stream URLs;
- authorization tokens;
- cookies;
- query parameters;
- other sensitive request data.

If request location is useful, show only the hostname.

## Playback State

Show:

- current playback time and duration;
- `paused`;
- `seeking`;
- numeric and readable `readyState`;
- numeric and readable `networkState`;
- whether `HTMLVideoElement.error` exists;
- video error code/message when available.

Track recent native video events in a bounded ring buffer of 20-30 entries:

- `playing`;
- `waiting`;
- `stalled`;
- `canplay`;
- `canplaythrough`;
- `seeking`;
- `seeked`;
- `error`;
- `ended`.

## Buffer State

Show:

- buffer ahead in seconds;
- current buffered range containing `video.currentTime`;
- all buffered ranges in compact form;
- clear indication when current playback position is outside every buffered range.

Calculate buffer ahead from the matching buffered range:

```ts
bufferAhead = matchingRange.end - video.currentTime;
```

Do not use the end of the last buffered range unless it is the range containing the current playback position.

## HLS State

When HLS.js is active, show:

- active/inactive state;
- number of quality levels;
- compact level list, for example `720p / 2.5 Mbps`;
- `currentLevel`;
- `nextLevel`;
- `loadLevel`;
- `autoLevelCapping`, when available;
- `bandwidthEstimate`, when available;
- fixed-level vs automatic-level mode when reliable.

Read all HLS fields defensively because not every field is guaranteed in the installed `hls.js` version.

Derive the Auto/Fixed label from `hls.autoLevelEnabled` (falling back to `hls.currentLevel === -1` only if that
field is missing), not from the number of available levels. A stream can expose multiple levels while a level
was pinned manually, and a stream can expose a single level while still reporting automatic mode; the level
count alone does not indicate which is active.

## Segment Loading

Subscribe to HLS events when available:

- `FRAG_LOADING` (fragment load start);
- `FRAG_LOADED` (fragment load completion, before it is appended to the buffer);
- `FRAG_LOAD_EMERGENCY_ABORTED` (ABR aborted an in-flight fragment load, typically under sustained low bandwidth);
- `FRAG_BUFFERED`;
- `FRAG_CHANGED`;
- `BUFFER_APPENDING` (buffer append start);
- `BUFFER_APPENDED` (buffer append completion);
- `LEVEL_SWITCHED`;
- `ERROR`.

`frag.level` indexes whichever playlist set produced the fragment, and that is **not** always
`hls.levels`. `audio-stream-controller.ts` builds its own `levels` from the audio track list, so an
audio fragment's `level` is a track index. Resolving it against the video levels names audio
fragments after video resolutions — an audio track at index 2 reads as `1080p` purely because video
level 2 happens to be 1080p. Only resolve a level against `hls.levels` when `frag.type === 'main'`;
label anything else as a track.

Keep the last fragment per stream rather than one shared slot. Video and audio fragments interleave,
and audio buffers a moment after the video fragment it accompanies, so a single slot shows the audio
one almost all of the time. `last successful` is deliberately the **main** stream's age: audio
continuing to buffer while video is stuck is exactly the situation the panel must expose rather than
hide behind a healthy-looking number.

For the most recently completed media fragment, show:

- selected level or height;
- bytes loaded;
- request/load duration;
- calculated effective throughput;
- time elapsed since the last successfully buffered fragment.

Use HLS loader stats defensively and avoid division by zero. `FragLoadedData` and the buffer-append events do
not carry top-level `stats`; read them from `frag.stats` instead, since `Fragment.stats` is always populated.

Track the fragment-load and buffer-append lifecycle as two separate pending/completed stages (`Segment Pipeline`) so a stall can be attributed to either phase:

- fragment load: idle / loading (with elapsed time) / loaded (with duration) / aborted, keyed by `frag.type`
  (`main` / `audio` / `subtitle`);
- buffer append: idle / appending (with elapsed time) / appended (with duration), keyed by the SourceBuffer
  type (`video` / `audio` / `audiovideo`);
- a running count of `FRAG_LOAD_EMERGENCY_ABORTED` events.

Keying by stream/buffer type matters: on a stream with alternate audio, the main (video) and audio stream
controllers load fragments and append to their own SourceBuffers independently. A single shared stage would
let an audio fragment or append completing mask an ongoing stall on the main video stream, defeating the
purpose of the pipeline view.

This separates "waiting on the network for a fragment" from "waiting on the media pipeline to accept a
fragment it already has", which the two combined event types on their own do not make clear.

## Errors

Record recent HLS errors in the same bounded diagnostics history.

For each error show, when available:

- timestamp;
- fatal/non-fatal flag;
- failure category (see below);
- error type;
- error details;
- HTTP response status;
- request hostname only.

The overlay must distinguish, for every `ERROR` event:

- network failure — `data.type === 'networkError'` (manifest/level/fragment/key load errors and timeouts,
  including fragment load timeout);
- buffer starvation — `data.details` is `bufferStalledError`, `bufferSeekOverHole`, or `bufferNudgeOnStall`.
  hls.js reports these as `mediaError` because they surface through the media element, so `details` must be
  checked before falling back to `type`;
- media/decode failure — any other `mediaError` or `muxError` (parsing, codec, and append errors, including
  `bufferFullError`: a SourceBuffer quota-exceeded/append-capacity failure, which is the opposite condition
  from starvation and must not be counted as one);
- other — key-system and uncategorized errors.

Maintain a running count per category (`Failure Summary`) plus the most recent category and how long ago it
occurred, so a pattern of repeated network vs. buffer-starvation vs. decode failures is visible without
reading the full event history.

Normal HLS level switches (`LEVEL_SWITCHED`) are not errors and must never be counted in the failure summary;
they are shown in the event history prefixed with `level switch` to keep them visually distinct from error
entries.

## Decode Quality

Use `HTMLVideoElement.getVideoPlaybackQuality()` when supported.

Show:

- total video frames;
- dropped video frames;
- dropped-frame percentage.

If unsupported on a webOS runtime, show `not available`.

## Cleanup

Clean up all:

- native video listeners;
- HLS listeners;
- intervals/timers.

Diagnostic state must be isolated, bounded, and discarded when playback unmounts.

## Capture Export

The overlay can serialize its current state into a QR code so a report can leave the TV without a
network round trip. That constraint drives the whole
design: the failure under investigation is a network stall, so any transport that uploads from the
app is unavailable exactly when the capture matters. Scanning with a phone works regardless.

Sending to the Sentry DSN already present in `src/utils/logging.ts` is not an option either — it
belongs to the upstream project, so the data would go to a third party and stay invisible to whoever
is debugging this fork.

### Entry point

A `QR` button sits in the diagnostics panel header, next to the `Back: закрыть` hint — the capture
belongs to the diagnostics screen rather than the settings menu, since that is where the state being
captured is on display.

The overlay stays `pointer-events-none` so it never intercepts player input; only the button opts
back in via `pointer-events-auto`, which keeps it clickable with the Magic Remote pointer. Remotes
without a pointer reach the same action with the `Yellow` colour key, which is only bound while the
diagnostics panels are visible.

The capture is taken once, when the view opens, and does not refresh while it is on screen: a QR
that changed mid-scan would be unscannable.

### Pipeline

```text
compact text -> deflate-raw (when CompressionStream exists) -> Base32 -> QR (alphanumeric mode)
```

- **Compact text** (`buildCompactText`): line-oriented, `|`-separated, one leading tag letter per
  line. Event names travel as indices into a shared `EVENT_CODES` table, and event timestamps as
  millisecond deltas counting _backwards_ from the capture time. Events are ordered newest-first so
  that truncation drops the oldest ones.
- **deflate-raw** via `CompressionStream`. Absent on older runtimes, in which case the payload is
  emitted uncompressed and the header records that; the decoder handles both.
- **Base32** (`A-Z2-7`), not Base64. The Base32 alphabet is a subset of the QR alphanumeric charset,
  so the code encodes at 5.5 bits per character instead of the 8 bits per character that Base64
  would force through byte mode — a materially smaller code for the same data.

A representative capture (30 events, full snapshot) is ~1270 characters of compact text, ~570
characters after deflate and Base32, and fits one 77x77-module QR at error-correction level M.

### Chunk header

Each QR carries `KPD<version><D|P><index><count>.<base32>`, for example `KPD1D11.MFRGG…`. `D` marks
a deflated body and `P` a plain one. Index and count are single digits, so a capture is limited to
`MAX_CHUNKS` (9) codes; beyond that the encoder halves the event history and retries, reporting how
many events it dropped. If even a zero-event capture would not fit, it throws instead of emitting
two-digit indices, and the export view shows the error: a payload the reference decoder rejects by
design is worse than an honest failure.

The decoder validates that every scanned chunk agrees on version, compression mode, and total count
before joining any bodies. Chunks are scanned one at a time and can easily come from two different
captures, and concatenating mismatched halves would yield a plausible-looking but corrupt report.

### Decoder

`scripts/decode-diagnostics.js` is the reference decoder and the contract for the format:

```sh
node scripts/decode-diagnostics.js "KPD1D11.MFRGG…"     # human-readable report
node scripts/decode-diagnostics.js --json "KPD1D11.…"   # structured output
```

Chunks may be passed in any order; a missing one is reported rather than silently dropped. Any
change to `FORMAT_VERSION` or `EVENT_CODES` in `src/components/player/diagnosticsExport.ts` must land
in this script in the same commit.

### Privacy

The export carries exactly what the overlay already displays, so the same rules apply without
exception: hostnames only, never full URLs, query parameters, cookies, or tokens.

That equivalence is the rule to hold to when the overlay grows: a panel added to the screen without a
matching field in the capture makes the export quietly less useful than the screen it came from. The
recovery state is carried on the `r|` line for this reason.

## Decode Health Indicator

A corner badge that appears when the decoder is visibly struggling, so the condition is legible
without opening the diagnostics overlay. It sits at the top left, below the player's title row, and
is hidden while the overlay or the QR export is up — those show the same numbers in full.

It is an indicator only. It never lowers quality, reloads, or otherwise acts on the problem.

### Metric

There is no normative threshold for "the decoder is struggling", but there is a settled _metric_:
the dropped-frame ratio from `HTMLVideoElement.getVideoPlaybackQuality()`, which the W3C Media
Playback Quality spec exposes for this purpose and which every player surfaces in its stats panel.
Two properties matter more than the exact numbers:

- **A ratio, not a raw count.** Five dropped frames a minute is 0.35% at 24 fps and 0.14% at 60 fps
  — the same count describes very different experiences. Normalising by frames rendered makes the
  number mean one thing.
- **A sliding window, not cumulative totals.** Cumulative counters dilute: an hour of clean playback
  buries a minute of stuttering, so a lifetime ratio stops describing _now_.

The window is 30 s, sampled every 2 s. Thresholds:

| Dropped ratio | Severity         |
| ------------- | ---------------- |
| < 1%          | none             |
| 1% – 5%       | warning (yellow) |
| >= 5%         | severe (red)     |

Hard decode errors are tracked in the same window and escalate independently — one is a warning,
three are severe. They are qualitatively worse than a dropped frame: a dropped frame is late, while
`bufferAppendError` or `fragParsingError` means the decoder rejected the data outright. Non-fatal
ones matter most, because hls.js absorbs them silently and nothing else reports them. The
categorisation is shared with the overlay via `src/utils/hlsFailures.ts` so the two can never
disagree.

### Guards against false positives

- The ratio is ignored until at least 120 frames have been rendered in the window, so a couple of
  frames lost while the pipeline spins up does not read as a total failure.
- Sampling pauses while playback is paused, since a paused element renders nothing and would
  otherwise stretch the window across a gap.
- A backwards counter delta means the element reloaded and reset its counters, so the window is
  discarded rather than compared across two unrelated runs.

The rule lives in `src/utils/decodeHealth.ts` with unit tests.

## Playback Failure Notice

The recovery budgets exist so a refusing CDN is not hammered indefinitely. Draining them turned an
endless retry loop into a _silent_ failure: the player stopped trying and nothing said so, leaving a
frozen frame and a `recovery:` line inside an overlay reached through the settings menu.

A centred notice now appears when playback is over and the player will not fix it:

- **When.** Only when every recovery path that _applies_ is spent — which is not the same as every
  path that exists. For an hls.js source the stall watchdog must report `exhausted`, since it
  engages on any stall whatever caused it; the fatal-error budget only has to be spent as well if a
  fatal error ever engaged it. Requiring both unconditionally would have excluded the failure this
  player was built for: a CDN edge refusing specific segments produces only non-fatal errors, so
  hls.js never escalates, the fatal budget is never touched, and the notice would never appear for
  the one case the watchdog exists to handle. For a source played without hls.js there are no
  budgets and the media element's own `error` is the whole story, since nothing retries it.
- **What.** A short line in Russian saying playback stopped and why, the underlying
  `type / details` in small text, a `Повторить` button, and a `Back: выйти` hint.
- **Retry.** Rebuilds the media pipeline rather than restarting the stopped one: a fatal hls.js
  error leaves the loading engine dead for good, so `startLoad()` on it does nothing. The teardown
  path already preserves the playback position, so a retry resumes where the picture froze. The
  stall watchdog is rebuilt with it: its stall clock and reload budget live in closure variables, so
  a retry that kept the old closure would inherit a spent budget and a stall that started minutes
  ago, and would pronounce the fresh attempt dead before it had finished loading its manifest.
- **Focus.** The button takes focus when the notice appears, so the action is reachable from a
  remote without a pointer. The panel itself stays `pointer-events-none`, like the diagnostics
  overlay, so it never swallows a press meant for the player underneath.
- **Deference.** Hidden while the settings popup, the episode picker, the diagnostics overlay or the
  QR export is up. The state is terminal and will still be there afterwards; stealing focus from a
  popup would be worse than waiting.

It deliberately says nothing while recovery is still running. Reporting every retry would train a
viewer to ignore it, and while a budget remains there is a real chance playback resumes.

## Error Reporting

Playback failures are reported to Sentry as well as shown on screen. The QR capture remains the
reliable path for a stall, because the network is exactly what breaks then; Sentry covers the more
common case of the app or the backend misbehaving while the connection is fine.

Reported conditions, all of them states the player could not resolve on its own:

- `fatal-network-recovery-exhausted`
- `fatal-media-recovery-exhausted`
- `fatal-unrecoverable`
- `stall-watchdog-exhausted`
- `decode-health-severe`

### Recovery episodes

A single error report cannot answer the question that matters — _did the recovery work?_ — because
the answer is in what happens next. So failures are tracked as **episodes**: everything between the
first fatal error and the moment playback either resumes or is given up on.

Each recovery step becomes a Sentry breadcrumb (`fatal-retry`, `media-recover`, `watchdog-restart`,
`watchdog-reload`, `… budget exhausted`), and one event is sent when the episode concludes:

- **recovered** — playback moved again. The tag `playback_recovered_after` names the last action
  taken, which is the field worth grouping on: it says which recovery path actually beats this
  failure.
- **abandoned** — playback never came back. The `playback_episode_ended_by` tag says how the episode
  ended, which matters more than it sounds:

  - `grace-period` — the player ran out of options: every budget was spent and nothing resumed
    within 30 s. The deadline is armed when a budget runs out and pushed back by any further
    recovery action, because the budgets escalate on different clocks — the fatal one gives up after
    about half a minute while the watchdog is only starting its 8 s restart and three 20 s reloads,
    and a fixed deadline from the first would fire in the middle of the second. Re-arming on an
    _action_ is safe where re-arming on exhaustion was not: actions are bounded, so the deadline can
    only move a bounded number of times. This is the only ending reported at `error` level.
  - `teardown` — the player went away mid-recovery: the viewer pressed Back, or moved to another
    episode. This is the most likely way a broken playback ends, and it was previously **not
    reported at all** — the tracker was only closed on a source change, never on unmount, so every
    abandonment statistic described the minority of viewers who waited out the grace period.
  - `source-change` — a new source replaced the failing one, e.g. a quality change.
  - `manual-retry` — the viewer retried from the failure notice.

  The last three are recorded at `warning` level: someone ended the episode deliberately, which is
  worth knowing but is not the player failing.

Volume is the binding constraint. The failure under investigation emits roughly three errors a
second; breadcrumbing each would fill Sentry's 100-entry buffer in about half a minute and evict
exactly the early context that explains the episode. Repeated errors are therefore counted and
summarised at most once every 10 s, while the rare, meaningful steps are recorded individually. The
full per-category counts still travel in the episode summary.

An episode is resolved by the _same evidence that refills the retry budget_: a media fragment
buffering on the stream that was failing (`provesStreamRecovered`). Position moving is deliberately
not enough. A fatal error stops hls.js's loading engine, so playback carrying on afterwards is the
buffer draining, and crediting that to whichever retry happened to be in flight would make
`playback_recovered_after` — the one field worth grouping on — lie. The episode also stays open
until a recovery action has actually been attempted, otherwise one failure arrives as two unrelated
reports.

Arming the abandonment deadline is idempotent per budget. The watchdog re-enters its exhausted
branch on every tick while playback stays stalled, and re-arming there would push the deadline out
faster than time passes, so the abandoned episode would never be reported at all.

Failures the player tries to recover from are reported _only_ as episodes. The standalone
`logPlaybackIssue` path is limited to `decode-health-severe`, which is not an episode; sending both
would tell the same story twice and spend twice the quota. The stream context those reports carried
— quality, streaming type, level count, bandwidth estimate — moves onto the episode summary.

The state machine is in `src/utils/playbackEpisode.ts` with unit tests; `sentryEpisodeSink` in
`src/utils/logging.ts` is the only part that touches Sentry.

### Backend failures

Playback is not the only thing that breaks, and for a while it was the only thing that reported.
`src/api/base.ts` caught every failure and returned `{ error }`, so a backend that was down, an
error page from something in front of the API, and a genuine empty result were indistinguishable —
with the HTTP status already discarded. The API client now reports three kinds:

| Kind          | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `unreachable` | The request never completed — no route, DNS failure, connection dropped. |
| `http`        | An unsuccessful status.                                                  |
| `malformed`   | Answered, but not with JSON.                                             |

The return contract is deliberately unchanged — the parsed body on any answer, `{ error }` when
something threw — because callers depend on it; the OAuth device flow reads `response.error` to
decide whether pairing is still pending. Reporting sits beside the existing behaviour rather than
reshaping it.

Two exemptions, both for responses that are normal rather than faulty: **401**, which is a token
expiring on schedule, and **unsuccessful statuses from the one OAuth request that polls** — the
`device_token` grant, which pairing repeats every ten seconds and which expects them until the user
confirms on another device. The other OAuth grants are deliberately not exempt: `device_code` starts
pairing and `refresh_token` renews a session, both single requests that expect to succeed, and a
broken refresh logs the viewer out. Hiding those would suppress the failure most worth hearing
about. Transport failures are reported on every request, polling included — an unreachable endpoint
is a fault whoever it belongs to.

What reaches Sentry is the normalised path, method and status: query strings are stripped, since
every authenticated request carries `access_token` there, and numeric path segments become `{id}`,
so one broken endpoint is one group rather than thousands of tags that could be used to reconstruct
what somebody watched. One report per endpoint per kind per session, on the same reasoning as
`logPlaybackIssue`. A 5xx is recorded at `error` level; everything else is a warning. The rules are
in `src/utils/apiFailures.ts` with unit tests, because both of the ones that matter fail silently —
a leaked token is not visible from inside, and a reporting flood is only noticed once the quota is
gone.

### What leaves the TV, and where it goes

Sentry is the only telemetry destination. That is a deliberate narrowing, not an accident of what
happened to be wired up.

An inherited Google Analytics tag (`G-2QFN9YLY57`, upstream's property) used to load
`googletagmanager.com` on every app start and forward Web Vitals to it. It was removed along with
`utils/analytics.ts`, `reportWebVitals.ts` and the `web-vitals` dependency, for three reasons:

- the data went to a third party and was invisible to whoever debugs this fork — the same argument
  that motivated replacing the inherited Sentry DSN, which had been applied to one channel and not
  the other;
- it was duplicative. `@sentry/tracing`'s `BrowserTracing` integration already records CLS, LCP,
  FID, FCP and TTFB as measurements on the pageload transaction, which is the same five metrics the
  GA callback forwarded;
- on the TV it collected almost nothing anyway. The app is not served over http there — that is
  what makes `IS_WEB` false and selects `MemoryRouter` — so navigation never changes the URL and no
  page view after the first is ever recorded, while the tag still costs a third-party request at
  startup.

If product analytics are wanted later, add a property this fork owns and wire it deliberately.
Nothing in the app depends on the removed code.

Two rules keep this useful:

- **One report per issue per playback session.** The failure this project has been chasing produces
  a few hundred errors a minute; reporting each would bury the signal and burn the quota in one
  evening. The interesting fact is that a session hit a wall, not how many times it bounced off it.
  The guard resets when a new source loads.
- **Hostnames only.** Stream URLs carry access tokens and appear in messages, breadcrumbs and
  request data alike, so `beforeSend` and `beforeBreadcrumb` reduce every URL in an outgoing event
  to its hostname — the same rule the overlay follows.
