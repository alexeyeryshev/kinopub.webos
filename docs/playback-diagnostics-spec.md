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
