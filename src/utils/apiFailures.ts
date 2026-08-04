/**
 * Rules for reporting backend failures.
 *
 * The API client used to catch everything and return `{ error }`, so a backend that was down, a CDN
 * edge serving an HTML error page, and a genuine empty result were indistinguishable from outside —
 * and none of them reached Sentry. The playback path had an elaborate reporting pipeline while the
 * layer that talks to the backend reported nothing at all, which is backwards: the app misbehaving
 * because the service misbehaved is the more common complaint.
 *
 * These are the pure parts, kept apart from `utils/logging` so they can be tested without
 * initialising Sentry. Two of them exist specifically because getting them wrong is silent: the
 * endpoint normaliser (a leaked token or an unbounded tag cardinality is not visible from inside)
 * and the reportable-status rule (a flood is only noticed once the quota is gone).
 */

export type ApiFailureKind =
  /** The request never completed: no route, DNS failure, TLS refused, connection dropped. */
  | 'unreachable'
  /** The backend answered with a status that is not a success. */
  | 'http'
  /** The backend answered, but not with JSON — usually an error page from something in front of it. */
  | 'malformed';

export type ApiFailure = {
  kind: ApiFailureKind;
  /** Request path. Normalised before use; never carries a query string. */
  endpoint: string;
  method: string;
  status?: number;
  reason?: string;
};

/**
 * Reduces a request path to something safe and groupable.
 *
 * Two jobs. The query string goes, because it carries `access_token` on every authenticated call —
 * this must not depend on the caller having stripped it. And numeric path segments become `{id}`,
 * so `/v1/items/4821` and `/v1/items/9930` are one failing endpoint rather than two thousand tags,
 * and a Sentry tag cannot be used to reconstruct what somebody watched.
 */
export function normalizeEndpoint(url: string) {
  const [path] = url.split('?');

  return path.replace(/\/\d+(?=\/|$)/g, '/{id}') || '/';
}

/**
 * Whether an unsuccessful HTTP status is worth a report.
 *
 * Two exemptions, both for responses that are part of normal operation rather than a fault:
 *
 * - **401.** The access token expires routinely and the client refreshes it. Reporting that would
 *   mean reporting every session.
 * - **The OAuth device flow.** Pairing polls `/oauth2/device` every ten seconds and *expects* an
 *   unsuccessful status carrying `error: authorization_pending` until the user confirms on another
 *   device. Reporting those would send a burst of identical events every time somebody pairs a TV —
 *   the deduplication downstream would collapse them, but the first one would still be a false
 *   report of a broken endpoint. Transport failures on those requests are still worth having, so
 *   this only exempts the status, not the whole request.
 */
export function shouldReportHttpStatus(status: number, options: { isAuthorizationRequest?: boolean } = {}) {
  if (status >= 200 && status < 400) {
    return false;
  }

  if (status === 401) {
    return false;
  }

  return !options.isAuthorizationRequest;
}

/**
 * Identity for deduplication: one report per endpoint per kind of failure per session.
 *
 * A backend that is down fails every request the app makes, and a view that retries on focus can
 * make the same one repeatedly. The useful fact is "this endpoint failed this way in this session",
 * not how many times — the same reasoning as `logPlaybackIssue`, which exists because a few hundred
 * events an evening buries the signal and spends the quota.
 */
export function apiFailureKey(failure: ApiFailure) {
  return [failure.kind, failure.method, normalizeEndpoint(failure.endpoint), failure.status ?? ''].join(' ');
}

/** The Sentry message. Kept here so the grouping it produces is covered by tests. */
export function describeApiFailure(failure: ApiFailure) {
  const path = normalizeEndpoint(failure.endpoint);
  const status = failure.status === undefined ? '' : ` ${failure.status}`;

  return `api: ${failure.kind} ${failure.method} ${path}${status}`;
}

/**
 * A server fault is an error; anything else is a warning.
 *
 * 5xx is the backend telling us it broke. A 4xx is usually this client asking for something wrong,
 * and an unreachable host during a network outage is not a fault of either side — both are worth
 * recording without being worth alerting on.
 */
export function isServerFault(failure: ApiFailure) {
  return failure.kind === 'http' && failure.status !== undefined && failure.status >= 500;
}
