# Playback scenario tests

`src/components/media/media.scenarios.test.tsx` replays the network failures that were observed on
the television against a scripted CDN, and runs the real player and the real hls.js over them.

They exist to answer one question that manual testing on a TV answers slowly and expensively: **is
the recovery code in `media.new.tsx` still needed, or does hls.js now handle this by itself?** After
an hls.js upgrade the same scenarios run unchanged, and what changes in the results tells you which
of your own workarounds have become dead weight.

## What is real and what is not

| Layer                                                    | In these tests                                |
| -------------------------------------------------------- | --------------------------------------------- |
| The player (`media.new.tsx`) and its recovery paths      | Real, mounted and unmodified                  |
| hls.js: playlist parsing, retry ladder, fatal escalation | Real                                          |
| Demux, remux, buffer operations                          | Real, over synthetic AAC frames               |
| HTTP responses from the CDN                              | Scripted (`src/testing/hlsCdn.ts`)            |
| Media Source Extensions                                  | Stubbed (`src/testing/mediaSource.ts`)        |
| Playback progress and the buffer level                   | Simulated (`src/testing/playbackHarness.tsx`) |

The substitution point is deliberate. hls.js's `config.loader` is its documented extension point for
"how bytes are fetched", and it has kept the same shape across every 1.x release: `load()`, `abort()`
and `destroy()`. A failing CDN edge is a fact about the network, and it means the same thing in
hls.js 1.0 as in 1.7.

Mocking anything above that line — hls.js events, its error controller, its internal state — would
bake one version's internals into the tests. The upgrade would then break the tests rather than be
checked by them, which is the opposite of the point.

## Running them

```sh
yarn test --watchAll=false --testPathPattern=media.scenarios
```

They run under jest's fake timers, so several minutes of stream time pass in well under a second of
real time. `HLS_DEBUG=1` turns on hls.js's own logging, which is the quickest way to see why a
scenario is not progressing:

```sh
HLS_DEBUG=1 yarn test --watchAll=false --testPathPattern=media.scenarios
```

## What each scenario stages

| Scenario                             | Network condition                                     | Taken from                                                                |
| ------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Healthy stream                       | Everything served                                     | The baseline: no recovery should engage at all                            |
| Refused segments, retried then fatal | Every segment 502                                     | hls.js's own retry ladder, recorded so a change shows up                  |
| Refused segments, every budget spent | Every segment 502, indefinitely                       | The terminal state and the failure notice                                 |
| Escape a bad edge                    | One edge 502s; a playlist refetch yields another edge | Sentry: every request to `…ams-static-01` failed while `…-03` served 200s |
| Recover without restarting the film  | Same, with alternate audio renditions declared        | Issue #18: a fifty-minute film restarting from zero                       |
| Keep the chosen audio track          | Same, after the viewer picks a non-default track      | Issue #18: playback resuming in the wrong language                        |
| Hanging edge                         | Connection accepted, never answered                   | The frozen picture with no error to react to                              |
| Manual retry                         | Dead CDN, then healed, then the viewer presses retry  | The retry button on the failure notice                                    |

## Reading them after an hls.js upgrade

Each scenario asserts two separate things, and they mean different things when they fail.

**Assertions about hls.js.** How many non-fatal errors precede a fatal one; which `type / details`
it reports; how long it waits before escalating. A failure here is not necessarily a defect — it is
the upgrade telling you the library's behaviour changed. Read the new behaviour, then decide.

**Assertions about the player.** Which recovery steps ran, whether playback survived, whether the
position was preserved, what the episode report said. A failure here after an upgrade usually means
one of two things:

- hls.js now does the work itself, and the player's step no longer fires. That is the signal to
  delete the workaround — check the scenario still ends with playback resuming, then remove it.
- hls.js changed something the player depended on. That is a real regression to fix.

Two assertions are written specifically as upgrade tripwires:

- _"is retried by hls.js several times before it becomes fatal"_ asserts that at least five non-fatal
  `fragLoadError`s precede the first fatal one. If a new version escalates immediately, the player's
  policy of ignoring non-fatal errors becomes wrong.
- _"escalates a hanging edge itself rather than waiting for hls.js to call it fatal"_ asserts that
  hls.js has **not** produced a fatal error inside a window in which the stall watchdog has already
  refetched the playlist twice. If a new version escalates inside that window, the watchdog may no
  longer be needed.

## Adding a scenario

1. Describe the network condition with `cdn.intercept(...)`. Returning nothing falls through to the
   healthy default, so a rule only has to describe what breaks.
2. Wind the clock with `harness.advance(ms)`. Playback advances only as far as the buffer, which
   grows only from segments the CDN actually delivered — so a stall is produced by the network
   condition rather than declared by the test.
3. Assert against `harness.hlsErrors` (what hls.js said), `harness.steps` (what the player did),
   `harness.episodes` (what would have been reported to Sentry) and `harness.player` (the state the
   UI renders from).

Prefer assertions about the shape of the behaviour over exact counts and timings. The exceptions are
the two tripwires above, where the number is the whole point and is documented as such in the test.

## Limits

- Video is never decoded. Segments are synthetic AAC frames, which is enough to exercise demux,
  remux and buffering, but nothing here can detect a decoder problem — dropped frames, HDR
  behaviour, or the codec issues that only appear on the television's own hardware.
- Playback progress is simulated from what the CDN delivered, so it is regular in a way real
  playback is not.
- The scenarios cover network failures. Failures of the TV itself (memory pressure, the webOS media
  pipeline, remote-control focus) are out of reach and stay manual — see
  [Playback diagnostics manual test](./playback-diagnostics-manual-test.md).
