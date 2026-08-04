import {
  EPISODE_ABANDON_GRACE_MS,
  EPISODE_ERROR_SUMMARY_INTERVAL_MS,
  EpisodeCrumb,
  EpisodeSummary,
  createPlaybackEpisodeTracker,
} from './playbackEpisode';

const T0 = 1_700_000_000_000;

function setup() {
  const crumbs: EpisodeCrumb[] = [];
  const reports: EpisodeSummary[] = [];
  const tracker = createPlaybackEpisodeTracker({
    breadcrumb: (crumb) => crumbs.push(crumb),
    report: (summary) => reports.push(summary),
  });

  return { crumbs, reports, tracker };
}

describe('createPlaybackEpisodeTracker', () => {
  it('stays quiet while nothing is wrong', () => {
    const { crumbs, reports, tracker } = setup();

    tracker.noteError('network', T0, false);
    tracker.noteProgress(T0 + 1000);
    tracker.tick(T0 + 60000);

    expect(tracker.isActive()).toBe(false);
    expect(crumbs).toHaveLength(0);
    expect(reports).toHaveLength(0);
  });

  it('opens an episode on a fatal error and reports it as recovered when playback resumes', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'networkError / fragLoadError', 'edge.example.net');
    tracker.noteAction('fatal-retry', T0 + 1000, { attempt: 1 });
    tracker.noteProgress(T0 + 4000, 'fatal-retry');

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: 'recovered',
      fatalCount: 1,
      actions: ['fatal-retry'],
      lastReason: 'networkError / fragLoadError',
      host: 'edge.example.net',
      recoveredAfter: 'fatal-retry',
      durationMs: 4000,
    });
  });

  it('answers whether the watchdog rescued playback', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'networkError / fragLoadError');
    tracker.noteExhausted('fatal-network', T0 + 40000, 'networkError / fragLoadError');
    tracker.noteAction('watchdog-restart', T0 + 50000);
    tracker.noteAction('watchdog-reload', T0 + 62000);
    tracker.noteProgress(T0 + 65000, 'watchdog-reload');

    expect(reports[0].outcome).toBe('recovered');
    expect(reports[0].recoveredAfter).toBe('watchdog-reload');
    expect(reports[0].exhausted).toEqual(['fatal-network']);
    expect(reports[0].actions).toEqual(['watchdog-restart', 'watchdog-reload']);
  });

  it('reports abandonment once the grace period passes with no progress', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'networkError / fragLoadError');
    tracker.noteExhausted('fatal-network', T0 + 40000);

    tracker.tick(T0 + 40000 + EPISODE_ABANDON_GRACE_MS - 1);
    expect(reports).toHaveLength(0);

    tracker.tick(T0 + 40000 + EPISODE_ABANDON_GRACE_MS);
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe('abandoned');
    expect(tracker.isActive()).toBe(false);
  });

  it('aggregates a flood of non-fatal errors instead of breadcrumbing each', () => {
    const { crumbs, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');

    // ~3 errors a second for a minute: what the LG G5 captures actually showed.
    for (let i = 1; i <= 180; i += 1) {
      tracker.noteError('network', T0 + i * 333, false);
    }

    const summaries = crumbs.filter((crumb) => crumb.message.endsWith('non-fatal errors'));

    // One summary per interval, not one per error.
    expect(summaries.length).toBeLessThanOrEqual(Math.ceil(60000 / EPISODE_ERROR_SUMMARY_INTERVAL_MS));
    expect(crumbs.length).toBeLessThan(20);
  });

  it('still counts every error it did not breadcrumb', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteAction('fatal-retry', T0 + 50);
    for (let i = 1; i <= 100; i += 1) {
      tracker.noteError('network', T0 + i * 100, false);
    }
    tracker.noteError('media', T0 + 20000, false);
    tracker.noteProgress(T0 + 21000);

    expect(reports[0].errorCounts).toEqual({ network: 101, media: 1 });
  });

  it('does not report an episode that never saw a fatal error or an exhausted budget', () => {
    const { reports, tracker } = setup();

    // A watchdog restart on its own resolves quietly more often than not.
    tracker.noteAction('watchdog-restart', T0);
    tracker.noteProgress(T0 + 3000, 'watchdog-restart');

    expect(reports).toHaveLength(0);
  });

  it('reports a watchdog-only episode once its budget runs out', () => {
    const { reports, tracker } = setup();

    tracker.noteAction('watchdog-restart', T0);
    tracker.noteExhausted('stall-watchdog', T0 + 60000);
    tracker.tick(T0 + 60000 + EPISODE_ABANDON_GRACE_MS);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: 'abandoned', fatalCount: 0, exhausted: ['stall-watchdog'] });
  });

  it('closes an in-flight episode as abandoned when the source changes', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.reset(T0 + 5000);

    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe('abandoned');
    expect(reports[0].endedBy).toBe('source-change');
    expect(tracker.isActive()).toBe(false);
  });

  it('reports the episode when the player goes away mid-recovery', () => {
    // The viewer pressing Back is the likeliest ending of a broken playback. Losing it biased the
    // abandonment data towards the rare people who waited out the grace period.
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'networkError / fragLoadError');
    tracker.noteAction('fatal-retry', T0 + 1000, { attempt: 1 });
    tracker.reset(T0 + 4000, 'teardown');

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: 'abandoned',
      endedBy: 'teardown',
      durationMs: 4000,
      actions: ['fatal-retry'],
    });
    expect(tracker.isActive()).toBe(false);
  });

  it('separates a hand-driven retry from the player giving up', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteExhausted('fatal-network', T0 + 30000);
    tracker.reset(T0 + 45000, 'manual-retry');

    expect(reports[0].endedBy).toBe('manual-retry');

    // And the retry that follows is a clean story, not a continuation of the one before it.
    tracker.noteError('media', T0 + 50000, true, 'second');
    tracker.noteAction('media-recover', T0 + 50100);
    tracker.noteProgress(T0 + 52000);

    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ outcome: 'recovered', endedBy: 'progress', fatalCount: 1, exhausted: [] });
  });

  it('marks a recovery that timed out as the player giving up, not the viewer', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteExhausted('fatal-network', T0 + 1000);
    tracker.tick(T0 + 1000 + EPISODE_ABANDON_GRACE_MS);

    expect(reports[0].endedBy).toBe('grace-period');
  });

  it('stays quiet when the player goes away with nothing wrong', () => {
    const { reports, tracker } = setup();

    tracker.reset(T0 + 1000, 'teardown');

    expect(reports).toHaveLength(0);
  });

  it('starts clean after a reset', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'first');
    tracker.reset(T0 + 1000);

    tracker.noteError('media', T0 + 2000, true, 'second');
    tracker.noteAction('media-recover', T0 + 2100);
    tracker.noteProgress(T0 + 3000);

    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ fatalCount: 1, lastReason: 'second', errorCounts: { media: 1 } });
  });

  it('does not mistake the buffer draining for a recovery', () => {
    const { reports, tracker } = setup();

    // A fatal error stops the loading engine, but playback coasts on what is already buffered.
    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteProgress(T0 + 500);

    expect(reports).toHaveLength(0);
    expect(tracker.isActive()).toBe(true);

    // Once something is actually tried, progress means what it says.
    tracker.noteAction('fatal-retry', T0 + 1000);
    tracker.noteProgress(T0 + 3000);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: 'recovered', recoveredAfter: 'fatal-retry', durationMs: 3000 });
  });

  it('treats repeated fatals inside one episode as the same story', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'first');
    tracker.noteError('network', T0 + 10000, true, 'second');
    tracker.noteError('network', T0 + 20000, true, 'third');
    tracker.noteAction('fatal-retry', T0 + 20100);
    tracker.noteProgress(T0 + 25000);

    expect(reports).toHaveLength(1);
    expect(reports[0].fatalCount).toBe(3);
    expect(reports[0].lastReason).toBe('third');
  });

  it('re-arming an exhausted budget does not push the abandonment deadline away', () => {
    // The watchdog re-enters its exhausted branch on every 2s tick while playback stays stalled.
    // Re-arming there would move the deadline out faster than time passes, so `abandoned` would
    // never be reported at all.
    const { crumbs, reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteExhausted('stall-watchdog', T0 + 1000);

    for (let t = T0 + 3000; t < T0 + 1000 + EPISODE_ABANDON_GRACE_MS; t += 2000) {
      tracker.noteExhausted('stall-watchdog', t);
      tracker.tick(t);
    }

    expect(reports).toHaveLength(0);

    tracker.tick(T0 + 1000 + EPISODE_ABANDON_GRACE_MS);

    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe('abandoned');
    // And the repeats leave no duplicate entries or breadcrumb spam behind.
    expect(reports[0].exhausted).toEqual(['stall-watchdog']);
    expect(crumbs.filter((crumb) => crumb.message.includes('budget exhausted'))).toHaveLength(1);
  });

  it('does not declare defeat while another recovery path is still escalating', () => {
    // The budgets run on different clocks: the fatal one gives up after ~30s while the watchdog is
    // only starting its 8s restart and three 20s reloads. The deadline armed by the first must not
    // fire on top of the second, or `grace-period` -- the one ending that means "the player ran out
    // of options" -- gets attached to a recovery that was still working.
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'networkError / fragLoadError');
    tracker.noteExhausted('fatal-network', T0 + 30000);

    tracker.noteAction('watchdog-restart', T0 + 45000);
    tracker.tick(T0 + 60001);
    expect(reports).toHaveLength(0);

    tracker.noteAction('watchdog-reload', T0 + 70000);
    tracker.tick(T0 + 76000);
    expect(reports).toHaveLength(0);

    // Once the actions stop, the grace period runs out from the last one.
    tracker.tick(T0 + 70000 + EPISODE_ABANDON_GRACE_MS);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ outcome: 'abandoned', endedBy: 'grace-period' });
    expect(reports[0].actions).toEqual(['watchdog-restart', 'watchdog-reload']);
  });

  it('does not arm a deadline for a recovery that has not run out of anything', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteAction('fatal-retry', T0 + 1000, { attempt: 1 });

    // No budget has been spent, so nothing should ever abandon this on a timer.
    tracker.tick(T0 + 1000 + EPISODE_ABANDON_GRACE_MS * 10);

    expect(reports).toHaveLength(0);
    expect(tracker.isActive()).toBe(true);
  });

  it('still records a genuinely different budget running out', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.noteExhausted('fatal-network', T0 + 1000);
    tracker.noteExhausted('stall-watchdog', T0 + 40000);
    tracker.tick(T0 + 40000 + EPISODE_ABANDON_GRACE_MS);

    expect(reports[0].exhausted).toEqual(['fatal-network', 'stall-watchdog']);
  });

  it('excludes errors that happened before the episode opened', () => {
    const { reports, tracker } = setup();

    // Transient failures between episodes must not be charged to the next one.
    tracker.noteError('network', T0, false);
    tracker.noteError('media', T0 + 100, false);

    tracker.noteError('network', T0 + 5000, true, 'fatal');
    tracker.noteAction('fatal-retry', T0 + 5100);
    tracker.noteError('network', T0 + 6000, false);
    tracker.noteProgress(T0 + 7000);

    expect(reports[0].errorCounts).toEqual({ network: 2 });
  });

  it('carries the stream context set by the player', () => {
    const { reports, tracker } = setup();

    tracker.noteError('network', T0, true, 'fatal');
    tracker.setContext({ quality: '480p', levelCount: 4 });
    tracker.noteAction('fatal-retry', T0 + 100);
    tracker.noteProgress(T0 + 2000);

    expect(reports[0].context).toEqual({ quality: '480p', levelCount: 4 });
  });
});
