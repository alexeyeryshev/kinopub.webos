# Kinopub webOS Roadmap

This roadmap tracks the work remaining after the playback-diagnostics baseline.

## Completed baseline

The latest two commits already cover:

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

## Priority order

### 1. P0 — Validate the real failure on the LG G5

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

### 5. P1 — Reduce excessive subtitle brightness, especially in HDR

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

Update the project documentation so the fork can be built and installed without relying on instructions or release links from the original repository.

Document:

- the required Node/Yarn setup;
- `yarn build`;
- `yarn package` and the resulting IPK location;
- installation with `ares-install`;
- the LG Developer Mode session renewal step;
- the short manual smoke test after installation.

Keep lint/build checks part of the normal change loop, especially for player and media changes.

## Constraints and non-goals

- Keep the pinned React, Enact/webOS, TypeScript, and HLS.js versions unless a separate compatibility task is approved.
- Do not change network, retry, source-selection, or decoder behavior before the diagnostic validation identifies the relevant failure mode.
- Do not assume that a fixed-quality stream can be made adaptive without a master playlist or another source URL.
- Preserve the current diagnostic privacy guarantees.
- Preserve the currently acceptable subtitle size and position while working on subtitle brightness.
