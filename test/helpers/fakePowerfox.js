// -----------------------------------------------------------------------------
// A fake powerfox cloud, as a `fetch` replacement: serves the recorded
// responses of test/fixtures/powerfox, checks the Basic authentication, and
// can answer 401, 429 or fail like the network. Tests never touch the network.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/powerfox/${name}.json`, import.meta.url), 'utf8'));

export const ACCOUNT = { email: 'jane@example.com', password: 's3cret-Pa55word' };

// The readers of all-types.json, by powerfox id.
export const IDS = {
  prosumer: 'a0b1c2d3e4f5',
  consumer: 'a0b1c2d3e4f9',
  coldWater: 'a0b1c2d3e4f7',
  hotWater: 'a0b1c2d3e4fa',
  heat: 'a0b1c2d3e4fb',
  gas: 'a0b1c2d3e4f8',
  coldHotWater: 'a0b1c2d3e4fc',
  noType: 'a0b1c2d3e4fd',
};

const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

/**
 * @param {object} [options]
 * @param {object[]} [options.devices] my/all/devices
 * @param {Record<string, object>} [options.current] my/<id>/current, by id
 * @param {Record<string, object>} [options.reports] my/<id>/report, by id
 */
export function createPowerfox(options = {}) {
  const server = {
    devices: options.devices ?? fixture('all-types'),
    current: options.current ?? {
      [IDS.prosumer]: fixture('power-meter'),
      [IDS.consumer]: fixture('power-meter-full'),
      [IDS.coldWater]: fixture('water-meter'),
      [IDS.hotWater]: {
        Outdated: false,
        CubicMeterCold: 0,
        CubicMeterWarm: 42.5,
        Timestamp: 1703069107,
      },
      [IDS.heat]: fixture('heat-meter'),
      [IDS.coldHotWater]: {
        Outdated: false,
        CubicMeterCold: 12.25,
        CubicMeterWarm: 3.5,
        Timestamp: 1703069107,
      },
    },
    reports: options.reports ?? {
      [IDS.prosumer]: fixture('power-report'),
      [IDS.consumer]: fixture('power-report'),
      [IDS.gas]: fixture('gas-report'),
    },
    account: options.account ?? ACCOUNT,
    /** Every request: { path, query, authorized } */
    calls: [],
    /** Forced answer for the next requests: { status, headers, body } or 'network'. */
    failure: null,
  };

  server.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const path = target.pathname.replace(/^\/api\/2\.0\//, '');
    const expected = `Basic ${Buffer.from(`${server.account.email}:${server.account.password}`).toString('base64')}`;
    const authorized = init.headers?.Authorization === expected;
    server.calls.push({ path, query: Object.fromEntries(target.searchParams), authorized });

    if (target.host !== 'backend.powerfox.energy' || !target.pathname.startsWith('/api/2.0/')) {
      return json({ error: 'not found' }, 404);
    }
    if (server.failure === 'network') {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    }
    if (server.failure) {
      return json(server.failure.body ?? '', server.failure.status, server.failure.headers);
    }
    if (!authorized) {
      return new Response('', { status: 401 });
    }
    if (path === 'my/all/devices') {
      return json(server.devices);
    }
    const match = path.match(/^my\/([^/]+)\/(current|report)$/);
    if (!match) {
      return json({ error: 'not found' }, 404);
    }
    const [, id, endpoint] = match;
    const table = endpoint === 'current' ? server.current : server.reports;
    if (!(id in table)) {
      // What powerfox answers for a gas meter's current reading, among others.
      return json({}, 200);
    }
    return json(table[id]);
  };

  server.count = (predicate = () => true) => server.calls.filter(predicate).length;
  server.countPath = (path) => server.count((call) => call.path === path);
  return server;
}
