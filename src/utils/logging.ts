import * as Sentry from '@sentry/browser';
import { Integrations as TracingIntegrations } from '@sentry/tracing';

import { APP_VERSION } from 'utils/app';

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
 * Playback problems worth a report. Deliberately narrow: these are conditions the player could not
 * resolve on its own, or a decoder that is visibly struggling — not every transient error.
 */
export type PlaybackIssue =
  | 'fatal-network-recovery-exhausted'
  | 'fatal-media-recovery-exhausted'
  | 'fatal-unrecoverable'
  | 'stall-watchdog-exhausted'
  | 'decode-health-severe';

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
    // Playback keeps going in most of these cases, so they are not crashes; but they are the
    // failures worth acting on, hence error rather than warning for the exhausted ones.
    scope.setLevel(issue === 'decode-health-severe' ? Sentry.Severity.Warning : Sentry.Severity.Error);

    Sentry.captureMessage(`playback: ${issue}`);
  });
}
