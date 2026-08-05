/**
 * Playback failures from the TV, replayed against a scripted CDN.
 *
 * Each test stages a network condition that was actually observed on the device and then asserts
 * two separate things: what hls.js does with it, and what this player does on top. The split is the
 * point. When hls.js is upgraded, the first group says whether the library's own behaviour changed;
 * the second says whether the recovery code here is still earning its place, or whether the new
 * version already handles the case and the code can go.
 *
 * The only substitution is the CDN, at the HTTP boundary (`testing/hlsCdn`). Playlist parsing,
 * level selection, the non-fatal retry ladder and the escalation to a fatal error are all performed
 * by the real hls.js. See `docs/playback-scenario-tests.md` for how to use these at upgrade time.
 */
import { createPlaybackHarness } from 'testing/playbackHarness';

const STREAM = {
  segmentCount: 150,
  segmentDuration: 4,
  // A realistic UHD bitrate, which is what keeps hls.js's forward buffer near 30s. At a low
  // declared bandwidth it would happily fetch the entire playlist before playback started, and no
  // outage staged afterwards could ever be felt.
  levels: [{ name: '1080p', bandwidth: 20000000, resolution: '1920x804', codecs: 'mp4a.40.2', videoRange: 'PQ' as const }],
};

/** The recovery steps by name; the tracker files them all under one breadcrumb category. */
const actions = (harness: { steps: { message: string }[] }) => harness.steps.map((step) => step.message);

jest.setTimeout(120000);

describe('playback scenarios', () => {
  beforeEach(() => {
    jest.useFakeTimers('modern');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('plays a healthy stream without recovering anything', async () => {
    const harness = createPlaybackHarness({ cdn: STREAM, autoPlay: true });

    await harness.advance(60000);

    expect(harness.hlsErrors).toEqual([]);
    expect(harness.steps).toEqual([]);
    expect(harness.episodes).toEqual([]);
    expect(harness.player.failure).toBeUndefined();
    expect(harness.player.recovery).toMatchObject({ attempts: 0, exhausted: false });
    // Playing for a minute means having played roughly a minute of it.
    expect(harness.video.currentTime).toBeGreaterThan(55);
    expect(harness.player.videoRange).toBe('PQ');

    harness.destroy();
  });

  describe('a CDN edge that refuses every segment', () => {
    it('is retried by hls.js several times before it becomes fatal', async () => {
      const harness = createPlaybackHarness({ cdn: STREAM, autoPlay: true });
      harness.cdn.intercept((request) => (request.kind === 'fragment' ? { status: 502 } : undefined));

      await harness.advance(200000, 200);

      const firstFatal = harness.hlsErrors.findIndex((error) => error.fatal);

      // hls.js's own behaviour: a refused segment is retried internally, and only the exhaustion of
      // that ladder is reported as fatal. This is why the player must not treat a non-fatal
      // `fragLoadError` as something to act on -- doing so would fight hls.js's own retries.
      expect(firstFatal).toBeGreaterThanOrEqual(5);
      expect(harness.hlsErrors.slice(0, firstFatal).every((error) => error.reason === 'networkError / fragLoadError')).toBe(true);
      expect(harness.hlsErrors[firstFatal].reason).toBe('networkError / fragLoadError');

      // And the player's: no fatal-error recovery is attempted until hls.js escalates.
      const firstFatalRetry = harness.steps.find((step) => step.message === 'fatal-retry');
      expect(firstFatalRetry?.at).toBeGreaterThanOrEqual(harness.hlsErrors[firstFatal].at);

      harness.destroy();
    });

    it('gives up and reports a terminal failure once every budget is spent', async () => {
      const harness = createPlaybackHarness({ cdn: STREAM, autoPlay: true });
      harness.cdn.intercept((request) => (request.kind === 'fragment' ? { status: 502 } : undefined));

      await harness.advance(700000, 200);

      expect(harness.player.failure).toMatchObject({ kind: 'recovery-exhausted', reason: 'networkError / fragLoadError' });
      expect(actions(harness)).toEqual(expect.arrayContaining(['watchdog-restart', 'watchdog-reload', 'fatal-retry']));

      // The report has to say which budget ran out, because that is what distinguishes a stream
      // nobody can serve from a decoder that cannot cope.
      const exhausted = harness.episodes.flatMap((episode) => episode.exhausted);
      expect(exhausted).toEqual(expect.arrayContaining(['stall-watchdog', 'fatal-network']));
      expect(harness.episodes.map((episode) => episode.outcome)).toContain('abandoned');

      // The overlay renders this as "attempts of limit", so a budget that can be overspent shows
      // the viewer a number larger than its own cap.
      expect(harness.player.recovery.attempts).toBeLessThanOrEqual(harness.player.recovery.limit);

      harness.destroy();
    });
  });

  it('escapes a bad edge by refetching the playlist', async () => {
    // Two edges, the first broken: the playlist refetch is what hands out URLs on the second one.
    // This is the failure the watchdog exists for, taken from a Sentry trail in which every
    // request to one edge returned 0 or 502 while a sibling edge served 200s throughout.
    const harness = createPlaybackHarness({
      cdn: { ...STREAM, edges: ['edge-01.cdn.test', 'edge-01.cdn.test', 'edge-03.cdn.test'] },
      autoPlay: true,
    });

    harness.cdn.intercept((request) =>
      request.kind === 'fragment' && request.host === 'edge-01.cdn.test' && harness.cdn.segmentIndexOf(request.path) >= 12
        ? { status: 502 }
        : undefined,
    );

    await harness.advance(120000, 100);

    // hls.js does not do this on its own: nothing in the library refetches a VOD playlist because
    // playback stopped moving, so without the watchdog the picture stays frozen on the last frame.
    expect(actions(harness)).toEqual(expect.arrayContaining(['watchdog-restart', 'watchdog-reload']));
    expect(harness.cdn.requestsMatching((request) => request.host === 'edge-03.cdn.test').length).toBeGreaterThan(0);

    // And playback carried on past the point the broken edge stopped serving.
    expect(harness.video.currentTime).toBeGreaterThan(12 * STREAM.segmentDuration);
    expect(harness.player.failure).toBeUndefined();

    harness.destroy();
  });

  it('recovers from a bad edge without restarting the film', async () => {
    // The regression from issue #18. `loadSource()` clears hls.js's audio-track state and fetches
    // a new manifest asynchronously, so resuming before it arrives makes hls.js reselect an audio
    // track from an empty list and raise a fatal `mediaError / audioTrackLoadError`. Answering
    // that with `recoverMediaError()` detaches the media element, which resets `currentTime` to
    // zero -- a fifty-minute film restarting from the beginning, with the wrong audio.
    const harness = createPlaybackHarness({
      cdn: {
        ...STREAM,
        edges: ['edge-01.cdn.test', 'edge-01.cdn.test', 'edge-03.cdn.test'],
        levels: [{ ...STREAM.levels[0], audioGroup: 'aud1' }],
        audioRenditions: [
          { groupId: 'aud1', name: 'Русский', language: 'ru', default: true },
          { groupId: 'aud1', name: 'English', language: 'en' },
        ],
      },
      audioTracks: [
        { name: 'Русский', number: '1', lang: 'ru', default: true },
        { name: 'English', number: '2', lang: 'en' },
      ],
      autoPlay: true,
    });

    harness.cdn.intercept((request) =>
      request.kind === 'fragment' && request.host === 'edge-01.cdn.test' && harness.cdn.segmentIndexOf(request.path) >= 12
        ? { status: 502 }
        : undefined,
    );

    await harness.advance(120000, 100);

    expect(actions(harness)).toContain('watchdog-reload');
    expect(harness.hlsErrors.map((error) => error.reason)).not.toContain('mediaError / audioTrackLoadError');
    // `recoverMediaError()` is the destructive path; nothing here should have needed it.
    expect(actions(harness)).not.toContain('media-recover');
    expect(harness.video.currentTime).toBeGreaterThan(12 * STREAM.segmentDuration);

    harness.destroy();
  });

  it("keeps the viewer's audio track through a recovery", async () => {
    // The other symptom reported in issue #18: playback resumed in a different language from the
    // one the settings menu still displayed. `loadSource()` empties hls.js's audio-track list and
    // resets the selected track name, so once the replacement manifest arrives hls.js picks the
    // group's default -- unless the player names the track again at the point the new group appears.
    const harness = createPlaybackHarness({
      cdn: {
        ...STREAM,
        edges: ['edge-01.cdn.test', 'edge-01.cdn.test', 'edge-03.cdn.test'],
        levels: [{ ...STREAM.levels[0], audioGroup: 'aud1' }],
        audioRenditions: [
          { groupId: 'aud1', name: 'Русский', language: 'ru', default: true },
          { groupId: 'aud1', name: 'English', language: 'en' },
        ],
      },
      audioTracks: [
        { name: 'Русский', number: '1', lang: 'ru', default: true },
        { name: 'English', number: '2', lang: 'en' },
      ],
      autoPlay: true,
    });

    await harness.advance(20000);
    harness.interact((player) => {
      player.audioTrack = 'English';
    });
    await harness.advance(2000);
    expect(harness.player.hls!.audioTracks[harness.player.hls!.audioTrack].name).toBe('English');

    harness.cdn.intercept((request) =>
      request.kind === 'fragment' && request.host === 'edge-01.cdn.test' && harness.cdn.segmentIndexOf(request.path) >= 20
        ? { status: 502 }
        : undefined,
    );

    await harness.advance(200000);

    expect(actions(harness)).toContain('watchdog-reload');
    // The player's own view of the choice never changed, so a mismatch here is the settings menu
    // and the audio disagreeing -- which is exactly what was reported.
    expect(harness.player.audioTrack).toBe('English');
    expect(harness.player.hls!.audioTracks[harness.player.hls!.audioTrack].name).toBe('English');

    harness.destroy();
  });

  it('escalates a hanging edge itself rather than waiting for hls.js to call it fatal', async () => {
    // The worst version of the failure: the connection is accepted and then abandoned. hls.js does
    // notice -- each request eventually times out -- but a timeout is non-fatal, so it simply
    // requests the same unanswerable URL again. Nothing escalates on its own for minutes, while the
    // viewer has been looking at a frozen picture the whole time.
    const harness = createPlaybackHarness({ cdn: STREAM, autoPlay: true });
    harness.cdn.intercept((request) =>
      request.kind === 'fragment' && harness.cdn.segmentIndexOf(request.path) >= 12 ? { hang: true } : undefined,
    );

    await harness.advance(200000, 200);

    // hls.js's own behaviour: timeouts, and only timeouts, for a long time.
    expect(harness.hlsErrors.length).toBeGreaterThan(0);
    expect(harness.hlsErrors.every((error) => error.reason === 'networkError / fragLoadTimeOut')).toBe(true);

    expect(harness.hlsErrors.some((error) => error.fatal)).toBe(false);

    // The player's: the watchdog has already refetched the playlist twice inside the window in
    // which hls.js has not yet been willing to call the stream broken. Waiting for the fatal error
    // instead is what left the picture frozen. If an upgrade makes hls.js escalate inside this
    // window, this assertion fails -- which is the signal to reconsider the watchdog.
    expect(actions(harness)).toEqual(expect.arrayContaining(['watchdog-restart', 'watchdog-reload']));

    harness.destroy();
  });

  it('starts from a clean budget on a manual retry and resumes when the CDN recovers', async () => {
    const harness = createPlaybackHarness({ cdn: STREAM, autoPlay: true });
    const stopFailing = harness.cdn.intercept((request) => (request.kind === 'fragment' ? { status: 502 } : undefined));

    await harness.advance(700000, 200);
    expect(harness.player.failure).toBeDefined();

    stopFailing();
    harness.reload();
    await harness.advance(60000, 100);

    // All of the watchdog's state lives in closure variables, so a retry that reused them would
    // inherit a spent budget and declare the fresh attempt dead within seconds.
    expect(harness.player.failure).toBeUndefined();
    expect(harness.player.recovery).toMatchObject({ exhausted: false });
    expect(harness.video.currentTime).toBeGreaterThan(0);

    harness.destroy();
  });
});
