// -----------------------------------------------------------------------------
// A connected test world: the SDK's fake Gladys, the integration's real
// wiring (src/app.js) and the fake powerfox cloud.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevice } from '../../src/devices.js';
import { parseDevices } from '../../src/powerfox/model.js';
import { ACCOUNT, createPowerfox } from './fakePowerfox.js';

export const SELECTOR = 'test-integration';

/** The devices Gladys would hold once the user added these readers. */
export function createdDevices(powerfoxDevices, ids, rawConfig = {}) {
  const probe = createFakeGladys();
  const config = normalizeConfig({ ...ACCOUNT, ...rawConfig });
  return parseDevices(powerfoxDevices)
    .filter((meter) => ids.includes(meter.id) && meter.kind !== null)
    .map((meter) => buildDevice(probe, meter, config));
}

/**
 * @param {object} [options]
 * @param {object} [options.config] raw configuration (the account by default)
 * @param {string[]} [options.created] powerfox ids of the readers added to Gladys
 * @param {object} [options.powerfox] options of createPowerfox
 * @param {boolean} [options.timers]
 * @param {() => number} [options.now]
 * @param {boolean} [options.connect]
 */
export async function createWorld(options = {}) {
  const powerfox = createPowerfox(options.powerfox);
  const config = options.config ?? { ...ACCOUNT };
  const gladys = createFakeGladys({
    config,
    devices: createdDevices(powerfox.devices, options.created ?? [], config),
  });
  const app = registerHandlers(gladys, {
    fetch: powerfox.fetch,
    timers: options.timers ?? false,
    now: options.now,
  });
  if (options.connect !== false) {
    await gladys.connect();
  }
  return { gladys, app, hub: app.hub, powerfox };
}

/** Let the work started by a fired timer run to its end. */
export async function settle() {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Capture what the loggers write (the SDK logger writes through console). */
export function captureLogs(t) {
  const lines = [];
  for (const stream of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  return lines;
}
