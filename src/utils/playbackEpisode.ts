/**
 * Tracks a playback *recovery episode* — everything between the first failure and the moment
 * playback either resumes or is given up on — so the whole chain reaches Sentry as one report.
 *
 * The motivating question is "does the stall watchdog's playlist reload actually rescue playback?"
 * A single error report cannot answer it, because the answer is in what happens afterwards. So each
 * recovery step is recorded as a breadcrumb, and one event is sent when the episode concludes,
 * carrying the outcome and the trail that led to it.
 *
 * The hard constraint is volume. The failure this project has been chasing emits roughly three
 * errors a second; breadcrumbing each one would fill Sentry's 100-entry buffer in about half a
 * minute and evict exactly the early context that explains the episode. Repeated errors are
 * therefore counted and summarised on a timer, while the rare, meaningful steps — a fatal error, a
 * recovery action, a budget running out — are recorded individually.
 */

export type EpisodeOutcome = 'recovered' | 'abandoned';

export type EpisodeCrumb = {
  category: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
};

export type EpisodeSummary = {
  outcome: EpisodeOutcome;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** Fatal errors seen during the episode. */
  fatalCount: number;
  /** Every error seen during the episode, by category, including the non-fatal flood. */
  errorCounts: Record<string, number>;
  /** Recovery actions taken, in order, e.g. `fatal-retry`, `watchdog-restart`, `watchdog-reload`. */
  actions: string[];
  /** Which budgets ran out, if any. */
  exhausted: string[];
  lastReason?: string;
  host?: string;
  /** What was happening when the episode resolved, for `recovered` outcomes. */
  recoveredAfter?: string;
  /** Stream details, attached by the player so a report explains what was playing. */
  context?: Record<string, unknown>;
};

export type EpisodeSink = {
  breadcrumb: (crumb: EpisodeCrumb) => void;
  report: (summary: EpisodeSummary) => void;
};

/**
 * How long to wait after the last budget is spent before declaring the episode lost. Long enough to
 * cover the stall watchdog's full escalation (an 8s restart then a 20s playlist reload), because
 * whether that escalation works is the thing worth learning.
 */
export const EPISODE_ABANDON_GRACE_MS = 30000;

/** Minimum gap between "N errors so far" breadcrumbs, so a flood cannot evict the useful trail. */
export const EPISODE_ERROR_SUMMARY_INTERVAL_MS = 10000;

/** An episode that has produced nothing but a single blip is not worth an event. */
export const EPISODE_MIN_FATALS_TO_REPORT = 1;

export function createPlaybackEpisodeTracker(sink: EpisodeSink) {
  let startedAt: number | undefined;
  let fatalCount = 0;
  let errorCounts: Record<string, number> = {};
  let actions: string[] = [];
  let exhausted: string[] = [];
  let lastReason: string | undefined;
  let host: string | undefined;
  let abandonAt: number | undefined;
  let lastErrorSummaryAt = 0;
  let unsummarisedErrors = 0;
  let context: Record<string, unknown> | undefined;

  function reset() {
    startedAt = undefined;
    fatalCount = 0;
    errorCounts = {};
    actions = [];
    exhausted = [];
    lastReason = undefined;
    host = undefined;
    abandonAt = undefined;
    lastErrorSummaryAt = 0;
    unsummarisedErrors = 0;
    context = undefined;
  }

  function begin(now: number) {
    if (startedAt === undefined) {
      startedAt = now;
      lastErrorSummaryAt = now;
      sink.breadcrumb({ category: 'playback', message: 'recovery episode started', level: 'warning' });
    }
  }

  function finish(outcome: EpisodeOutcome, now: number, recoveredAfter?: string) {
    if (startedAt === undefined) {
      return;
    }

    const summary: EpisodeSummary = {
      outcome,
      startedAt,
      endedAt: now,
      durationMs: now - startedAt,
      fatalCount,
      errorCounts: { ...errorCounts },
      actions: [...actions],
      exhausted: [...exhausted],
      lastReason,
      host,
      recoveredAfter,
      context,
    };

    reset();

    if (summary.fatalCount >= EPISODE_MIN_FATALS_TO_REPORT || summary.exhausted.length > 0) {
      sink.report(summary);
    }
  }

  return {
    /** Any hls.js error, fatal or not. Only fatals open an episode; the rest are counted. */
    noteError(category: string, now: number, fatal: boolean, reason?: string, errorHost?: string) {
      if (fatal) {
        begin(now);
      }

      // Only errors inside the episode belong in its summary. Counting the quiet ones that happen
      // between episodes would inflate the next report with failures it did not involve.
      if (startedAt === undefined) {
        return;
      }

      errorCounts[category] = (errorCounts[category] || 0) + 1;

      if (fatal) {
        fatalCount += 1;
        lastReason = reason;
        host = errorHost || host;
        sink.breadcrumb({
          category: 'playback',
          message: `fatal ${category} error`,
          level: 'error',
          data: { reason, host: errorHost },
        });

        return;
      }

      unsummarisedErrors += 1;

      // Aggregate rather than breadcrumb each one — see the note at the top of this file.
      if (now - lastErrorSummaryAt >= EPISODE_ERROR_SUMMARY_INTERVAL_MS) {
        sink.breadcrumb({
          category: 'playback',
          message: `${unsummarisedErrors} non-fatal errors`,
          level: 'info',
          data: { ...errorCounts },
        });
        lastErrorSummaryAt = now;
        unsummarisedErrors = 0;
      }
    },

    /** Stream details for the eventual report. Last write wins, so it can be refreshed freely. */
    setContext(next: Record<string, unknown>) {
      context = next;
    },

    /** A recovery step the application took. */
    noteAction(action: string, now: number, data?: Record<string, unknown>) {
      begin(now);
      actions.push(action);
      sink.breadcrumb({ category: 'playback', message: action, level: 'info', data });
    },

    /**
     * A recovery budget ran out. Arms the abandonment timer.
     *
     * Idempotent per budget on purpose: the watchdog re-enters its exhausted branch on every tick
     * while playback stays stalled, and re-arming there would push the deadline further out every
     * two seconds so the abandoned episode would never be reported at all.
     */
    noteExhausted(which: string, now: number, reason?: string) {
      begin(now);

      if (exhausted.includes(which)) {
        return;
      }

      exhausted.push(which);
      lastReason = reason || lastReason;
      abandonAt = now + EPISODE_ABANDON_GRACE_MS;
      sink.breadcrumb({ category: 'playback', message: `${which} budget exhausted`, level: 'error', data: { reason } });
    },

    /**
     * Playback moved again. Resolves the episode as recovered — the answer worth having.
     *
     * Credit defaults to the last recovery action taken, since that is the one that plausibly
     * worked; this is what makes `playback_recovered_after` in Sentry meaningful.
     */
    noteProgress(now: number, after?: string) {
      if (startedAt === undefined) {
        return;
      }

      // A fatal error stops hls.js's loading engine, so playback carrying on straight afterwards is
      // the buffer draining, not a recovery. Keep the episode open until something has actually
      // been attempted, or the two halves of one failure arrive as two unrelated reports.
      if (actions.length === 0 && exhausted.length === 0) {
        return;
      }

      const credit = after || actions[actions.length - 1];

      sink.breadcrumb({ category: 'playback', message: 'playback resumed', level: 'info', data: { after: credit } });
      finish('recovered', now, credit);
    },

    /** Call periodically so an armed abandonment can fire without further events. */
    tick(now: number) {
      if (startedAt !== undefined && abandonAt !== undefined && now >= abandonAt) {
        finish('abandoned', now);
      }
    },

    /** A new source is a new story. Any episode in flight is reported as abandoned first. */
    reset(now: number) {
      if (startedAt !== undefined) {
        finish('abandoned', now);
      }

      reset();
    },

    isActive() {
      return startedAt !== undefined;
    },
  };
}

export type PlaybackEpisodeTracker = ReturnType<typeof createPlaybackEpisodeTracker>;
