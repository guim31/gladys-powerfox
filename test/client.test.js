import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PowerfoxAuthError,
  PowerfoxClient,
  PowerfoxConnectionError,
  PowerfoxError,
  PowerfoxPrivacyError,
  PowerfoxRateLimitError,
  parseRetryAfter,
} from '../src/powerfox/client.js';
import { ACCOUNT, IDS, createPowerfox, fixture } from './helpers/fakePowerfox.js';

const clientFor = (powerfox, account = ACCOUNT) =>
  new PowerfoxClient({ ...account, fetch: powerfox.fetch });

test('the client reads the three endpoints of the powerfox API with Basic authentication', async () => {
  const powerfox = createPowerfox();
  const client = clientFor(powerfox);
  assert.deepEqual(await client.allDevices(), fixture('all-types'));
  assert.deepEqual(await client.current(IDS.prosumer), fixture('power-meter'));
  assert.deepEqual(
    await client.report(IDS.gas, { year: 2026, month: 10, day: 5 }),
    fixture('gas-report'),
  );
  assert.deepEqual(powerfox.calls, [
    { path: 'my/all/devices', query: {}, authorized: true },
    { path: `my/${IDS.prosumer}/current`, query: { unit: 'kwh' }, authorized: true },
    {
      path: `my/${IDS.gas}/report`,
      query: { year: '2026', month: '10', day: '5' },
      authorized: true,
    },
  ]);
});

test('a wrong password is an authentication error, without the secret in it', async () => {
  const powerfox = createPowerfox();
  const client = clientFor(powerfox, { email: ACCOUNT.email, password: 'wrong' });
  const err = await client.allDevices().catch((error) => error);
  assert.ok(err instanceof PowerfoxAuthError);
  assert.equal(err.status, 401);
  assert.doesNotMatch(`${err.message} ${err.stack}`, /wrong|jane@example\.com/);
  // The client itself hides the header when inspected.
  assert.doesNotMatch(JSON.stringify(client), /Basic|wrong/);
});

test('HTTP 429 is a rate limit, with the Retry-After delay', async () => {
  const powerfox = createPowerfox();
  powerfox.failure = { status: 429, headers: { 'retry-after': '120' } };
  const err = await clientFor(powerfox)
    .allDevices()
    .catch((error) => error);
  assert.ok(err instanceof PowerfoxRateLimitError);
  assert.equal(err.retryAfterMs, 120_000);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30_000);
  assert.equal(parseRetryAfter('Thu, 15 Oct 2026 10:01:00 GMT', now), 60_000);
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

test('server errors and network failures are connection errors, worth retrying', async () => {
  const powerfox = createPowerfox();
  powerfox.failure = { status: 503 };
  assert.ok(
    (await clientFor(powerfox)
      .allDevices()
      .catch((error) => error)) instanceof PowerfoxConnectionError,
  );
  powerfox.failure = 'network';
  const err = await clientFor(powerfox)
    .allDevices()
    .catch((error) => error);
  assert.ok(err instanceof PowerfoxConnectionError);
  assert.match(err.message, /ECONNRESET/);
});

test('an error envelope inside HTTP 200 is an error (412: data transfer denied)', async () => {
  const powerfox = createPowerfox({
    current: { [IDS.prosumer]: { StatusCode: 412, ReasonPhrase: 'Precondition Failed' } },
  });
  const err = await clientFor(powerfox)
    .current(IDS.prosumer)
    .catch((error) => error);
  assert.ok(err instanceof PowerfoxPrivacyError);

  const other = createPowerfox({
    current: { [IDS.prosumer]: { StatusCode: 500, ReasonPhrase: 'Internal' } },
  });
  const failure = await clientFor(other)
    .current(IDS.prosumer)
    .catch((error) => error);
  assert.ok(failure instanceof PowerfoxError);
  assert.equal(failure.status, 500);
});

test('an answer that is not JSON is refused', async () => {
  const client = new PowerfoxClient({
    ...ACCOUNT,
    fetch: async () =>
      new Response('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(client.allDevices(), /instead of JSON/);
});

test('a reader id that could escape the URL path is refused before any request', async () => {
  const powerfox = createPowerfox();
  await assert.rejects(clientFor(powerfox).current('../all/devices'), /invalid poweropti id/);
  assert.equal(powerfox.calls.length, 0);
});
