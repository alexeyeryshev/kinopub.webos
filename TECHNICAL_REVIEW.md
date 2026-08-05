# Technical Review

One-time, evidence-based review of this fork. Written against the working tree at commit
`d44a4b4` (branch `claude/hls-diagnostics-expansion-1g5u0q`, content-identical to `origin/master`
at `ccab33e`), reading the current code, tests, documentation and Git history rather than the
history of the conversations that produced them.

Everything below cites a file, a line, a command, or a workflow run. Where a claim could not be
established from the repository, it says so instead of asserting it.

This is a snapshot, not a live status page: findings describe the tree at that commit, and line
numbers drift as the code moves. `ROADMAP.md` tracks what has since been addressed — each item there
carries the finding it came from.

---

## 1. Executive assessment

This is a small React/Enact webOS TV client that, over 46 commits on top of upstream, grew a
substantial playback-diagnostics and failure-recovery subsystem. The engineering quality of that
subsystem is high in a specific and unusual way: the three most subtle rules in it
(`hlsRecovery`, `decodeHealth`, `playbackEpisode`) were extracted into pure modules with 41 unit
tests, precisely because each of them had already failed silently once. That instinct — "this broke
without anyone noticing, so it must become testable" — is the strongest thing in the repository.

The weakness is the mirror image of that strength. The work has been almost entirely inward-facing:
it has become very good at _observing_ the failure and increasingly good at _not making it worse_,
but almost nothing has been added that a viewer sitting in front of the TV would experience. When
every recovery budget is spent, the application still shows a frozen picture and says nothing
(§4.1). When the viewer does what people actually do — press Back and give up — the recovery episode
that was being assembled for Sentry is discarded unsent (§4.2), which means the telemetry is biased
toward the rarer case where somebody waited. The observation layer and the reporting layer both stop
one step short of the moment that matters to a user.

There is also a category of drift that a review is the right instrument to catch. The session that
replaced the upstream Sentry DSN did so on an explicit privacy argument — telemetry was going to a
third party — and then left an inherited Google Analytics tag loading `googletagmanager.com` on every
app start (§4.9). The `master` branch is published to GitHub Pages, so that same bundle, carrying the
fork owner's Sentry DSN, is served to anonymous web visitors (§4.13). And the API client, the one
layer that touches the backend the owner says is most often at fault, catches every failure and
reports none of it (§4.10). These are not disagreements about design; they are places where a
decision was made and then not carried through.

Two of the specification documents now contradict themselves and the code
(§4.15, §4.16). That matters more than a typo would, because the specs are the only place the
_reasoning_ is recorded, and a spec that is wrong in one visible place cannot be trusted in the
places a reader cannot check.

Overall: the recovery machinery is in a defensible state and should not be extended further until
the two user-facing gaps above are closed and the reporting channel is honest about what it collects
and where it sends it.

**Confidence about the TV itself is low, and the review does not pretend otherwise.** Nothing here
was executed on a television. The only device evidence in the repository is prose in `ROADMAP.md`
describing two LG G5 captures; the captures themselves are not committed, and there is no fixture,
log, or test derived from them. Every statement below about on-device behaviour is therefore either
attributed to that prose or explicitly marked unverified.

---

## 2. Repository and architecture map

**Stack.** React 17.0.2 + Enact/Moonstone 4.0.x, TypeScript 4.4.2 (`strict: true`), built by
`react-scripts` 4.0.3 / webpack 4 through `@craco/craco`, styled with Tailwind
(`@tailwindcss/postcss7-compat`). Packaged into a webOS IPK by `@webosose/ares-cli`.
`.browserslistrc` targets `chrome 35`; `src/polyfills.ts` imports the whole of `core-js`.

**Shape.** `src/index.tsx` → `src/App/App.tsx` (Moonstone decorator, react-query client, 22
lazy-loaded views behind `components/router` + `containers/views`) → per-view containers → a shared
component library. Data access is `src/api/kinopub.ts` over `src/api/base.ts`; persistence is a
single namespaced `localStorage` blob in `src/storage.ts` with a subscribe/notify bridge
(`hooks/useStorageState.ts`).

**The playback path**, which is where nearly all fork work lives:

| Concern                                                           | File                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Player shell, remote keys, badges, overlays                       | `src/components/player/player.tsx`                                |
| In-player settings popup                                          | `src/components/player/settings.tsx`                              |
| Video element, HLS lifecycle, recovery, watchdog, decode sampling | `src/components/media/media.new.tsx`                              |
| Diagnostics overlay and capture assembly                          | `src/components/player/playbackDiagnostics.tsx`                   |
| QR export encoding                                                | `src/components/player/diagnosticsExport.ts`, `diagnosticsQr.tsx` |
| Reference decoder (Node)                                          | `scripts/decode-diagnostics.js`                                   |
| Decode-health badge                                               | `src/components/player/decodeHealthIndicator.tsx`                 |
| Pure rules, unit-tested                                           | `src/utils/{hlsRecovery,decodeHealth,playbackEpisode}.ts`         |
| Shared failure taxonomy                                           | `src/utils/hlsFailures.ts`                                        |
| Level ↔ quality-name normalisation                                | `src/utils/hlsLevels.ts`                                          |
| Sentry init, scrubbing, episode sink                              | `src/utils/logging.ts`                                            |

**Remote-key handling** is a single global `keydown` listener with a manually ordered handler stack
(`src/utils/keyboard.ts:37-77`). Handlers are _prepended_ on registration, and the listener
`await`s each matching handler in sequence, breaking only when one returns `false`. The resulting
order is an accident of mount timing, not an invariant: the last component to register runs first,
and any handler that re-registers jumps back to the front. It is load-bearing anyway; see §4.11.

**Four independent timers** run during playback: the stall watchdog (2 s,
`media.new.tsx:597`), decode sampling (2 s, `media.new.tsx:708`), the decode-badge poll (2 s,
`player.tsx:220`), and the diagnostics target sync (1 s, `playbackDiagnostics.tsx:638`), plus a
fifth (1 s snapshot, `playbackDiagnostics.tsx:803`) while the overlay is open, plus the time-sync
interval (30 s, `player.tsx:209`). Each has a matching cleanup; all were checked individually.

---

## 3. Fork delta

**Lineage.** `package.json` names `https://github.com/adascal/kinopub.webos` as the repository. Git
history shows three authorship eras: Alexandr Dascal (43 commits, the original project),
`alexeyeryshev` (10 commits, ending at `58bd3ea`, 2026-03-07), then this fork.

**No upstream remote is configured** — `git remote -v` shows only `origin`
(`kaaburgh/kinopub.webos`), and the sandbox has no network path to `github.com/alexeyeryshev`. The
fork delta below is therefore computed from the _local_ history boundary (`58bd3ea..HEAD`), which is
sound because the fork's commits sit linearly on top of it. What could **not** be checked is whether
`alexeyeryshev/kinopub.webos` or `adascal/kinopub.webos` has moved on since `58bd3ea`; there may be
upstream fixes this fork is missing, and this review cannot say either way.

**Delta:** 40 files, +5462 / −150 (`git diff --stat 58bd3ea..HEAD`).

| Area                                | What the fork added                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Diagnostics                         | The entire overlay (1107 lines), QR export pipeline (382 + 53 + 347 lines), spec + manual test checklist (446 + 180 lines) |
| Playback recovery                   | Fatal-error recovery, stall watchdog, per-stream budgets, decode-health scoring — +575 lines inside `media.new.tsx`        |
| Reporting                           | Own Sentry DSN, URL scrubbing, recovery-episode model, 41 unit tests                                                       |
| Correctness fixes to inherited code | Fixed-quality selection never pinning a level (`hlsLevels.ts`), Auto/Fixed mode made explicit, subtitle opacity control    |
| Infrastructure                      | CI, release-with-IPK, GitHub Pages deploy, PR labeler, docs-link checker, build/install and CI documentation               |

The two commits `ROADMAP.md` calls the "completed baseline" (`fc01289`, `8d1b17d`) are the fork's
own first two commits, not upstream work.

**The fork has not touched** authentication, the API surface, routing, the view layer, the service
worker, or webOS packaging, beyond the workflow files. Those areas are inherited as-is and are where
most of §4's non-playback findings sit.

---

## 4. Findings by area

Priorities follow the model in `ROADMAP.md`. Confidence is stated per finding.

### 4.1 No user-visible failure state when recovery is exhausted — High

`MediaRef` exposes `error` (`media.new.tsx:132`, implemented at `:899-904`) and **nothing reads
it**: `grep -rn "\.error\b" src/components/player src/views/video src/components/media`, excluding
`video.error` / local `encodeError` uses, returns no consumers.

Trace the end state. A fatal network error escalates through six retries with 1→2→4→8→8→8 s backoff
(`media.new.tsx:420-455`), then sets `exhausted: true` and returns (`:423-433`). The stall watchdog
then gets three playlist reloads (`STALL_MAX_RELOADS = 3`, `:66`) before it too records
`exhausted` (`:666-676`). After roughly two minutes, both budgets are spent, no further requests are
made — and the only surface that says so is the `recovery:` line inside a diagnostics overlay that
must be opened through Settings → `Диагностика воспроизведения`. The viewer sees a still frame.

This is the direct consequence of the recovery-budget fix, and it is the right trade — hammering the
CDN indefinitely was worse — but the honest reading is that the fix converted an infinite-retry
failure into a _silent_ failure, and the second half was never built.

**Confidence: high** (code, not device). Nothing establishes what Enact's `VideoPlayer` renders in
this state; that needs a TV.

### 4.2 A recovery episode is discarded when the player unmounts — High

`createPlaybackEpisodeTracker` finishes an in-flight episode as `abandoned` on `reset()`
(`playbackEpisode.ts:235-241`). `reset` is called from exactly one place: the source-change effect
body, `media.new.tsx:350`. The effect's cleanup (`:543-562`) clears timers, saves `startTime`,
removes the `canplay` listener and destroys the HLS instance — but never touches `episodeRef`.

So an episode reports only if playback resumes (`noteProgress`) or the 30 s abandonment grace
elapses while the watchdog keeps ticking (`tick`, driven from `media.new.tsx:606`). If the viewer
presses Back, or picks another episode — `views/video/video.tsx:209` keys `<Player>` on
`currentVideo.id`, so an episode change remounts the whole player — the tracker is thrown away with
its breadcrumbs.

The consequence is a measurement bias, not a crash: Sentry systematically under-reports the outcome
"the user gave up", which is the outcome a viewer is most likely to produce. Any conclusion drawn
from `playback_episode` counts today is drawn from a filtered sample.

**Confidence: high.** Fix is small (flush on cleanup), but note the episode should probably be
labelled distinctly — "abandoned by user" is a different fact from "abandoned after grace period".

### 4.3 The watchdog's playlist reload still flushes the buffer — ~~Medium~~ **WRONG, corrected below**

**This finding was incorrect and the item it produced (roadmap A7) has been dropped.** It is kept
here rather than deleted, because a review whose value rests on its claims being checkable owes a
correction where one turned out not to survive checking.

What it said: `setSourceTrack` deliberately uses `nextLevel` rather than `currentLevel`, because
`currentLevel` "flushes the whole buffer to apply the switch instantly" (`media.new.tsx:267-279`),
while the `MANIFEST_PARSED` handler still assigns `currentLevel` — so the watchdog's
`hls.loadSource(currentSrc)` re-triggers that handler and flushes the buffer during recovery.

What is actually true: **the buffer is already gone before `MANIFEST_PARSED` runs**, so which
property the level is assigned to changes nothing. `loadSource()` triggers `MANIFEST_LOADING`;
`stream-controller.onManifestLoading()` responds with `BUFFER_RESET`
(`node_modules/hls.js/dist/hls.js:9182-9189`); `BufferController.onBufferReset()` calls
`mediaSource.removeSourceBuffer()` for every buffer type (`:4341-4365`). Every watchdog reload
discards everything buffered, unavoidably — there is no public API in this version to refresh a VOD
playlist without it.

**How the error happened**, since that is the transferable part. The finding checked one mechanism
that could have destroyed the buffer — whether `loadSource` detaches and re-attaches the media
element — found that it does not when the URL is unchanged, and concluded the buffer survives. That
is a conclusion about a whole system drawn from one path through it. The `currentLevel` half of the
claim was independently verified and correct; the half that mattered was an inference presented in
the same voice as the checks around it.

The real constraint — that the reload is expensive by construction — is recorded against **A6**,
where it raises the bar for keeping the reload escalation at all.

### 4.4 A second fatal error overwrites the pending retry timer — Low

`recoveryTimeoutId` is a single slot (`media.new.tsx:330`, assigned at `:448`). hls.js runs
independent stream controllers for main and audio, each with its own retry accounting, so a second
fatal arriving inside the 1–8 s backoff window is possible; the first timer id is then lost and the
cleanup at `:546-548` clears only the last one.

The damage is limited by the `hlsRef.current === hls` guard at `:450`: after teardown `hlsRef.current`
is `null`, so an orphaned timer cannot call `startLoad()` on a destroyed instance. The realistic
failure is a duplicated `startLoad()`, which `base-stream-controller.startLoad` largely absorbs by
calling `stopLoad()` first (`dist/hls.js:8771-8775`).

**Confidence: medium** on the concurrency premise (reasoned from hls.js's controller structure, not
observed), high on the code shape. Worth tidying; not worth prioritising.

### 4.5 Verified correct — recovery interactions that were checked and hold

Recorded because a review that lists only defects gives a false picture of risk.

- **The init-segment rule matches the pinned runtime.** `provesStreamRecovered` rejects
  `frag.sn === 'initSegment'` (`hlsRecovery.ts:27`). Confirmed in
  `node_modules/hls.js/dist/hls.js:3298`: the init-segment load path triggers `FRAG_BUFFERED`
  directly. The rule is not defensive guesswork; the event really is emitted there.
- **The two budgets are genuinely independent.** `fatalRecoveryRef` and `stallRecoveryRef` are
  separate (`media.new.tsx:168-169`), cleared by different evidence, and `getRecovery()` picks by
  `lastAt` (`:188-199`), so an exhausted fatal budget does not mask an active watchdog.
- **`fatalRetryPendingRef` correctly keeps the watchdog from double-acting** during a scheduled
  retry, and it updates `lastPosition` through the wait (`:611-614`) so the drained buffer is not
  later misread as movement.
- **Every listener and timer added by the fork has a matching cleanup.** Checked individually across
  `media.new.tsx`, `playbackDiagnostics.tsx`, `player.tsx`. One exception, §4.14.
- **ES built-ins are safe against the `chrome 35` target.** The new code uses `Object.entries`,
  `String.padStart`, `Array.includes`, `Map`, `Set` — all later than Chrome 35, all covered because
  `src/polyfills.ts` imports the whole of `core-js` (3.17.0) and `src/index.tsx:1` loads it first.
  Every _DOM_ API added by this work is behind a `typeof` guard: `CompressionStream`
  (`diagnosticsExport.ts:277-286`), `TextEncoder` (`:260`), `getVideoPlaybackQuality`
  (`media.new.tsx:715-724`, `playbackDiagnostics.tsx:309-320`). This was a plausible place for a
  regression on older firmware and it is clean.

### 4.6 Event history is not reset when the HLS instance changes — Medium

The diagnostics effect keyed on `target.hls` resets `fragLoadStages`, `lastFragments`,
`bufferAppendStages`, `emergencyAbortCount`, `failureCounts`, `lastFailure` and the pending-append
map (`playbackDiagnostics.tsx:679-686`) — but not `history`.

A quality change builds a new `currentSrc`, which tears down and rebuilds the HLS instance
(`media.new.tsx:563` dependency list), so after a quality switch the Recent Events list — and the
`E|` lines of any QR capture taken afterwards — mixes two sources with no marker between them.
`docs/playback-diagnostics-spec.md:255` states diagnostic state must be "discarded when playback
unmounts"; this is the one field that is not.

**Confidence: high.** Either clear it too, or push a `source changed` marker so the mixing is visible
rather than invisible. The marker is probably better: history across a switch is sometimes what you
want to see.

### 4.7 Diagnostics collection runs for the whole session, unmeasured — Medium, investigate first

The video-event and HLS-event effects depend on `target.video` / `target.hls`, not on `visible`
(`playbackDiagnostics.tsx:645`, `:670`). The component is always mounted (`player.tsx:255`). So from
the moment playback starts, every `FRAG_LOADING`, `FRAG_LOADED`, `FRAG_BUFFERED`, `FRAG_CHANGED`,
`BUFFER_APPENDING`, `BUFFER_APPENDED`, `LEVEL_SWITCHED` and `ERROR` runs `getHlsEventDetails`
(string formatting, `:551-586`) and calls `pushHistory` → `setHistory` with a fresh 30-element array
(`:604-615`), regardless of whether anything is on screen.

This is a deliberate design — the history has to exist _before_ you open the panel — and the render
does bail out early when hidden (`:957`). But the cost has never been measured. During the failure
under investigation the roadmap records ~2.9 failed requests per second, and each `ERROR` triggers
three state updates (`setFailureCounts`, `setLastFailure`, `setHistory`); with fragment events on top
that is roughly ten React state updates per second on TV-class hardware, in the exact scenario where
the device is already struggling.

**Confidence: high that this runs; no evidence at all about its cost.** This should be measured
before it is optimised — the cheap fix (only collect while visible) would destroy the feature's main
value, so the answer is not obvious.

### 4.8 The HDR badge is a codec guess — Low

`player.tsx:77-80` derives `isHDR` from `codec` containing `hevc`, `codec === 'h265'`, or the quality
_name_ containing `hdr`. HEVC is a codec; HDR is a transfer characteristic. SDR HEVC encodes — the
common case — get an HDR badge. The `codec === 'h265'` comparison is also not lower-cased, unlike the
`hevc` test one line above, so `H265` fails it.

This matters slightly more than a cosmetic label because roadmap item 5 asks whether excessive
subtitle brightness is "primarily on HDR content", and this badge is the signal a tester would use to
decide which content is which. If the badge is wrong, the observation it supports is wrong.

**Confidence: high** on the logic. Whether the KinoPub API exposes a genuine HDR/transfer flag is not
established — `src/api/typings.ts` should be checked before proposing a fix.

### 4.9 Inherited Google Analytics still ships — High

`public/index.html:8-15` loads `https://www.googletagmanager.com/gtag/js?id=G-2QFN9YLY57` on every
app start and configures that property; `src/utils/analytics.ts` feeds Web Vitals into it, wired from
`src/index.tsx:35`.

`G-2QFN9YLY57` was inherited. The stated reason for replacing the Sentry DSN — recorded in
`docs/playback-diagnostics-spec.md:264-266`, that the DSN "belongs to the upstream project, so the
data would go to a third party and stay invisible to whoever is debugging this fork" — applies
verbatim to this tag, which was left untouched. One telemetry channel was redirected and an
equivalent one beside it was not.

**Confidence: high.** The decision (keep, repoint, or remove) belongs to the fork owner, but leaving
it unexamined contradicts a decision already made.

### 4.10 API failures are silently swallowed and never reported — High

`src/api/base.ts:56-73` wraps the whole request in `try/catch` and returns
`{ error: (ex as Error).toString() } as unknown as T` on any failure. Consequences:

- a non-2xx response is not an error at all — only a thrown `fetch` or a JSON parse failure reaches
  the catch, so an HTML error page from the CDN edge surfaces as a parse failure with the HTTP status
  already discarded;
- `response.status === 401` clears tokens (`:62-64`) and then still tries `response.json()`;
- nothing is reported. `grep -rn "logError\|logException\|Sentry"` over `src/` finds `logException`
  used **once**, in `hooks/useDeviceAuthorizationEffect.ts:53`; `logError` is exported from
  `utils/logging.ts:73` and never called.

The fork owner's stated experience is that problems are most often with KinoPub itself or with the
app. The playback path now has an elaborate reporting pipeline; the backend-facing layer, which is
where that class of problem would surface, reports nothing at all.

**Confidence: high.** This is the largest observability gap in the repository and it is outside the
area all the recent work went into.

### 4.11 No request timeout, and Back waits on a network call — Medium

`grep -rn "AbortController\|timeout" src/api/` returns nothing: no request in the application has a
deadline.

That interacts badly with the remote-key stack. `src/utils/keyboard.ts:51-61` iterates **all**
matching handlers and `await`s each one, breaking only on an explicit `false`. Registration prepends
(`:72`), so the most recent registrant runs first, and the ordering on Back is:

1. `player.tsx:243` → `handleDiagnosticsClose` (returns `false` and stops the chain only when an
   overlay is open);
2. `player.tsx:237` → `handleTimeSync`, which `await`s `watchingMarkTimeAsync` — a POST with no
   timeout;
3. `containers/views/views.tsx:54` → `handleBackButtonClick` → `history.goBack()`.

So leaving the player waits for a network round trip to complete or fail, with no bound on how long
that takes — during a network failure, which is when a viewer is most likely to press Back.

**Why that ordering holds is worth being precise about, because the obvious explanation is wrong.**
It does not follow from React running child effects before parent effects — within a single commit
that rule plus prepending would put the _parent_ first, which is the opposite of what happens
between `Views` and `Player`. The real mechanism is mount timing across commits: `Views` calls
`useButtonEffect` at `views.tsx:54`, above its `showSpinner` early return (`:57-59`), so it registers
in the first commit while it is still rendering a spinner and stays mounted; `Player` mounts much
later and prepends in front of it. Inside `Player`, `handleTimeSync` (`:237`) and
`handleDiagnosticsClose` (`:243`) register in declaration order in the same commit, so the later one
ends up first.

That makes the order an emergent property rather than an invariant, and a fragile one:
`useButtonEffect` re-registers whenever the handler identity changes (`useButtonEffect.ts:8-10`), and
re-registration prepends again. `Views`'s `handleBackButtonClick` depends on `[history, showNotice]`
(`views.tsx:28`), so a change there would move it to the front of the chain, ahead of the player's
handlers. Nothing in the current flow appears to trigger that while `Player` is mounted, but nothing
prevents it either.

**Confidence: high on the code path and on the mechanism, unverified on device.** How long webOS's
`fetch` takes to give up on a hung connection is not established here, and that number decides
whether this is an annoyance or a hang.

### 4.12 No React error boundary — Medium

`grep -rn "componentDidCatch\|ErrorBoundary"` over `src/` returns nothing. React 17 unmounts the
entire tree when a render throws and no boundary catches it, leaving `#root` empty — a black screen
on the TV, with no route back and no way to recover except killing the app from the launcher.

22 views are lazy-loaded (`App/App.tsx:12-33`); a chunk that fails to load is handled only by the
inline `window.addEventListener('error')` in `public/index.html:16-32`, which reloads on
`ChunkLoadError` specifically. Every other render-time throw produces the black screen.

Sentry's default `GlobalHandlers` integration does report the uncaught error, so the _diagnosis_ path
exists; the _recovery_ path does not.

**Confidence: high.**

### 4.13 `master` is published to GitHub Pages with the fork owner's Sentry DSN — Medium

`.github/workflows/deploy-pages.yml` builds every push to `master` and publishes `build/` to
`gh-pages`; `git ls-remote --heads origin` confirms the `gh-pages` ref exists
(`a6dc3619`). The published bundle contains the DSN from `src/utils/logging.ts:16` and the
`REACT_APP_KINOPUB_API_CLIENT_SECRET` committed in `.env`.

Two consequences worth a deliberate decision: playback errors from anonymous web visitors are
attributed to the owner's Sentry project and consume its quota, and the DSN is a public ingest
endpoint that anyone reading the bundle can post to. (The API client id/secret are the well-known
public XBMC/Kodi KinoPub credentials, so committing them is not a new exposure — but it is worth
knowing that is why it is acceptable, rather than assuming it.)

**Confidence: high** that this is the configuration; **no view** on whether the Pages deployment is
wanted — that is the owner's call.

### 4.14 Small cleanups — Low

- **Dead module with a live type import.** `src/components/media/media.tsx` (218 lines, the legacy
  Enact class implementation) is reachable from nothing — `src/components/media/index.ts` re-exports
  `media.new` only — _except_ `src/views/video/video.tsx:6`, which imports the type `SourceTrack`
  from `components/media/media`. That type differs from the live one (no `number`, no `default`, no
  `type`), and it types the `onSourceChange` callback three lines above a `// @ts-expect-error`
  (`video.tsx:221`). Both halves of the mismatch are invisible to `tsc` as a result.
- **Unbalanced style element.** `player.tsx:194-203` appends `#subtitle-opacity-style` to
  `document.head` and never removes it, so it outlives the player. Harmless (`video::cue` matches
  nothing outside playback) but it is the one lifecycle asymmetry in otherwise careful cleanup code.
- **`type MediaEvents = keyof typeof MEDIA_EVENTS`** (`media.new.tsx:1075`) is inherited and wrong:
  `MEDIA_EVENTS` is a readonly _array_, so this resolves to array members, not the event names. The
  intent was `typeof MEDIA_EVENTS[number]`. The `Partial<Record<MediaEvents, Function>>` below it is
  therefore not checking anything. No runtime effect.
- **`scripts/package.js:12`** builds IPKs under the app ids `netflix`, `amazon`, `ivi`, `youtube`,
  `ui30` in addition to the real one. Inherited, and `docs/build-and-install.md` tells the reader to
  install only the un-suffixed package, so nothing is broken — but it deserves a conscious decision
  rather than inheritance.

### 4.15 The diagnostics spec contradicts the code and itself — Low, but corrosive

`docs/playback-diagnostics-spec.md:389-395` lists five reported conditions:
`fatal-network-recovery-exhausted`, `fatal-media-recovery-exhausted`, `fatal-unrecoverable`,
`stall-watchdog-exhausted`, `decode-health-severe`. In the code, `PlaybackIssue` is a single member:
`'decode-health-severe'` (`src/utils/logging.ts:88`). The same document says so correctly 35 lines
later (`:430-433`) — "the standalone `logPlaybackIssue` path is limited to `decode-health-severe`" —
so the document states both things.

Separately, `:264-266` still says sending to "the Sentry DSN already present in
`src/utils/logging.ts` … is not an option … it belongs to the upstream project". The DSN was
replaced (`logging.ts:16`) and the same document's Error Reporting section (`:385-387`) describes
active Sentry reporting.

Both are leftovers from earlier decisions that were later reversed and not swept up. The specs are
the only place the reasoning is recorded; where they are demonstrably stale, a reader has no way to
tell which of the unverifiable parts are also stale.

**Confidence: high** — both contradictions are between two files, or two paragraphs, that can be read
side by side.

### 4.16 CI configuration and docs claim there are no tests — Low

`.github/workflows/ci.yml:41-42`: "The project currently has no test files". `docs/ci.md:36-37`:
"There are no test files yet. The test step uses `--passWithNoTests`". There are three suites and 41
tests, and they are the load-bearing safety net for the three subtlest rules in the codebase. The
`--passWithNoTests` flag now silently permits a future state where the suites stop being discovered.

**Confidence: high.**

---

## 5. Review of recent implementations

This section re-reads the fork's own recent work against the current tree, on the assumption that it
might be wrong.

**`hlsRecovery.provesStreamRecovered` — holds up.** Both rules are correct against the pinned
runtime, and the init-segment rule was checked against `dist/hls.js:3298` rather than taken on
faith (§4.5). 9 tests. One limitation the module does not state: the stream-matching rule
(`hlsRecovery.ts:34`) compares against `recoveringStream`, set from `data?.frag?.type` at the moment
of the fatal error (`media.new.tsx:418`). A fatal _manifest_ error carries no `frag`, so
`recoveringStream` stays `undefined` and any fragment then counts as proof. That is probably right —
a manifest failure is not stream-specific — but it is an unstated assumption in a module written
specifically because its assumptions had been wrong before.

**`decodeHealth` — well-constructed, thresholds unvalidated.** The metric choice (ratio over a
sliding window rather than cumulative counts) is sound and well-argued, the counter-reset guard
(`decodeHealth.ts:99-105`) and the paused-playback guard (`media.new.tsx:732`) are real
false-positive defences, and 16 tests cover them. But `DECODE_WARNING_RATIO = 0.01` /
`DECODE_SEVERE_RATIO = 0.05` are, by the module's own admission, not normative
(`decodeHealth.ts:4-5`). Nothing in the repository shows what an LG G5 reports during clean playback.
If its baseline is above 1%, the badge is permanently yellow and worthless. **This is the single
most likely place for the recent work to be quietly wrong**, and it is cheap to check: one clean
playthrough with the overlay open.

**`playbackEpisode` — the design is right; the coverage has a hole.** Modelling a _recovery episode_
rather than isolated errors is the correct answer to "did the recovery work", and
`playback_recovered_after` is genuinely the field worth grouping on. The idempotent `noteExhausted`
(`playbackEpisode.ts:190-201`) fixes a defect that would have suppressed every `abandoned` report,
and it has a test that states the failure explicitly (`playbackEpisode.test.ts:193-216`). The hole is
§4.2: the state machine handles every ending except the most common one, because the _caller_ never
tells it the player is going away. The tests cannot catch that — it is an integration gap between a
well-tested module and its single call site, and the pattern is worth noting: three pure modules with
41 tests, and zero tests over `media.new.tsx`, which is where all three are wired together and where
both High findings live.

**Per-stream fragment labelling (`d44a4b4`) — correct and correctly explained.** The rule is
consistently applied at all four sites that resolve a level (`playbackDiagnostics.tsx:412`, `:434`,
`:701`, and `formatFragmentLevel` at `:507`), and the manual-test checklist gained a section that
tells a tester what to look for and why (`docs/playback-diagnostics-manual-test.md:87-96`). No issues
found.

**The QR export — sound, with one property worth restating.** Base32-for-alphanumeric-mode is a real
optimisation, the chunk-header validation on both sides is right, and refusing to emit a payload the
reference decoder would reject (`diagnosticsExport.ts:369`) is the correct failure mode. The property
worth restating is the one the spec already names as a rule (`:332-334`): the export must carry
everything the overlay shows. It currently does not carry the per-stream `lastFragments` — only
`lastFragments.main` (`playbackDiagnostics.tsx:865`) — so the audio/video distinction that
`d44a4b4` added to the _screen_ is absent from the _capture_. Given a capture is how the fork owner
reports what they saw, that is a live instance of the drift the spec warns about, introduced by the
most recent commit.

**The Sentry migration — half-done, as §4.9 and §4.10 describe.** The scrubbing itself
(`logging.ts:43-63`, applied via both `beforeSend` and `beforeBreadcrumb`) is thorough and recursive,
and `maxBreadcrumbs: 100` plus error aggregation is a well-reasoned pairing. What is missing is
everything outside the playback path.

**Where earlier assumptions were invalidated, recorded plainly:**

| Assumption                                                   | What invalidated it                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The LG G5 stall is buffer starvation                         | Device capture: `bandwidthEstimate` 22–40 Mbps against a 2.1 Mbps top level, with `fragLoadError` / `HTTP 0`. Recorded at `ROADMAP.md:49`.  |
| Levels can be matched by `height` equality                   | Fails on non-16:9 encodes; nothing was ever pinned and ABR silently stayed on. `hlsLevels.ts:10-19`.                                        |
| Any `FRAG_BUFFERED` proves the stream recovered              | Init segments count, so recovery refilled its own budget forever. `hlsRecovery.ts:22-29`.                                                   |
| Sentry is not worth having because the network is what fails | Only true for stalls; the app and backend fail with the network up. `logging.ts:7-13`.                                                      |
| Quality can be switched with `currentLevel`                  | It flushes the buffer, converting a survivable outage into a stall. `media.new.tsx:267-273` — and still not applied at `:518`/`:531`, §4.3. |
| `bufferFullError` is buffer starvation                       | It is the opposite condition. `hlsFailures.ts:11-18`.                                                                                       |
| An audio fragment's `level` indexes `hls.levels`             | It indexes the audio track list. `playbackDiagnostics.tsx:408-411`.                                                                         |

---

## 6. Validation performed

All commands run from the repository root at `d44a4b4`, in the review sandbox (Node v22.22.2, Yarn
1.22.22). Nothing was repaired to make a check pass.

| #   | Command                                                                                         | Result                                                                                                                                                                   | What it proves — and does not                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `git status`, `git branch -vv`, `git remote -v`                                                 | Clean tree, branch tracks `origin/…-1g5u0q`, single remote `origin`                                                                                                      | The review reads the fork, not an upstream checkout. No upstream remote exists, so no upstream comparison was possible (§3).                                                                                      |
| 2   | `git fetch origin master`; `git diff --name-only HEAD origin/master`                            | Fetched `ac3551a..ccab33e`; diff empty                                                                                                                                   | HEAD is content-identical to `origin/master`; PR #13 merged. Reviewing HEAD reviews shipped code.                                                                                                                 |
| 3   | `yarn typecheck`                                                                                | Pass, 11.5 s                                                                                                                                                             | `tsc --noEmit` is clean under `strict`. Does not cover the `@ts-expect-error` sites (`video.tsx:221`, `media.new.tsx:768`) or the broken `MediaEvents` type (§4.14).                                              |
| 4   | `yarn lint`                                                                                     | Exit 0, no errors or warnings                                                                                                                                            | ESLint + Prettier-as-rule clean. One benign `react-eslint` notice about `TSNonNullExpression`.                                                                                                                    |
| 5   | `yarn format:check`                                                                             | "All matched files use Prettier code style"                                                                                                                              | Formatting is consistent, including the docs this review edits.                                                                                                                                                   |
| 6   | `CI=true yarn test --watchAll=false`                                                            | 3 suites, 41 tests, all pass, 1.9 s                                                                                                                                      | The three pure rule modules behave as specified. Proves nothing about `media.new.tsx`, `playbackDiagnostics.tsx`, or any React component — none has a test.                                                       |
| 7   | `node ./scripts/check-docs-links.js`                                                            | "All relative links … resolve"                                                                                                                                           | Relative Markdown links resolve. External URLs are not requested by design.                                                                                                                                       |
| 8   | `yarn build`                                                                                    | **Fail**, `ERR_OSSL_EVP_UNSUPPORTED` at `webpack/lib/util/createHash.js:135`                                                                                             | Environmental, not a code defect: webpack 4's MD4 hashing against OpenSSL 3 on Node 22. `.nvmrc` pins Node 14 and `.github/actions/setup-node-yarn` enforces it. Left failing deliberately.                       |
| 9   | GitHub Actions run `30903800595` (`master` @ `ccab33e`), jobs API                               | All 3 jobs success; "Build and package" green including _Build app_, _Package app_, _Check the installable package exists_                                               | `yarn build` and `yarn package` do succeed on the supported Node 14 toolchain, and the versioned IPK is produced. Verified against the API, not from memory. Does **not** prove the IPK installs or runs on a TV. |
| 10  | `grep -rn "\.error\b"` over player/media/video                                                  | No consumers of `MediaRef.error`                                                                                                                                         | Evidence for §4.1.                                                                                                                                                                                                |
| 11  | `grep -rn "logError\|logException\|Sentry"` over `src/`                                         | `logException` once; `logError` never                                                                                                                                    | Evidence for §4.10.                                                                                                                                                                                               |
| 12  | `grep -rn "AbortController\|timeout" src/api/`                                                  | No matches                                                                                                                                                               | Evidence for §4.11.                                                                                                                                                                                               |
| 13  | `grep -rn "componentDidCatch\|ErrorBoundary"` over `src/`                                       | No matches                                                                                                                                                               | Evidence for §4.12.                                                                                                                                                                                               |
| 14  | Read `node_modules/hls.js/dist/hls.js` at `:3298`, `:16724-16741`, `:16835-16839`, `:8771-8775` | Init-segment `FRAG_BUFFERED` confirmed; same-URL `loadSource` does not detach media; `currentLevel` calls `immediateLevelSwitch()`; `startLoad` calls `stopLoad()` first | Evidence for §4.3, §4.4, §4.5, against the pinned 1.0.10 runtime rather than upstream docs.                                                                                                                       |
| 15  | `git ls-remote --heads origin`                                                                  | `gh-pages` present at `a6dc3619`                                                                                                                                         | Evidence for §4.13 — the Pages deployment is live, not merely configured.                                                                                                                                         |
| 16  | Read `src/polyfills.ts`, `src/index.tsx`, `.browserslistrc`                                     | `import 'core-js'` loaded first; target `chrome 35`                                                                                                                      | Evidence for §4.5's compatibility conclusion.                                                                                                                                                                     |

**No device testing was performed.** No LG television, emulator, or browser session was used. No
statement in this document about how the application behaves on a TV is validated by this review; the
device claims that exist are attributed to the LG G5 capture prose in `ROADMAP.md`, whose underlying
captures are not in the repository.

---

## 7. Blind spots and unresolved questions

Things this review could not settle, roughly in order of how much they would change the picture.

1. **Why the CDN answers `HTTP 0` for specific segments after a seek.** The application-side freeze
   is understood and fixed; the trigger is not. `ROADMAP.md:49` records two different segments on the
   same title and host while the opening of the file buffered normally. Unknown: whether it is
   seek-specific, segment-specific, edge-specific, or account/token-related. The discriminating
   experiment — play sequentially to the same timestamp without seeking — has not been run.
2. **Whether the stall watchdog actually rescues anything.** Three reloads at 20 s intervals is a
   guess. `playback_recovered_after` was built to answer this and no data from it appears anywhere in
   the repository. Until it does, `STALL_MAX_RELOADS`, `STALL_RELOAD_AFTER` and the escalation shape
   are unfalsified.
3. **Decode-health thresholds against a real panel.** §5. One clean playthrough settles it.
4. **The cost of always-on diagnostics collection on TV hardware.** §4.7. No measurement exists.
5. **Whether upstream has moved.** §3. No upstream remote, no network access to one. There may be
   fixes in `alexeyeryshev/kinopub.webos` or `adascal/kinopub.webos` that this fork is missing, and
   this review cannot say.
6. **Whether the app still works on older webOS.** `README.md` claims webOS v3+; the ES built-ins are
   covered (§4.5) but nothing has been run on webOS 3/4, and the fork has added `ReadableStream`
   usage (behind a guard), inline SVG, CSS grid (`playbackDiagnostics.tsx:976`), and `gap` on **flex**
   containers (`:932`, `:978`, `:1061`) — the last of which is Chrome 84 and cannot be polyfilled. On
   a webOS 4 panel (Chrome 53) the diagnostics sections would sit flush against each other rather
   than fail outright, but this is unverified.
7. **HDR and subtitle rendering.** Roadmap item 5's reproduction steps have never been executed;
   whether `::cue` opacity is honoured by the webOS compositor in HDR is unknown, and §4.8 shows the
   HDR signal a tester would rely on is itself unreliable.
8. **Whether the service worker can serve a stale bundle after an IPK upgrade.** `src/index.tsx:24`
   registers it and `src/service-worker.ts` precaches the whole build. The interaction between
   Workbox precaching and an IPK reinstall on webOS was not investigated.
9. **Enact `VideoPlayer`'s own error UI.** §4.1 asserts the _application_ shows nothing; what the
   Moonstone component renders in a `NETWORK_NO_SOURCE` state was not determined, and it may already
   provide something to build on.
10. **Focus and spotlight behaviour around the overlays.** The panels are `pointer-events-none` with
    one `pointer-events-auto` button (`playbackDiagnostics.tsx:962`, `:966`); whether Spotlight can
    reach that button without a Magic Remote pointer, and where focus lands when the export view
    closes, was not traced through Enact and is not covered by the manual checklist beyond "activate
    the QR button (Magic Remote pointer)".
