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

### 2. P0 — Complete diagnostics around the HLS fragment lifecycle

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

### 5. P1 — Reduce excessive subtitle brightness, especially in HDR

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
