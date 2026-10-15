// -----------------------------------------------------------------------------
// Client of the powerfox cloud API (https://backend.powerfox.energy/api/2.0/),
// read only. Same endpoints and error mapping as the python-powerfox library
// (MIT) behind the Home Assistant integration:
//   - my/all/devices             the poweropti readers of the account
//   - my/<id>/current?unit=kwh   the last reading of one reader
//   - my/<id>/report?year&month&day   the hourly report of one day
// Authentication: HTTP Basic with the e-mail and password of the account,
// which never leave this module (no log, no error message carries them).
// -----------------------------------------------------------------------------

export const API_BASE = 'https://backend.powerfox.energy/api/2.0/';
const DEFAULT_TIMEOUT_MS = 30_000;

export class PowerfoxError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'PowerfoxError';
    this.status = status;
  }
}

/** 401: wrong e-mail or password. Retrying would only lock the account. */
export class PowerfoxAuthError extends PowerfoxError {
  constructor() {
    super('powerfox refused the e-mail or the password (HTTP 401)', { status: 401 });
    this.name = 'PowerfoxAuthError';
  }
}

/** 429: too many requests. `retryAfterMs` comes from the Retry-After header, if any. */
export class PowerfoxRateLimitError extends PowerfoxError {
  constructor(retryAfterMs) {
    super('powerfox asks to slow down (HTTP 429)', { status: 429 });
    this.name = 'PowerfoxRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Network failure, timeout or server error: worth retrying later. */
export class PowerfoxConnectionError extends PowerfoxError {
  constructor(message, options) {
    super(message, options);
    this.name = 'PowerfoxConnectionError';
  }
}

/** 412: the owner of the reader denied the data transfer in the powerfox app. */
export class PowerfoxPrivacyError extends PowerfoxError {
  constructor() {
    super('powerfox refuses the data transfer: it is denied in the powerfox app (412)', {
      status: 412,
    });
    this.name = 'PowerfoxPrivacyError';
  }
}

/** Retry-After: seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

// The ids end up in URL paths and in Gladys external ids: refuse anything else.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidDeviceId(id) {
  return typeof id === 'string' && DEVICE_ID_PATTERN.test(id);
}

export class PowerfoxClient {
  /**
   * @param {object} options
   * @param {string} options.email
   * @param {string} options.password
   * @param {typeof fetch} [options.fetch]
   * @param {number} [options.timeoutMs]
   * @param {string} [options.userAgent]
   */
  constructor({ email, password, fetch: fetchImpl = globalThis.fetch, timeoutMs, userAgent }) {
    // Not enumerable: a client logged or inspected by mistake shows no secret.
    Object.defineProperty(this, 'authorization', {
      value: `Basic ${Buffer.from(`${email}:${password}`, 'utf8').toString('base64')}`,
      enumerable: false,
    });
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = userAgent ?? 'gladys-powerfox';
    /** Requests sent, for the logs and the tests. */
    this.requestCount = 0;
  }

  /** The readers of the account (raw list, see model.parseDevices). */
  async allDevices() {
    const body = await this.request('my/all/devices');
    return Array.isArray(body) ? body : [];
  }

  /** The last reading of one reader (raw object, see model.parseCurrent). */
  async current(deviceId) {
    return this.request(`my/${checkedId(deviceId)}/current`, { unit: 'kwh' });
  }

  /** The report of one local day (raw object, see model.parseReport). */
  async report(deviceId, { year, month, day }) {
    return this.request(`my/${checkedId(deviceId)}/report`, { year, month, day });
  }

  async request(path, query = {}) {
    const url = new URL(path, API_BASE);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    this.requestCount += 1;
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization,
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.cause?.code ?? err?.name);
      throw new PowerfoxConnectionError(`powerfox unreachable (${reason ?? 'network error'})`);
    }

    if (response.status === 401) {
      throw new PowerfoxAuthError();
    }
    if (response.status === 429) {
      throw new PowerfoxRateLimitError(parseRetryAfter(response.headers.get('retry-after')));
    }
    if (response.status === 412) {
      throw new PowerfoxPrivacyError();
    }
    if (!response.ok) {
      const ErrorClass = response.status >= 500 ? PowerfoxConnectionError : PowerfoxError;
      throw new ErrorClass(`powerfox answered HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (!type.includes('json')) {
      throw new PowerfoxError(`powerfox answered ${type || 'no content type'} instead of JSON`);
    }
    let body;
    try {
      body = text.trim() === '' ? {} : JSON.parse(text);
    } catch {
      throw new PowerfoxError('powerfox answered invalid JSON');
    }
    raiseEmbeddedError(body);
    return body;
  }
}

function checkedId(deviceId) {
  if (!isValidDeviceId(deviceId)) {
    throw new PowerfoxError('invalid poweropti id');
  }
  return deviceId;
}

// powerfox sometimes answers HTTP 200 with an error envelope
// ({ "StatusCode": 412, "ReasonPhrase": ... }), as python-powerfox handles.
function raiseEmbeddedError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return;
  }
  const status = body.StatusCode;
  if (!Number.isInteger(status) || status < 400) {
    return;
  }
  if (status === 412) {
    throw new PowerfoxPrivacyError();
  }
  if (status === 401) {
    throw new PowerfoxAuthError();
  }
  if (status === 429) {
    throw new PowerfoxRateLimitError(undefined);
  }
  throw new PowerfoxError(`powerfox answered an error ${status}`, { status });
}
