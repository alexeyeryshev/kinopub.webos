import isArray from 'lodash/isArray';
import { serialize } from 'object-to-formdata';

import { isAuthorizationPollingGrant, shouldReportHttpStatus } from 'utils/apiFailures';
import { logApiFailure } from 'utils/logging';

type Primitive = string | number | boolean;

type Param = Primitive | null | undefined | Param[] | { [key: string]: Param };

type Params = Record<string, Param> | null;

function isPrimitive(value: any): value is Primitive {
  return value !== Object(value);
}

export const stringifyParams = (params?: Params) =>
  JSON.stringify(params, (_, value) => {
    if (value === null || value === '') {
      return undefined;
    }

    return value;
  });

export const encodeParam = (param: Param) =>
  encodeURIComponent(isPrimitive(param) ? (param as Primitive) : stringifyParams(param as Record<string, Param>));

export const normalizeArrayParams = (key: string, params: Param[]) =>
  params.map((param, idx) => `${encodeParam(`${key}[${idx}]`)}=${encodeParam(param)}`).join('&');

export const normalizeParams = (params?: Params) =>
  Object.keys(params || {})
    .filter((key) => params?.[key] !== '' && params?.[key] !== null && params?.[key] !== undefined)
    .map((key) => (isArray(params?.[key]) ? normalizeArrayParams(key, params?.[key]! as Param[]) : `${key}=${encodeParam(params?.[key])}`))
    .join('&');

class BaseApiClient {
  protected baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.startsWith('http')
      ? baseUrl
      : window.location.protocol.startsWith('http')
      ? `${window.location.protocol}//${baseUrl}`
      : `http://${baseUrl}`;
  }

  /**
   * The return contract is deliberately unchanged: the parsed body on any answer, `{ error }` when
   * something threw. Callers depend on that shape — the OAuth device flow reads `response.error` to
   * decide whether pairing is still pending — so this reports failures *beside* the existing
   * behaviour rather than reshaping it. Turning a non-2xx into a thrown error would be a larger
   * change than it looks, since the backend answers some of them with a body the app uses.
   */
  private async request<T>(method: 'GET' | 'POST', url: string, params?: Params, data?: Params) {
    const accessToken = this.getAccessToken();
    const grantType = params?.['grant_type'];
    // Two different questions, deliberately not the same predicate. *Any* OAuth request must go out
    // without an access token attached. Only the polling one expects unsuccessful statuses -- the
    // grants that start pairing and renew a session are single requests that expect to succeed, and
    // exempting those would hide a broken login, which is the failure most worth hearing about.
    const isAuthorizationRequest = Boolean(grantType);
    const isAuthorizationPolling = isAuthorizationPollingGrant(grantType);

    if (accessToken && !isAuthorizationRequest) {
      params = {
        ...params,
        access_token: accessToken,
      };
    }

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${url}?${normalizeParams(params)}`, {
        method,
        body: data && serialize(data),
      });
    } catch (ex) {
      // Nothing came back at all. Worth reporting even for an authorization request: the endpoint
      // being unreachable is a fault whoever it belongs to.
      logApiFailure({ kind: 'unreachable', endpoint: url, method, reason: (ex as Error)?.message });

      return {
        error: (ex as Error).toString(),
      } as unknown as T;
    }

    if (response.status === 401) {
      this.clearTokens();
    }

    if (shouldReportHttpStatus(response.status, { isAuthorizationPolling })) {
      logApiFailure({ kind: 'http', endpoint: url, method, status: response.status });
    }

    try {
      const json = await response.json();

      return json as T;
    } catch (ex) {
      // Answered, but not with JSON. An HTML error page from something in front of the API is the
      // usual cause, and until now it surfaced as an indistinguishable `{ error }` with the status
      // already thrown away.
      logApiFailure({ kind: 'malformed', endpoint: url, method, status: response.status, reason: (ex as Error)?.message });

      return {
        error: (ex as Error).toString(),
      } as unknown as T;
    }
  }

  protected get<T>(url: string, params?: Params) {
    return this.request<T>('GET', url, params);
  }

  protected post<T>(url: string, data?: Params, params?: Params) {
    return this.request<T>('POST', url, params, data);
  }

  protected getAccessToken(): string {
    throw new Error('not implemented');
  }

  protected getRefreshToken(): string {
    throw new Error('not implemented');
  }

  protected saveTokens({
    access_token,
    refresh_token,
    expires_in,
  }: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }): void | Promise<void> {
    throw new Error('not implemented');
  }

  protected clearTokens(): void | Promise<void> {
    throw new Error('not implemented');
  }
}

export default BaseApiClient;
