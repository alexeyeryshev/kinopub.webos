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
- network logic;
- runtime dependencies.

The implementation must remain compatible with the current React, TypeScript, Enact/webOS runtime, and pinned `hls.js` version.

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

## Segment Loading

Subscribe to HLS events when available:

- `FRAG_BUFFERED`;
- `FRAG_CHANGED`;
- `LEVEL_SWITCHED`;
- `ERROR`.

For the most recently completed media fragment, show:

- selected level or height;
- bytes loaded;
- request/load duration;
- calculated effective throughput;
- time elapsed since the last successfully buffered fragment.

Use HLS loader stats defensively and avoid division by zero.

## Errors

Record recent HLS errors in the same bounded diagnostics history.

For each error show, when available:

- timestamp;
- fatal/non-fatal flag;
- error type;
- error details;
- HTTP response status;
- request hostname only.

The overlay should distinguish:

- fragment load timeout;
- manifest load failure;
- HTTP 401/403/404/5xx;
- media/decode errors;
- buffer starvation;
- normal HLS level switches.

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
