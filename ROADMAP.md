# Kinopub webOS Roadmap

This roadmap tracks the work remaining after the playback-diagnostics baseline.

It was restructured after the repository-wide review in [`TECHNICAL_REVIEW.md`](./TECHNICAL_REVIEW.md).
The original priority list is preserved below with an audit verdict against each item, so the LG
device findings recorded against those items stay readable in their original context; work that is
still live has been consolidated into **Active roadmap**, where each item carries the full field set.

## How to read this roadmap

**Statuses**

| Status                           | Meaning                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Completed and verified           | Implemented, and checked by tests or by evidence beyond "it compiles"          |
| Completed, validation incomplete | Implemented, but nothing has confirmed it behaves as intended where it matters |
| Partially implemented            | Some of the described scope shipped; the rest is named explicitly              |
| Open                             | Not started                                                                    |
| Investigation first              | The next step is to learn something, not to build something                    |
| Blocked on device evidence       | Cannot be decided without a television                                         |
| Superseded                       | Replaced by a later item; kept for the reasoning                               |
| Dropped                          | No longer worth doing, with the reason                                         |

**Priority model**

| Priority | Meaning                                                                            |
| -------- | ---------------------------------------------------------------------------------- |
| Critical | Playback is broken or user data is exposed, with no workaround                     |
| High     | Users hit it, or it blocks understanding of the failure this project exists to fix |
| Medium   | Real but bounded: robustness, correctness of diagnosis, maintainability            |
| Low      | Cleanup, documentation, or work whose value is not yet established                 |

Nothing is currently Critical. Priorities describe consequences, not enthusiasm.

**Confidence** states what the item's premise rests on: `code` (read in this repository), `runtime`
(checked against the pinned `hls.js` build), `device` (observed on a TV), or `assumed`.

---

## Completed baseline

The first two commits of this fork already cover:

- [Playback diagnostics overlay](https://github.com/kaaburgh/kinopub.webos/commit/fc01289438057a42675ad6ab1c317d0ebe2582fe)
  - native video and HLS state;
  - buffered ranges and buffer-ahead time;
  - HLS levels, selected level, bandwidth estimate, and recent events;
  - fragment, error, and decode metrics;
  - bounded in-memory event history;
  - manual LG webOS test checklist and implementation spec.
- [TypeScript and void-return cleanup](https://github.com/kaaburgh/kinopub.webos/commit/8d1b17dac475ace6863c5858e9e520b8e72f52d9)
  - typed access to the Enact video node;
  - defensive handling when the video node is not available;
  - removal of misleading return values from void storage operations.

The remaining work should build on that baseline instead of reimplementing it.

---

## Audit of the original priority list

The six items below are the roadmap as it stood before the review. Their text is unchanged; each has
gained an **Audit** verdict. Live remainders are carried forward into **Active roadmap** and are not
restated here.

### 1. P0 — Validate the real failure on the LG G5

> **Audit: Completed and verified, in part.** The stall's mechanism was identified on the TV and the
> application defect behind it was fixed. Two things this item asked for were never done and are
> carried forward: the underlying cause of the CDN's `HTTP 0` (→ **A6**), and the fixed-quality /
> adaptive / 720p-vs-1080p comparison sweep, which is now folded into the on-device validation items
> **A5** and **A7**.

Run the checklist in `docs/playback-diagnostics-manual-test.md` on the TV with the stream that previously stalled while the same content continued playing on the laptop.

Capture at least:

- normal playback;
- the first visible stall;
- recovery after the stall;
- fixed-quality playback;
- an adaptive/master-playlist stream, if available;
- the same title at the available 720p and 1080p levels.

At each stall, record the last few overlay states:

- buffer ahead and whether the current position is buffered;
- time since the last successfully buffered fragment;
- HLS error and HTTP status, if any;
- native video events;
- current/next/load level;
- dropped-frame information, if supported.

The earlier working hypothesis was buffer starvation rather than an obvious decoder or raw-bandwidth failure. Treat that as a hypothesis to verify, not as an implementation assumption.

**Validated on the LG G5.** The hypothesis was wrong: this is not buffer starvation and not a bandwidth limit. Overlay captures show repeated `fragLoadError` / `HTTP 0` responses from the CDN host while `bandwidthEstimate` sat at 22-40 Mbps against a 2.1 Mbps top level. The freeze itself was an application defect rather than a network one: hls.js escalated to a _fatal_ network error, which permanently stops its loading engine, and the player had no `ERROR` handler, so nothing ever restarted it. The overlay showed the same fragment stuck `loading` for 100 s, no further `FRAG_LOADING` events, and failure counters frozen; seeking did not restart loading either. Fixed by driving recovery from the application (see item 4 notes). Still open: why the CDN returns `HTTP 0` in the first place.

### 2. P0 — Complete diagnostics around the HLS fragment lifecycle

> **Audit: Completed and verified.** Everything listed shipped, and the trickiest part — that
> `frag.level` indexes the audio track list for audio fragments — was found on the TV and fixed
> across all four call sites. Two follow-ups remain and are carried forward: the QR capture does not
> yet carry the per-stream fragment detail the overlay now shows (→ **A8**), and the cost of the
> always-on collection has never been measured (→ **A11**). Do not re-propose the lifecycle
> instrumentation itself.

Implemented: the overlay now covers fragment load start/completion, buffer append start/completion,
emergency aborts, and a network/buffer-starvation/media-decode/other failure breakdown. See
`docs/playback-diagnostics-spec.md` (Segment Loading, Errors) and
`docs/playback-diagnostics-manual-test.md` (Segment Pipeline, Network Interruption, Buffer Starvation) for
the current behavior and manual test steps. The remaining bullets below describe the scope that was covered.

The current overlay already observes buffered fragments, level switches, and errors. Extend it only where the pinned HLS.js version exposes the events reliably:

- fragment load start/completion;
- buffer append start/completion;
- fragment load timeout or emergency abort;
- a clearer distinction between network failure, buffer starvation, media/decode failure, and normal level switching.

Keep the existing privacy and bounded-history rules:

- show hostnames only;
- never show full URLs, query parameters, cookies, or tokens;
- clean up every listener and timer;
- keep diagnostic state local to the current playback session.

Also verify and, if necessary, correct the Auto/Fixed label. It must describe the actual HLS mode, not merely the presence of multiple levels.

### 3. P1 — Make fixed-quality and adaptive-quality semantics explicit

> **Audit: Completed and verified.** Both the original scope and the on-device follow-up shipped, and
> the level-normalisation rule that fixed it lives in `src/utils/hlsLevels.ts`. One stated remainder
> stays open — exposing a master playlist's internal ABR levels as separate fixed choices — carried
> forward as part of **A13**. Note that the roadmap text below still says "the P0 on-device
> validation from item 1" is open; that validation happened, and item 1 records its result.

The current player can select a level in an adaptive HLS stream, while some other stream variants may effectively be fixed-quality URLs. First document and test that distinction.

Then:

- expose an explicit `Auto` option only for a genuine master playlist with multiple HLS levels;
- use HLS.js automatic level selection for Auto mode;
- keep fixed-quality options deterministic;
- do not present Auto for a one-level HLS stream where it cannot provide adaptation;
- keep the selected mode and quality visible in diagnostics.

The implementation must preserve the existing manual quality behavior while making it clear whether a user selected a fixed level or delegated selection to HLS.js.

**Implemented**: [Make Auto/Fixed HLS quality mode explicit](https://github.com/kaaburgh/kinopub.webos/commit/6d5535df4215453ea8a5085d814924180812cef6). An explicit `Авто` option is now offered only when the loaded manifest turns out to be a genuine multi-level master playlist (checked after `MANIFEST_PARSED`), and selecting it delegates to HLS.js ABR (`currentLevel = -1`) instead of pinning a level. Fixed-quality selection is unchanged and deterministic, playback always starts pinned to the requested quality, and the selected mode/quality is now shown both in the player quality badge and the diagnostics overlay next to the existing HLS.js-derived mode. Still open: exposing the internal ABR levels of a master playlist as separate fixed choices, and the P0 on-device validation from item 1.

**Follow-up fix**: on-device validation on the LG G5 showed fixed-quality selection had no effect at all — the diagnostics overlay reported `selected quality: 480p` while `currentLevel` stayed at the top level and `mode` stayed `auto`. Cause: levels were resolved by exact `level.height` equality against the API quality name, which only holds for 16:9 content. A 2.39:1 encode advertises 854x302 / 1280x536 / 1920x804 / 3840x1606 for what the API calls 480p / 720p / 1080p / 2160p, so no level ever matched, nothing was ever pinned, and HLS.js silently stayed in its default ABR mode. Levels are now normalized to the quality they actually represent (the larger of the advertised height and the 16:9-equivalent height implied by the width) and matched nearest-first, and the overlay shows both the normalized name and the real resolution per level.

### 4. P1 — Add controlled quality fallback after evidence is collected

> **Audit: Partially implemented, and the item now covers two different problems.** What shipped is
> _recovery_, not quality fallback: fatal-error recovery with a drainable budget, a stall watchdog,
> and a decode-health indicator. The network half of the original motivation is **Dropped** — ABR
> already handles it, confirmed by observation on a busy evening. The decode half is still open and
> deliberately gated on evidence (→ **A13**), and the evidence it is gated on has not been collected
> (→ **A5**). The recovery work itself surfaced two live defects: the exhausted state is invisible to
> the viewer (→ **A1**) and the watchdog's reload still flushes the buffer (→ **A7**).

Only after the failure mode and Auto mode are validated, add automatic quality reduction for repeated playback problems.

The first version should be conservative:

- trigger only on a combination of sustained buffer starvation/stalls or repeated recoverable HLS failures;
- lower quality by one available level at a time;
- use a cooldown and hysteresis so the player does not oscillate between levels;
- never override a deliberate manual-quality choice without a clear user-visible indication;
- allow recovery to a higher level only after stable playback;
- keep the fallback disabled for fixed one-level sources;
- show the reason and current mode in diagnostics.

If a source cannot adapt in place, treat switching to another source URL as a separate implementation path rather than silently pretending it is ABR.

**Partially implemented (recovery only, not quality fallback).** Fatal HLS errors are now recovered from: a fatal network error restarts loading with capped exponential backoff, and a fatal media error goes through `recoverMediaError` (plus `swapAudioCodec` on a second consecutive failure). The attempt budget resets once a _media_ fragment buffers on the stream that was failing, and the current recovery state and reason are shown in the overlay.

**Follow-up fix:** the budget originally reset on any `FRAG_BUFFERED` for that stream, which included the init segment. Restarting the loading engine is exactly what refetches an init segment, so recovery manufactured its own proof of success: every retry reloaded the init segment, cleared the budget it had just spent, and went round again. Two LG G5 captures 91 s apart caught it — failed requests climbing 65 → 325 (~2.9/s, no decay), decoded frames frozen at 165, and `recovery` pinned at `attempts=1/6` throughout, in a ~4 s loop of fatal → `startLoad()` → init segment → retries → fatal against one segment the CDN answered with `HTTP 0`. With the budget able to drain, the backoff finally escalates (1→2→4→8→8→8 s) and the player gives up after roughly a minute, reporting `gave up after 6` instead of hammering the CDN indefinitely. The rule now lives in `src/utils/hlsRecovery.ts` with unit tests, since it is subtle and failed silently. Quality switching also moved from `currentLevel` to `nextLevel`, because `currentLevel` flushes the entire buffer to apply the switch instantly -- that is what converted a stream coasting through network failures on 82 s of buffer into an unrecoverable stall. The automatic _quality reduction_ described above is still open and deliberately separate from error recovery.

**Scope narrowed after on-device observation.** Two distinct problems were being conflated here:

- _Network_ — quality already moves on its own when the connection degrades, observed on a busy
  evening. HLS.js ABR covers this; nothing more is needed.
- _Decode_ — the decoder struggling is a different failure, and reducing quality automatically for
  it would be acting on a signal nobody has validated yet. So this ships an **indicator only**:
  a corner badge driven by the dropped-frame ratio over a sliding window, plus hard decode errors.
  See `docs/playback-diagnostics-spec.md` (Decode Health Indicator). Automatic reduction stays open
  until captures show what the decode failure actually looks like.

### 5. P1 — Reduce excessive subtitle brightness, especially in HDR

> **Audit: Partially implemented.** The manual opacity control shipped and is not to be redone. The
> reproduction and isolation steps — the part that would establish whether there is an HDR-specific
> component at all — have never been performed, so the scene-adaptive follow-up rests on an
> unverified premise. Carried forward as **A12**, which also folds in the review's finding that the
> HDR badge a tester would rely on is itself a codec guess.

**Status:** the manual subtitle brightness/opacity control described below has been implemented (in-player Settings popup, persisted via storage, applied through `video::cue { opacity: var(--subtitle-opacity) }` so it covers native `<track>` and HLS.js-rendered cues alike). The reproduction/isolation steps and the scene-adaptive follow-up are still open.

The current subtitle size and position are already satisfactory and should not be changed. The remaining issue is that subtitles appear excessively bright, as if rendered at full brightness, with a possible HDR-specific component.

First reproduce and isolate the behavior:

- compare the same subtitle and scene in SDR and HDR;
- check whether the excessive brightness is present on all content or primarily on HDR content;
- determine whether the effect comes from the subtitle color/opacity, HDR tone mapping, or the LG webOS compositor;
- verify whether native `<track>` and `::cue` styling on the LG G5 reliably supports the required color/opacity control.

The first implementation should provide a user-controlled subtitle brightness/opacity setting:

- keep the current size and screen position unchanged;
- apply the setting consistently to the subtitle text and any outline, shadow, or background;
- persist it across subtitle switching, seeking, source/quality changes, and player reloads;
- use the native track path if it can enforce the setting reliably;
- use a custom subtitle layer only if native styling cannot provide dependable control on webOS.

Treat scene-adaptive brightness as a follow-up enhancement, not a prerequisite for the manual control:

- investigate whether reliable, low-cost scene/luminance information is available on the LG G5 playback path;
- only implement automatic adaptation if it can work without destabilizing playback or adding unacceptable CPU/GPU cost;
- if frame analysis or webOS rendering limitations make it unreliable, keep the manual brightness control as the supported solution.

### 6. P2 — Make the build and TV-install loop reproducible

> **Audit: Completed, validation incomplete.** `docs/build-and-install.md` and `docs/ci.md` exist, CI
> builds and packages on every push, and the "Build and package" job — including the check that
> `out/kinopub.webos_v<version>.ipk` was produced — passed on `master` at `ccab33e` (run
> `30903800595`). What has never been confirmed is the second half: that the resulting IPK installs
> and launches on a TV. Nobody has walked the document end to end. Carried forward as **A14**, along
> with the stale claims in both documents that the project has no tests.

Update the project documentation so the fork can be built and installed without relying on instructions or release links from the original repository.

Document:

- the required Node/Yarn setup;
- `yarn build`;
- `yarn package` and the resulting IPK location;
- installation with `ares-install`;
- the LG Developer Mode session renewal step;
- the short manual smoke test after installation.

Keep lint/build checks part of the normal change loop, especially for player and media changes.

---

## Active roadmap

Ordered by priority, then by what unblocks what.

### A1 — Tell the viewer when playback has failed

- **Status:** Open
- **Priority:** High
- **Category:** Playback UX
- **Origin:** Review §4.1; the unbuilt half of item 4's recovery work
- **Problem or opportunity:** When every recovery budget is spent the application stops trying and
  says nothing. The viewer sees a frozen frame with no explanation and no action. The recovery-budget
  fix was correct — hammering the CDN forever was worse — but it converted an infinite-retry failure
  into a silent one.
- **Concrete evidence:** `MediaRef` exposes `error` (`media.new.tsx:132`, `:899-904`) and nothing
  reads it: `grep -rn "\.error\b"` over `src/components/player`, `src/components/media` and
  `src/views/video` returns no consumers. The exhausted paths at `media.new.tsx:423-433`, `:461-471`,
  `:501-502` and `:666-676` all return without any user-visible effect. The only surface that reports
  the state is the `recovery:` line in an overlay reached through Settings →
  `Диагностика воспроизведения`.
- **Motivation and expected benefit:** This is the single most visible remaining gap, and it also
  converts a dead end into a data source: whatever the viewer chooses (retry, lower quality, leave)
  is information the recovery episode currently has to guess at.
- **Proposed direction:** Surface the terminal state from the media layer — the two `RecoveryState`
  records already carry `exhausted`, `limit` and `lastReason` — and render a message with at least
  one action. Retry should rebuild the HLS instance rather than call `startLoad()` on a stopped
  engine. Check first what Enact's `VideoPlayer` already renders in a `NETWORK_NO_SOURCE` state
  (blind spot 9) rather than building over the top of it. Wording in Russian, matching
  `settings.tsx`. Keep it out of the way while recovery is still in progress: this is for the end
  state, not for every retry.
- **Dependencies and sequencing:** None. Pairs naturally with **A2**, which needs the same "the
  player is finished" moment.
- **Compatibility risks:** Low. New UI only; must not steal focus from the Enact controls or trap
  Back — the handler-ordering trap in **A9** applies.
- **Confidence:** code — high. Device behaviour of the Enact fallback: unknown.
- **Validation and acceptance criteria:** Reproduce a segment the CDN refuses; confirm the message
  appears only after both budgets report `exhausted`, that the offered action works, and that Back
  still leaves the player immediately. Add to `docs/playback-diagnostics-manual-test.md`.
- **Estimated scope:** Small–medium; one component plus a state passed up from `media.new.tsx`.

### A2 — Report the recovery episode when the viewer leaves

- **Status:** Open
- **Priority:** High
- **Category:** Error reporting
- **Origin:** Review §4.2, §5
- **Problem or opportunity:** An in-flight recovery episode is discarded, unsent, when the player
  unmounts. The most common ending of a broken session — the viewer gives up and presses Back, or
  switches episode — produces no Sentry event at all, so `playback_episode` counts are drawn from a
  filtered sample that over-represents viewers who waited 30 s.
- **Concrete evidence:** `createPlaybackEpisodeTracker.reset` finishes an open episode as `abandoned`
  (`playbackEpisode.ts:235-241`) and is called from exactly one place, the source-change effect body
  at `media.new.tsx:350`. The effect's cleanup (`:543-562`) never touches `episodeRef`.
  `views/video/video.tsx:209` keys `<Player>` on `currentVideo.id`, so an episode change remounts the
  player through that same cleanup.
- **Motivation and expected benefit:** Without this, every conclusion drawn from episode outcomes is
  biased, including the answer to **A6**. It is a few lines.
- **Proposed direction:** Flush from the effect cleanup. Distinguish the ending: "abandoned by user"
  is a different fact from "abandoned after the grace period" and they should not be grouped
  together — either a distinct outcome or a tag. Note that Sentry may not flush before the page/view
  tears down; check whether the event is actually delivered, not merely queued.
- **Dependencies and sequencing:** Do before **A6**, whose data this corrupts.
- **Compatibility risks:** Very low. Guard against a double report when unmount and source change
  coincide — `finish()` already no-ops on a closed episode (`playbackEpisode.ts:101-103`).
- **Confidence:** code — high.
- **Validation and acceptance criteria:** A unit test that the tracker reports on a caller-driven
  teardown; on device, stall a stream, press Back, and confirm exactly one event with the new outcome
  arrives in Sentry.
- **Estimated scope:** Small.

### A3 — Report backend and API failures

- **Status:** Open
- **Priority:** High
- **Category:** Error reporting / observability
- **Origin:** Review §4.10
- **Problem or opportunity:** The API client catches every failure and reports none of it. The stated
  experience is that problems are most often with KinoPub itself or with the app; the playback path
  now has an elaborate reporting pipeline and the backend-facing layer has nothing.
- **Concrete evidence:** `src/api/base.ts:56-73` returns `{ error: String(ex) }` on any thrown
  request. A non-2xx response is not treated as a failure at all, so an HTML error page surfaces as a
  JSON parse error with the status already discarded; `response.status === 401` clears tokens
  (`:62-64`) and then still calls `response.json()`. `grep -rn "logError\|logException\|Sentry"` over
  `src/` finds `logException` used once (`hooks/useDeviceAuthorizationEffect.ts:53`) and `logError`
  (`utils/logging.ts:73`) never called.
- **Motivation and expected benefit:** Turns "the app was weird last night" into a specific endpoint,
  status and time. It is also the cheapest large gain available, because the reporting and scrubbing
  infrastructure already exists.
- **Proposed direction:** Preserve the HTTP status and the endpoint path; report non-2xx and thrown
  requests with the same one-per-session-per-kind discipline `logPlaybackIssue` uses
  (`logging.ts:112-116`) so a flapping backend cannot flood the quota. Endpoint path and status only
  — never the query string, which carries `access_token` (`base.ts:49-54`); `scrubUrls` already
  reduces URLs to hostnames but the token is a parameter, so it must not be put in the message in the
  first place. Consider whether 401 should be reported at all, since it is a normal expiry.
- **Dependencies and sequencing:** Best done with **A9**, which touches the same request path.
- **Compatibility risks:** Low, but the `{ error }` return shape is consumed by callers; changing it
  is a larger change than adding reporting beside it.
- **Confidence:** code — high.
- **Validation and acceptance criteria:** Point the client at an unreachable host and confirm one
  Sentry event with the status and path, no token, and no repeat flood. A unit test over the error
  mapping if `base.ts` is refactored enough to allow one.
- **Estimated scope:** Small–medium.

### A4 — Decide what telemetry this fork sends, and where

- **Status:** Open
- **Priority:** High
- **Category:** Privacy / configuration
- **Origin:** Review §4.9, §4.13
- **Problem or opportunity:** The Sentry DSN was replaced on an explicit argument — telemetry was
  going to a third party and was invisible to whoever debugs this fork — and an equivalent inherited
  channel was left in place. Separately, `master` is published publicly with the new DSN embedded.
- **Concrete evidence:** `public/index.html:8-15` loads
  `https://www.googletagmanager.com/gtag/js?id=G-2QFN9YLY57` at startup and configures that
  inherited property; `src/utils/analytics.ts` feeds Web Vitals into it from `src/index.tsx:35`. The
  argument for replacing the DSN is recorded verbatim at `docs/playback-diagnostics-spec.md:264-266`
  and applies unchanged to this tag. `.github/workflows/deploy-pages.yml` publishes every push to
  `master`, and `git ls-remote --heads origin` shows `gh-pages` live at `a6dc3619`, so the bundle
  containing `logging.ts:16`'s DSN is served to anonymous visitors.
- **Motivation and expected benefit:** Ends an inconsistency between a stated decision and the
  shipped artefact, and stops web visitors from consuming the owner's Sentry quota or posting to the
  DSN.
- **Proposed direction:** Three separable decisions. (1) The GA tag: remove, or repoint at a property
  the owner controls — removing also deletes an unconditional external request at startup, which is
  worth something on a TV. (2) The Pages deployment: keep, or restrict it. (3) If Pages stays,
  consider gating Sentry initialisation on the webOS runtime so only the TV app reports. Whichever is
  chosen, record the reasoning in the spec so the next reader does not have to re-derive it.
- **Dependencies and sequencing:** None. Do before drawing conclusions from Sentry volume.
- **Compatibility risks:** None from removal; `gtag?.()` is already optional-called
  (`analytics.ts:6`), so `sendWebVitalsToGoogleAnalytics` no-ops without the tag.
- **Confidence:** code — high. Whether the Pages deployment is wanted is the owner's call, not a
  defect.
- **Validation and acceptance criteria:** Load the built app with the network panel open and confirm
  no request to `googletagmanager.com`; confirm the intended Sentry behaviour on both surfaces.
- **Estimated scope:** Small, once the decisions are made.

### A5 — Validate the decode-health thresholds on the LG G5

- **Status:** Investigation first — blocked on device evidence
- **Priority:** High
- **Category:** Diagnostics correctness
- **Origin:** Review §5; narrowed scope of item 4
- **Problem or opportunity:** The badge's thresholds are reasoned, not measured. If the panel's
  baseline dropped-frame ratio during clean playback is above 1%, the badge is permanently yellow and
  is worse than no badge; if it never reaches 1% even while visibly stuttering, it never appears.
- **Concrete evidence:** `DECODE_WARNING_RATIO = 0.01` / `DECODE_SEVERE_RATIO = 0.05`
  (`decodeHealth.ts:48-49`), with the module itself stating there is no normative threshold
  (`:4-5`). `DECODE_MIN_FRAMES = 120` and the 30 s window are equally unmeasured. Nothing in the
  repository records what an LG G5 reports.
- **Motivation and expected benefit:** This gates **A13**. Acting on an unvalidated signal is exactly
  what item 4 was narrowed to avoid, so the narrowing is only honest if the validation happens.
- **Proposed direction:** No code change first. Play 10–15 clean minutes with the overlay open and
  record `frames`, `dropped` and `dropped %`; repeat on content known to stutter and on 2160p. Then
  decide whether the thresholds move, whether `DECODE_MIN_FRAMES` is right at TV frame rates, and
  whether `getVideoPlaybackQuality` is implemented usefully on this firmware at all — the overlay
  shows `not available` if it is absent (`playbackDiagnostics.tsx:1038`).
- **Dependencies and sequencing:** Blocks **A13**. Independent of everything else.
- **Compatibility risks:** None; observation only.
- **Confidence:** device — none yet. That is the point of the item.
- **Validation and acceptance criteria:** Numbers for clean and stuttering playback recorded in this
  roadmap, and either a justified threshold change or an explicit "the defaults hold, and here is the
  measurement that says so".
- **Estimated scope:** Small — one viewing session.

### A6 — Answer whether the stall watchdog rescues playback

- **Status:** Investigation first — blocked on device evidence
- **Priority:** Medium
- **Category:** Playback recovery
- **Origin:** Review §7.2; the unanswered half of item 1
- **Problem or opportunity:** The watchdog's escalation shape — restart at 8 s, playlist reload at
  20 s, three reloads — is a guess. The `playback_recovered_after` tag was built specifically to
  falsify it and no data from it appears anywhere. Related and still unanswered: _why_ the CDN
  returns `HTTP 0` for particular segments after a seek.
- **Concrete evidence:** `STALL_RESTART_AFTER`, `STALL_RELOAD_AFTER`, `STALL_MAX_RELOADS`
  (`media.new.tsx:64-66`) carry no derivation. The tag is set at `logging.ts:177-179`. `ROADMAP.md`
  item 1 records two different segments (`sn 57`, `sn 46`) failing on the same title and host while
  the opening of the file buffered normally.
- **Motivation and expected benefit:** Either the reload works, in which case the numbers can be
  tuned with evidence and the fatal-retry budget could arguably escalate to it sooner; or it does
  not, in which case a third of the recovery machinery is ceremony and should be cut.
- **Proposed direction:** Two parts. (a) Collect `playback_recovered_after` over real use and group
  by it. (b) Run the discriminating experiment for the `HTTP 0` cause: play sequentially to a
  timestamp that fails after a seek, without seeking. If it plays, the trigger is the seek, not the
  segment — which points at range requests or token scoping rather than a bad edge.
- **Dependencies and sequencing:** Needs **A2** first, or the sample is biased.
- **Compatibility risks:** None; observation only.
- **Confidence:** device — none. `code` for the mechanism.
- **Validation and acceptance criteria:** A recorded distribution of `playback_recovered_after`
  values, and a stated conclusion about the seek hypothesis, both written into this roadmap.
- **Estimated scope:** Small in code, spread over real viewing.

### A7 — Stop the watchdog's playlist reload from flushing the buffer

- **Status:** Open
- **Priority:** Medium
- **Category:** Playback recovery
- **Origin:** Review §4.3
- **Problem or opportunity:** The fork learned that assigning `hls.currentLevel` flushes the entire
  buffer, and applied that lesson in one call site while leaving it in the other — the one the stall
  watchdog re-triggers during recovery.
- **Concrete evidence:** `media.new.tsx:267-279` documents the reasoning and uses `nextLevel`;
  `MANIFEST_PARSED` still assigns `hls.currentLevel = -1` (`:518`) and
  `hls.currentLevel = levelIndex` (`:531`). Verified against the pinned runtime: the setter calls
  `streamController.immediateLevelSwitch()` (`node_modules/hls.js/dist/hls.js:16835-16839`). The
  watchdog reaches it via `hls.loadSource(currentSrc)` (`:692`). Also verified: with an unchanged URL
  `loadSource` does _not_ detach and re-attach the media element
  (`dist/hls.js:16724-16741`), so the buffer survives `loadSource` itself and it is specifically the
  `currentLevel` assignment that discards it.
- **Motivation and expected benefit:** Bounded but real: the watchdog only fires when buffer-ahead at
  the play position is under 0.5 s, so little is lost _at_ the position, but ranges beyond a gap —
  the post-seek situation in which the `HTTP 0` failures were captured — are thrown away during the
  attempt to recover from them.
- **Proposed direction:** Distinguish a first parse from a reload. On a first parse `currentLevel` is
  fine and pins playback immediately; on a watchdog-driven reload prefer `nextLevel`, or set the
  level before `startLoad` so no flush is needed. A flag set by the watchdog before `loadSource` is
  the simplest form.
- **Dependencies and sequencing:** Independent, but its effect is only measurable alongside **A6**.
- **Compatibility risks:** Medium — this is the code path that pins fixed quality at startup, which
  has already been broken once (item 3's follow-up fix). Do not regress it: quality must still be
  pinned from the first fragment.
- **Confidence:** runtime — high on mechanism; medium on how often it matters.
- **Validation and acceptance criteria:** Fixed quality still pinned from the first fragment on a
  normal start (overlay `currentLevel` matches the selection); after a watchdog reload, buffered
  ranges outside the current position survive.
- **Estimated scope:** Small.

### A8 — Make the QR capture carry everything the overlay shows

- **Status:** Open
- **Priority:** Medium
- **Category:** Diagnostics correctness
- **Origin:** Review §5, §4.6; follow-up to item 2
- **Problem or opportunity:** The capture is how a device observation reaches anyone who can act on
  it, so anything on the screen but not in the capture is invisible to the person diagnosing. The
  most recent commit added a per-stream distinction to the screen and not to the capture. Separately,
  the event history is the one piece of diagnostic state not reset when the HLS instance changes, so
  a capture taken after a quality switch silently mixes two sources.
- **Concrete evidence:** `ExportCapture.lastFragment` is a single object
  (`diagnosticsExport.ts:95-101`) populated from `lastFragments.main` only
  (`playbackDiagnostics.tsx:865`), while the overlay renders one line per stream (`:1078-1080`). The
  reset effect clears six pieces of state at `playbackDiagnostics.tsx:679-686` and not `history`.
  `docs/playback-diagnostics-spec.md:332-334` states the equivalence rule this violates, and `:255`
  requires diagnostic state to be discarded when playback unmounts.
- **Motivation and expected benefit:** Restores the property the spec asks for, and removes a way for
  a capture to mislead.
- **Proposed direction:** Carry `lastFragments` per stream on the `f|` line (repeat the line with a
  stream tag; the decoder skips unknown lines by design, so a `FORMAT_VERSION` bump plus a matching
  `scripts/decode-diagnostics.js` change in the same commit is the contract). For history, prefer a
  `source changed` marker over clearing — history across a switch is often what you want to see, as
  long as the seam is visible. Also add the decode-health severity, which the badge shows and the
  capture does not.
- **Dependencies and sequencing:** None.
- **Compatibility risks:** Low, but the format is versioned for a reason: encoder and decoder must
  change together, and the payload must not outgrow `MAX_CHUNKS` (`diagnosticsExport.ts:28`) — the
  encoder already halves history and finally throws rather than emit an unreadable header (`:359-370`).
- **Confidence:** code — high.
- **Validation and acceptance criteria:** Take a capture on a stream with alternate audio; the
  decoded report shows both streams and matches the screen. Switch quality, capture, and confirm the
  seam is visible in the decoded event list.
- **Estimated scope:** Small–medium; three files must move together.

### A9 — Bound API requests, and stop Back from waiting on one

- **Status:** Open
- **Priority:** Medium
- **Category:** Robustness / UX
- **Origin:** Review §4.11
- **Problem or opportunity:** No request in the application has a deadline, and the remote-key stack
  awaits each handler in turn — so leaving the player waits for a progress-sync POST to finish or
  fail. During a network failure, which is when a viewer most wants to leave.
- **Concrete evidence:** `grep -rn "AbortController\|timeout" src/api/` returns nothing.
  `src/utils/keyboard.ts:51-61` iterates all matching handlers and `await`s each, breaking only on an
  explicit `false`; registration prepends (`:72`). On Back the chain is `handleDiagnosticsClose`
  (`player.tsx:243`), then `handleTimeSync` (`:237`, awaiting `watchingMarkTimeAsync`), then
  `containers/views/views.tsx:54` → `history.goBack()`.
- **Motivation and expected benefit:** Makes the app escapable in the one state where it currently is
  not, and makes every API call fail in bounded time.
- **Proposed direction:** Add an `AbortController` timeout in `src/api/base.ts`, and do not await the
  progress sync on the Back path — fire it and let navigation proceed. While there, document the
  handler-ordering contract in `utils/keyboard.ts`; it is load-bearing, depends on React's
  child-first effect order, and is written down nowhere.
- **Dependencies and sequencing:** Pairs with **A3**; the timeout gives it something to report.
- **Compatibility risks:** `AbortController` is Chrome 66 and the target is `chrome 35`; `core-js`
  does not polyfill DOM APIs, so it needs a `typeof` guard exactly like `CompressionStream`
  (`diagnosticsExport.ts:277-286`). A `Promise.race` timeout is the guard-free fallback, though it
  leaves the request running.
- **Confidence:** code — high on the mechanism. The ordering claim follows from React's effect order
  and should be confirmed with a log line before the handler stack is rewritten around it. How long
  webOS's `fetch` takes to abandon a hung connection is unknown, and that number decides whether this
  is an annoyance or a hang.
- **Validation and acceptance criteria:** With the network dropped mid-playback, Back leaves the
  player without a perceptible delay; a request against an unreachable host fails within the timeout.
- **Estimated scope:** Small.

### A10 — Add a render error boundary

- **Status:** Open
- **Priority:** Medium
- **Category:** Robustness
- **Origin:** Review §4.12
- **Problem or opportunity:** A render-time throw unmounts the whole tree and leaves a black screen
  with no route back — on a TV, that means killing the app from the launcher.
- **Concrete evidence:** `grep -rn "componentDidCatch\|ErrorBoundary"` over `src/` returns nothing.
  22 views are lazy-loaded (`App/App.tsx:12-33`); only `ChunkLoadError` is handled, by the inline
  listener at `public/index.html:16-32`. Sentry's default `GlobalHandlers` integration does report the
  error, so diagnosis works and recovery does not.
- **Motivation and expected benefit:** Converts the worst failure mode the app has into a message
  with a way out.
- **Proposed direction:** One boundary around `Views` in `App/App.tsx` rendering a Moonstone-styled
  message with a "go back"/"reload" action, reporting through `logException`. A second, tighter
  boundary around the player is worth considering so a diagnostics-overlay bug cannot kill playback —
  the overlay is the newest and most intricate code in the tree.
- **Dependencies and sequencing:** None.
- **Compatibility risks:** Low. Boundaries do not catch errors in event handlers or async code, so
  this is not a general safety net.
- **Confidence:** code — high.
- **Validation and acceptance criteria:** A deliberately throwing view renders the fallback instead of
  a blank screen, the remote still works, and one Sentry event is recorded.
- **Estimated scope:** Small.

### A11 — Measure the cost of always-on diagnostics collection

- **Status:** Investigation first
- **Priority:** Medium
- **Category:** Performance
- **Origin:** Review §4.7; follow-up to item 2
- **Problem or opportunity:** Diagnostics collection runs for the whole playback session whether or
  not anything is on screen, and its cost on TV hardware has never been measured — least of all
  during the failure storm, when the device is already struggling.
- **Concrete evidence:** The listener effects depend on `target.video` / `target.hls`, not `visible`
  (`playbackDiagnostics.tsx:645`, `:670`), and the component is always mounted (`player.tsx:255`).
  Every HLS event runs `getHlsEventDetails` (`:551-586`) and `pushHistory` → `setHistory` with a fresh
  30-element array (`:604-615`). Each `ERROR` triggers three state updates (`:767-772`). Item 4
  records ~2.9 failed requests per second during the captured failure.
- **Motivation and expected benefit:** Either it is cheap and can be forgotten, or diagnostics are
  making the failure they are observing worse — which would matter a great deal.
- **Proposed direction:** Measure before changing anything. The obvious fix (collect only while
  visible) destroys the feature's main value, because the run-up to a stall is what you want to see.
  If it is expensive, cheaper shapes exist: keep history in a ref and copy into state only while
  visible; drop the high-frequency `BUFFER_APPENDING`/`BUFFER_APPENDED` pair when hidden; coalesce
  repeated `ERROR`s the way `playbackEpisode` already does.
- **Dependencies and sequencing:** Independent.
- **Compatibility risks:** Any change here risks losing exactly the events the overlay exists to
  show; the acceptance criteria must include "the history still covers the run-up to a stall".
- **Confidence:** code — high that it runs; no evidence about cost.
- **Validation and acceptance criteria:** A recorded before/after observation on the TV during normal
  playback and during a failure — dropped-frame ratio and subjective UI responsiveness are the
  available instruments.
- **Estimated scope:** Small to measure; unknown to fix.

### A12 — Reproduce and isolate subtitle brightness, including whether HDR is involved

- **Status:** Open — blocked on device evidence
- **Priority:** Medium
- **Category:** Subtitles / HDR
- **Origin:** Item 5's unperformed reproduction steps; review §4.8
- **Problem or opportunity:** The manual opacity control shipped, but the premise it was built on —
  that there is an HDR-specific component — has never been tested. The scene-adaptive follow-up would
  be built on an unverified assumption, and the signal a tester would use to sort HDR from SDR
  content is itself a guess.
- **Concrete evidence:** Item 5 lists four isolation steps; nothing in the repository records any of
  them being done. `player.tsx:77-80` derives `isHDR` from `codec` containing `hevc`,
  `codec === 'h265'` (not lower-cased, unlike the `hevc` test one line above), or the quality _name_
  containing `hdr` — HEVC is a codec, HDR is a transfer characteristic, so SDR HEVC content gets an
  HDR badge.
- **Motivation and expected benefit:** Either the manual control is the answer and item 5 can close,
  or there is a real HDR-specific effect worth solving properly. Fixing the badge is a prerequisite
  for telling the two apart.
- **Proposed direction:** First check whether the API exposes a genuine HDR or transfer-characteristic
  flag (`src/api/typings.ts`) and correct or remove the badge accordingly. Then run item 5's four
  steps on the TV: same scene in SDR and HDR, at fixed opacity, photographed. Only then decide about
  scene-adaptive brightness.
- **Dependencies and sequencing:** The badge fix should land first so the observation is trustworthy.
- **Compatibility risks:** `::cue` support on webOS is exactly what is in question; do not replace the
  native subtitle path on a hypothesis.
- **Confidence:** code — high for the badge. device — none for the brightness question.
- **Validation and acceptance criteria:** Photographs of the same scene in both modes attached to a
  written conclusion in this roadmap; the badge appears only on content that is actually HDR.
- **Estimated scope:** Small for the badge; a viewing session for the isolation.

### A13 — Quality-selection follow-ups: decode-driven reduction, and ABR levels as fixed choices

- **Status:** Open — blocked on **A5**
- **Priority:** Low
- **Category:** Playback quality
- **Origin:** The live remainders of items 3 and 4, consolidated
- **Problem or opportunity:** Two related open ends. (a) Automatic quality reduction when the
  _decoder_ struggles — deliberately not built, because it would act on an unvalidated signal.
  (b) A master playlist's internal ABR levels are not offered as separate fixed choices, so on an
  adaptive stream the user can pick from the API's quality list or delegate to ABR, but cannot pin a
  level the manifest exposes and the API does not.
- **Concrete evidence:** Item 4's narrowing paragraph states (a) explicitly. For (b), `getSourceTracks`
  prepends only an `Авто` entry to the API-derived list (`media.new.tsx:229-237`), while
  `hls.levels` is separately rendered in the overlay (`playbackDiagnostics.tsx:1073`).
- **Motivation and expected benefit:** (a) would let the app respond to a decoder problem instead of
  only reporting it. (b) is a small completeness gain, most useful while diagnosing.
- **Proposed direction:** Do not start (a) until **A5** says what a real decode problem looks like on
  this panel. When it does: reduce one level at a time via `nextLevel` (never `currentLevel` — see
  **A7**), with hysteresis and a cooldown, never silently overriding a deliberate manual choice, and
  showing the reason in diagnostics. Item 4's original bullet list still describes the shape wanted.
  (b) is independent and small.
- **Dependencies and sequencing:** (a) strictly after **A5**; benefits from **A7** landing first.
- **Compatibility risks:** High for (a) relative to its value — this is the one item that changes what
  the player does to a stream that is currently playing, and the fork has already been bitten twice in
  this area (`currentLevel` flushing the buffer, exact-height matching pinning nothing).
- **Confidence:** assumed. The premise of (a) is precisely what **A5** exists to test.
- **Validation and acceptance criteria:** For (a): a decode problem reproduced on the TV, a single
  reduction observed, no oscillation over 10 minutes, and the reason visible in diagnostics. For (b):
  each manifest level selectable and reflected in `currentLevel`.
- **Estimated scope:** Medium for (a); small for (b).

### A14 — Walk the build-and-install document end to end on a TV

- **Status:** Open — blocked on device evidence
- **Priority:** Low
- **Category:** Build / release
- **Origin:** Item 6's unvalidated half; review §6, §4.16
- **Problem or opportunity:** The document exists and CI proves the IPK is _built_; nobody has
  confirmed it installs and launches, which is the claim the document actually makes.
- **Concrete evidence:** CI run `30903800595` (`master` @ `ccab33e`) shows "Build and package"
  green, including the check that `out/kinopub.webos_v<version>.ipk` exists. Nothing beyond that.
  Two related staleness bugs: `.github/workflows/ci.yml:41-42` and `docs/ci.md:36-37` both state the
  project has no test files, when there are 3 suites and 41 tests, and `--passWithNoTests` would now
  hide a suite that stopped being discovered.
- **Motivation and expected benefit:** The document's whole purpose is independence from upstream
  release links; that is only true once someone has followed it.
- **Proposed direction:** Follow `docs/build-and-install.md` on a clean machine through
  `ares-install` and the smoke test, correcting whatever is wrong. Separately, drop
  `--passWithNoTests` and fix both stale "no test files" claims.
- **Dependencies and sequencing:** None.
- **Compatibility risks:** None.
- **Confidence:** code — high for the stale claims. device — untested for the install loop.
- **Validation and acceptance criteria:** A build installed on the TV by following only this
  document; CI fails if the test suites disappear.
- **Estimated scope:** Small.

### A15 — Truth up the specification documents

- **Status:** Open
- **Priority:** Low
- **Category:** Documentation
- **Origin:** Review §4.15
- **Problem or opportunity:** `docs/playback-diagnostics-spec.md` states two things that are no longer
  true, one of which it also contradicts within the same document. The specs are the only place the
  reasoning is recorded; where they are demonstrably stale a reader cannot tell which of the
  unverifiable parts are stale too.
- **Concrete evidence:** `:389-395` lists five reported conditions
  (`fatal-network-recovery-exhausted`, `fatal-media-recovery-exhausted`, `fatal-unrecoverable`,
  `stall-watchdog-exhausted`, `decode-health-severe`); `src/utils/logging.ts:88` defines
  `PlaybackIssue` as `'decode-health-severe'` alone, and the same document says so correctly at
  `:430-433`. Separately, `:264-266` still argues the Sentry DSN "belongs to the upstream project",
  which was the reasoning for replacing it — done at `logging.ts:16`.
- **Motivation and expected benefit:** Cheap, and restores the documents' credibility.
- **Proposed direction:** Replace the five-item list with the episode model plus the one standalone
  issue; rewrite the QR rationale to say the export exists because the _network_ is what fails during
  a stall — which is still true and is the stronger argument — rather than because the DSN belongs to
  someone else. Sweep for other statements the recent commits invalidated while there.
- **Dependencies and sequencing:** None. Should follow **A4**, whose decisions the spec should record.
- **Compatibility risks:** None.
- **Confidence:** code — high; both contradictions are visible side by side.
- **Validation and acceptance criteria:** No claim in the spec contradicts the code or another part of
  the spec; `yarn check:docs` and `yarn format:check` still pass.
- **Estimated scope:** Small.

### A16 — Retire dead code and small inherited defects

- **Status:** Open
- **Priority:** Low
- **Category:** Maintenance
- **Origin:** Review §4.14, §4.4
- **Problem or opportunity:** A batch of small items, each individually harmless, that together make
  the code harder to trust — notably a dead module that is still a type source for live code.
- **Concrete evidence:**
  - `src/components/media/media.tsx` (218 lines, the legacy Enact class implementation) is reachable
    from nothing — `index.ts` re-exports `media.new` only — except `views/video/video.tsx:6`, which
    imports the type `SourceTrack` from it. That type differs from the live one (no `number`, no
    `default`, no `type`) and types `onSourceChange` three lines above a `// @ts-expect-error`
    (`video.tsx:221`), so `tsc` sees neither half of the mismatch.
  - `player.tsx:194-203` appends `#subtitle-opacity-style` to `document.head` and never removes it —
    the one lifecycle asymmetry in otherwise careful cleanup code.
  - `type MediaEvents = keyof typeof MEDIA_EVENTS` (`media.new.tsx:1075`) resolves to array members,
    not event names; `typeof MEDIA_EVENTS[number]` was intended, so the `Partial<Record<…>>` below
    checks nothing. Inherited; no runtime effect.
  - `recoveryTimeoutId` is a single slot (`media.new.tsx:330`, `:448`), so a second fatal error inside
    the backoff window orphans the first timer and the cleanup at `:546-548` clears only the last.
    The `hlsRef.current === hls` guard at `:450` keeps this benign — the worst case is a duplicated
    `startLoad()`, which `dist/hls.js:8771-8775` largely absorbs.
  - `scripts/package.js:12` builds IPKs under `netflix`, `amazon`, `ivi`, `youtube`, `ui30` as well as
    the real id. Inherited, documented around rather than decided on.
- **Motivation and expected benefit:** Removes traps for whoever reads this next, and closes a real
  hole in type coverage on the player's props.
- **Proposed direction:** Point `video.tsx` at `components/media` and delete `media.tsx`; then find
  out what the `@ts-expect-error` on `:221` was hiding, since it may stop being needed or may reveal a
  genuine mismatch. Track and clear the retry timers as a set. Remove the style element on unmount.
  Fix `MediaEvents`. Decide about the extra app ids deliberately.
- **Dependencies and sequencing:** None, but do not bundle with a behavioural change — the value here
  is that the diff is boring.
- **Confidence:** code — high, except the concurrency premise for the timer, which is reasoned from
  hls.js's controller structure rather than observed (medium).
- **Validation and acceptance criteria:** `yarn typecheck`, `yarn lint`, `yarn test` and `yarn build`
  all pass; playback and quality switching unchanged on the TV.
- **Estimated scope:** Small.

### A17 — Find out whether upstream has moved, and whether older webOS still works

- **Status:** Investigation first
- **Priority:** Low
- **Category:** Compatibility
- **Origin:** Review §3, §7.5, §7.6
- **Problem or opportunity:** Two unknowns that could each invalidate assumptions cheaply. This fork
  has no upstream remote, so nobody knows whether `alexeyeryshev/kinopub.webos` or
  `adascal/kinopub.webos` has shipped fixes since the fork point. And `README.md` claims webOS v3+
  while the fork has added CSS that predates neither target nor firmware has been checked against.
- **Concrete evidence:** `git remote -v` shows only `origin`; the last inherited commit is `58bd3ea`
  (2026-03-07). `README.md` states "webOS v3+". ES built-ins are safe — `src/polyfills.ts` imports all
  of `core-js` and `src/index.tsx:1` loads it first — and every DOM API the fork added is behind a
  `typeof` guard. But `gap` on **flex** containers (`playbackDiagnostics.tsx:932`, `:978`, `:1061`)
  is Chrome 84 and cannot be polyfilled: on a webOS 4 panel (Chrome 53) the diagnostics sections
  would sit flush against each other rather than fail outright.
- **Motivation and expected benefit:** Adding an upstream remote is a one-line change that turns an
  unknown into a diff. The webOS claim is either true or the README is wrong, and both are cheap to
  settle.
- **Proposed direction:** Add an `upstream` remote and fetch it; review `58bd3ea..upstream/master`
  for anything worth taking. Separately, either test on an older panel or narrow the README's claim
  to what has actually been run.
- **Dependencies and sequencing:** None.
- **Compatibility risks:** None from looking.
- **Confidence:** code — high for the CSS analysis. Everything else: unknown by construction.
- **Validation and acceptance criteria:** A written statement of what upstream has changed and what
  is worth taking, and a README claim matching what has been verified.
- **Estimated scope:** Small.

---

## Constraints and non-goals

- Keep the pinned React, Enact/webOS, TypeScript, and HLS.js versions unless a separate compatibility task is approved.
- Do not change network, retry, source-selection, or decoder behavior before the diagnostic validation identifies the relevant failure mode.
- Do not assume that a fixed-quality stream can be made adaptive without a master playlist or another source URL.
- Preserve the current diagnostic privacy guarantees.
- Preserve the currently acceptable subtitle size and position while working on subtitle brightness.
- New dependencies stay exceptional. The one addition so far is `qrcode-generator`, which has no
  transitive dependencies and does not touch the playback path; the reasoning is recorded in
  `docs/playback-diagnostics-spec.md`.
- Node.js 14 is a build requirement, not a preference: the pinned `react-scripts` 4 / webpack 4
  toolchain fails on Node.js 17 and newer with `ERR_OSSL_EVP_UNSUPPORTED`. Reproduced during the
  review on Node 22.
