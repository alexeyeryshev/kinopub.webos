import * as Sentry from '@sentry/browser';
import { Integrations as TracingIntegrations } from '@sentry/tracing';

import { APP_VERSION } from 'utils/app';
import { EpisodeSink, EpisodeSummary } from 'utils/playbackEpisode';

/**
 * Playback failures are reported here as well as in the on-screen diagnostics.
 *
 * The QR capture exists because the network is exactly what breaks during a stall, so it stays the
 * reliable path. Sentry covers the more common case: the app or the backend misbehaving while the
 * connection is fine. The two are complementary, not alternatives.
 */
Sentry.init({
  release: APP_VERSION,
  dsn: 'https://627d68f05165b49ebcb52675dc97e3bc@o4511850860576768.ingest.de.sentry.io/4511850884431952',
  integrations: [new TracingIntegrations.BrowserTracing()],
  tracesSampleRate: 1.0,
  // Stream URLs carry access tokens in their query string, and they turn up in breadcrumbs, request
  // data and error messages alike. Reduce every URL to its hostname before anything leaves the TV —
  // the same rule the diagnostics overlay follows.
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
  // The recovery trail is the payload: a stalled episode wants its whole chain of retries and
  // watchdog actions attached, and the default of 100 leaves room for that once repeated errors
  // are aggregated rather than breadcrumbed one by one.
  maxBreadcrumbs: 100,
});

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    const match = url.match(/^(?:[a-z]+:)?\/\/([^/?#]+)/i);

    return match?.[1] || '[url]';
  }
}

/** Replaces every URL in a string with its bare hostname. */
export function scrubUrls<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(URL_PATTERN, (url) => hostnameOf(url)) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map(scrubUrls) as unknown as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      result[key] = scrubUrls(entry);
    });

    return result as unknown as T;
  }

  return value;
}

function scrubEvent(event: Sentry.Event) {
  return scrubUrls(event);
}

function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb) {
  return scrubUrls(breadcrumb);
}

export function logError(message: string) {
  Sentry.captureMessage(message);
}

export function logException(exception: any) {
  Sentry.captureException(exception);
}

/**
 * Standalone playback problems, reported once per session.
 *
 * Failures the player tries to recover from are *not* here: they belong to a recovery episode,
 * which reports the whole chain and its outcome as one event (see `sentryEpisodeSink`). Sending
 * both would tell the same story twice and spend the quota doing it.
 */
export type PlaybackIssue = 'decode-health-severe';

export type PlaybackIssueContext = {
  reason?: string;
  /** Hostname only — never a full URL. */
  host?: string;
  quality?: string;
  streamingType?: string;
  attempts?: number;
  limit?: number;
  droppedRatio?: number;
  decodeErrors?: number;
  levelCount?: number;
  currentLevel?: number;
  bandwidthEstimate?: number;
};

/**
 * One report per issue per playback session.
 *
 * This matters more than it looks. The failure this project has been chasing produces a few hundred
 * errors a minute; reporting each one would bury the signal and burn the quota in a single evening.
 * The interesting fact is "this session hit this wall", not how many times it bounced off it.
 */
const reportedIssues = new Set<PlaybackIssue>();

export function resetPlaybackIssueReports() {
  reportedIssues.clear();
}

export function logPlaybackIssue(issue: PlaybackIssue, context: PlaybackIssueContext = {}) {
  if (reportedIssues.has(issue)) {
    return;
  }

  reportedIssues.add(issue);

  Sentry.withScope((scope) => {
    scope.setTag('playback_issue', issue);

    if (context.reason) {
      scope.setTag('playback_reason', context.reason);
    }

    if (context.host) {
      scope.setTag('playback_host', context.host);
    }

    if (context.streamingType) {
      scope.setTag('streaming_type', context.streamingType);
    }

    scope.setContext('playback', scrubUrls({ ...context }));
    // Playback keeps going through these, so they are warnings rather than crashes.
    scope.setLevel(Sentry.Severity.Warning);

    Sentry.captureMessage(`playback: ${issue}`);
  });
}

/**
 * Sends recovery episodes to Sentry: each step as a breadcrumb, one event when the episode
 * concludes. The breadcrumbs Sentry has collected by then ride along with that event, so the
 * report answers not just "what failed" but "what the player did about it, and whether it worked".
 */
export const sentryEpisodeSink: EpisodeSink = {
  breadcrumb: (crumb) => {
    Sentry.addBreadcrumb({
      category: crumb.category,
      message: crumb.message,
      level: crumb.level === 'error' ? Sentry.Severity.Error : crumb.level === 'warning' ? Sentry.Severity.Warning : Sentry.Severity.Info,
      data: crumb.data ? scrubUrls(crumb.data) : undefined,
    });
  },

  report: (summary: EpisodeSummary) => {
    Sentry.withScope((scope) => {
      scope.setTag('playback_episode', summary.outcome);

      if (summary.lastReason) {
        scope.setTag('playback_reason', summary.lastReason);
      }

      if (summary.host) {
        scope.setTag('playback_host', summary.host);
      }

      // The action that immediately preceded recovery is the single most useful field here: it is
      // what tells us which recovery path actually works against this failure.
      if (summary.recoveredAfter) {
        scope.setTag('playback_recovered_after', summary.recoveredAfter);
      }

      scope.setContext('playback_episode', scrubUrls({ ...summary }));
      scope.setLevel(summary.outcome === 'abandoned' ? Sentry.Severity.Error : Sentry.Severity.Warning);

      Sentry.captureMessage(
        summary.outcome === 'abandoned'
          ? `playback: recovery abandoned after ${Math.round(summary.durationMs / 1000)}s`
          : `playback: recovered after ${Math.round(summary.durationMs / 1000)}s via ${summary.recoveredAfter || 'retry'}`,
      );
    });
  },
};
