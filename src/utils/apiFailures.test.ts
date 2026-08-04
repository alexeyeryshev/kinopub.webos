import { apiFailureKey, describeApiFailure, isServerFault, normalizeEndpoint, shouldReportHttpStatus } from './apiFailures';

describe('normalizeEndpoint', () => {
  it('drops the query string, which carries the access token', () => {
    expect(normalizeEndpoint('/v1/items/4821?access_token=secret&foo=1')).toBe('/v1/items/{id}');
  });

  it('collapses numeric ids so one broken endpoint is one group, not thousands', () => {
    expect(normalizeEndpoint('/v1/items/4821')).toBe('/v1/items/{id}');
    expect(normalizeEndpoint('/v1/items/4821/similar')).toBe('/v1/items/{id}/similar');
    expect(normalizeEndpoint('/v1/watching/4821/12')).toBe('/v1/watching/{id}/{id}');
  });

  it('leaves paths without ids alone', () => {
    expect(normalizeEndpoint('/v1/watching/marktime')).toBe('/v1/watching/marktime');
    expect(normalizeEndpoint('/oauth2/device')).toBe('/oauth2/device');
  });

  it('does not mistake a number inside a word for an id', () => {
    expect(normalizeEndpoint('/v1/types2/list')).toBe('/v1/types2/list');
  });

  it('survives an empty path', () => {
    expect(normalizeEndpoint('')).toBe('/');
    expect(normalizeEndpoint('?access_token=secret')).toBe('/');
  });
});

describe('shouldReportHttpStatus', () => {
  it('says nothing about a successful response', () => {
    expect(shouldReportHttpStatus(200)).toBe(false);
    expect(shouldReportHttpStatus(204)).toBe(false);
    expect(shouldReportHttpStatus(304)).toBe(false);
  });

  it('reports client and server errors', () => {
    expect(shouldReportHttpStatus(400)).toBe(true);
    expect(shouldReportHttpStatus(404)).toBe(true);
    expect(shouldReportHttpStatus(500)).toBe(true);
    expect(shouldReportHttpStatus(503)).toBe(true);
  });

  it('ignores 401, which is a token expiring on schedule rather than a fault', () => {
    expect(shouldReportHttpStatus(401)).toBe(false);
  });

  it('ignores unsuccessful statuses from the OAuth device flow', () => {
    // Pairing polls this every ten seconds and *expects* an unsuccessful status carrying
    // `authorization_pending` until the user confirms elsewhere. Reporting it would mean a false
    // "endpoint is broken" every time somebody sets up a TV.
    expect(shouldReportHttpStatus(400, { isAuthorizationRequest: true })).toBe(false);
    expect(shouldReportHttpStatus(403, { isAuthorizationRequest: true })).toBe(false);
  });
});

describe('apiFailureKey', () => {
  it('treats the same failure on the same endpoint as one report', () => {
    const first = apiFailureKey({ kind: 'http', endpoint: '/v1/items/1?access_token=a', method: 'GET', status: 500 });
    const second = apiFailureKey({ kind: 'http', endpoint: '/v1/items/2?access_token=b', method: 'GET', status: 500 });

    expect(first).toBe(second);
  });

  it('separates different statuses, methods and kinds on one endpoint', () => {
    const base = { endpoint: '/v1/items', method: 'GET' } as const;

    const keys = new Set([
      apiFailureKey({ ...base, kind: 'http', status: 500 }),
      apiFailureKey({ ...base, kind: 'http', status: 404 }),
      apiFailureKey({ ...base, kind: 'malformed', status: 500 }),
      apiFailureKey({ ...base, kind: 'unreachable' }),
      apiFailureKey({ ...base, method: 'POST', kind: 'http', status: 500 }),
    ]);

    expect(keys.size).toBe(5);
  });
});

describe('describeApiFailure', () => {
  it('names the endpoint and status without leaking the query string', () => {
    expect(describeApiFailure({ kind: 'http', endpoint: '/v1/items/99?access_token=secret', method: 'GET', status: 503 })).toBe(
      'api: http GET /v1/items/{id} 503',
    );
  });

  it('omits a status it does not have', () => {
    expect(describeApiFailure({ kind: 'unreachable', endpoint: '/v1/items', method: 'GET' })).toBe('api: unreachable GET /v1/items');
  });
});

describe('isServerFault', () => {
  it('counts only a 5xx answer as the backend breaking', () => {
    expect(isServerFault({ kind: 'http', endpoint: '/v1/items', method: 'GET', status: 500 })).toBe(true);
    expect(isServerFault({ kind: 'http', endpoint: '/v1/items', method: 'GET', status: 404 })).toBe(false);
    // Unreachable during a network outage is nobody's fault and should not read as one.
    expect(isServerFault({ kind: 'unreachable', endpoint: '/v1/items', method: 'GET' })).toBe(false);
    expect(isServerFault({ kind: 'malformed', endpoint: '/v1/items', method: 'GET', status: 200 })).toBe(false);
  });
});
