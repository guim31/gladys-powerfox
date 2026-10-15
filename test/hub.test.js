import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_HEARTBEAT_MS } from '../src/hub.js';
import { ACCOUNT, IDS, fixture } from './helpers/fakePowerfox.js';
import { SELECTOR, captureLogs, createWorld, createdDevices, settle } from './helpers/world.js';

const feature = (id, key) => `ext:${SELECTOR}:poweropti:${id}:${key}`;
const deviceOf = (id) => `ext:${SELECTOR}:poweropti:${id}`;
const currentReads = (powerfox, id) => powerfox.countPath(`my/${id}/current`);
const infoLines = (lines) => lines.filter((line) => line.includes('[INFO]'));

/** Mocked clock and timers, then a connected world. */
async function timedWorld(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-15T10:00:00Z') });
  const lines = captureLogs(t);
  const world = await createWorld({ timers: true, ...options });
  t.after(() => world.app.stop());
  return { ...world, lines };
}

async function tick(t, ms) {
  t.mock.timers.tick(ms);
  await settle();
}

test('discovery publishes one device per supported reader, and reads the added ones', async (t) => {
  const { gladys, powerfox, lines } = await timedWorld(t, {
    created: [IDS.prosumer, IDS.gas],
  });
  assert.equal(gladys.fake.discoveredDevices.length, 7);
  assert.ok(
    infoLines(lines).some((line) => line.includes(`Reader ${IDS.noType} of type -1`)),
    'the reader without a type is ignored, said once',
  );
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });

  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'power')), 111);
  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'energy_import')), 1111.111);
  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'energy_export')), 111.111);
  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'outdated')), 0);
  assert.equal(gladys.fake.lastState(feature(IDS.gas, 'gas_today')), 11.32);
  assert.equal(gladys.fake.lastState(feature(IDS.gas, 'gas_cost_today')), 17.14);

  // Only the readers the user added are read.
  assert.equal(currentReads(powerfox, IDS.prosumer), 1);
  assert.equal(currentReads(powerfox, IDS.consumer), 0);
  assert.equal(currentReads(powerfox, IDS.coldWater), 0);
  // The gas meter has no current reading: the daily report of the local day.
  assert.equal(currentReads(powerfox, IDS.gas), 0);
  assert.deepEqual(powerfox.calls.find((call) => call.path === `my/${IDS.gas}/report`).query, {
    year: '2026',
    month: '10',
    day: '15',
  });
});

test('the container refreshes the states by itself, without any onPoll (Gladys#3198)', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [IDS.prosumer] });
  assert.equal(currentReads(powerfox, IDS.prosumer), 1);

  powerfox.current[IDS.prosumer] = { ...fixture('power-meter'), Watt: -850, Timestamp: 1703069391 };
  await tick(t, 60_000);
  assert.equal(currentReads(powerfox, IDS.prosumer), 2, 'read again one period later');
  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'power')), -850, 'feed-in: negative');

  await tick(t, 60_000);
  assert.equal(currentReads(powerfox, IDS.prosumer), 3);
  assert.equal(
    gladys.fake.requests.filter((request) => request.path === '/device/poll').length,
    0,
    'no poll from the core was needed',
  );
});

test('only the changed values are published, the unchanged ones every 6 hours', async (t) => {
  const { gladys } = await timedWorld(t, { created: [IDS.prosumer] });
  const published = () => gladys.fake.states.length;
  const first = published();
  assert.equal(first, 4);

  await tick(t, 60_000);
  assert.equal(published(), first, 'same reading: nothing sent');

  const before = published();
  for (let elapsed = 0; elapsed < STATE_HEARTBEAT_MS; elapsed += 60_000) {
    await tick(t, 60_000);
  }
  assert.deepEqual(
    gladys.fake.states
      .slice(before)
      .map((state) => state.device_feature_external_id)
      .sort(),
    ['energy_export', 'energy_import', 'outdated', 'power'].map((key) =>
      feature(IDS.prosumer, key),
    ),
    'the heartbeat re-sends every value once in 6 hours',
  );
});

test("the core's onPoll is a fallback: it never reads the API twice in a period", async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [IDS.prosumer] });
  const device = gladys.fake.devices[0];
  await tick(t, 10_000);
  assert.deepEqual(await gladys.fake.poll(device), { success: true });
  assert.equal(currentReads(powerfox, IDS.prosumer), 1, 'the timer read it 10 s ago');

  // The timer stalls: the core takes over, once a period.
  gladys.fake.devices.length = 0; // nothing for the timer to read any more…
  await tick(t, 50_000);
  gladys.fake.devices.push(device); // …but the core still polls the device
  t.mock.timers.tick(5_000);
  await gladys.fake.poll(device);
  assert.equal(currentReads(powerfox, IDS.prosumer), 2);
});

test('a gas meter is read every 5 minutes at most, whatever the interval', async (t) => {
  const { powerfox } = await timedWorld(t, {
    config: { ...ACCOUNT, refresh_interval: '10' },
    created: [IDS.gas, IDS.prosumer],
  });
  const reports = () => powerfox.countPath(`my/${IDS.gas}/report`);
  assert.equal(reports(), 1);
  for (let i = 0; i < 29; i += 1) {
    await tick(t, 10_000);
  }
  assert.equal(currentReads(powerfox, IDS.prosumer), 30, 'electricity: every 10 s');
  assert.equal(reports(), 1, 'gas: not yet');
  await tick(t, 10_000);
  assert.equal(reports(), 2, 'gas: after 5 minutes');
});

test('a stale reading raises the flag and does not refresh the old values', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [IDS.coldWater] });
  assert.equal(gladys.fake.lastState(feature(IDS.coldWater, 'outdated')), 0);
  powerfox.current[IDS.coldWater] = { ...fixture('water-meter'), Outdated: true };
  await tick(t, 60_000);
  assert.equal(gladys.fake.lastState(feature(IDS.coldWater, 'outdated')), 1);

  const before = gladys.fake.states.length;
  for (let elapsed = 0; elapsed < STATE_HEARTBEAT_MS; elapsed += 60_000) {
    await tick(t, 60_000);
  }
  assert.deepEqual(
    gladys.fake.states.slice(before).map((state) => state.device_feature_external_id),
    [feature(IDS.coldWater, 'outdated')],
    'the heartbeat keeps the flag recent, not the stale index',
  );
});

test('an index lower than the last one is a glitch, never published', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [IDS.consumer] });
  const id = feature(IDS.consumer, 'energy_import');
  assert.equal(gladys.fake.lastState(id), 1111.111);
  powerfox.current[IDS.consumer] = { ...fixture('power-meter-full'), A_Plus: 1000 };
  await tick(t, 60_000);
  assert.equal(gladys.fake.lastState(id), 1111.111);
  powerfox.current[IDS.consumer] = { ...fixture('power-meter-full'), A_Plus: 1111.5 };
  await tick(t, 60_000);
  assert.equal(gladys.fake.lastState(id), 1111.5);
});

test('a device just added gets its states at once, and the widget is nudged', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [] });
  assert.equal(currentReads(powerfox, IDS.consumer), 0);
  const [device] = createdDevices(powerfox.devices, [IDS.consumer]);
  await gladys.fake.deviceCreated(device);
  assert.equal(currentReads(powerfox, IDS.consumer), 1);
  assert.equal(gladys.fake.lastState(feature(IDS.consumer, 'power')), 111);
  assert.deepEqual(gladys.fake.widgetRefreshes, ['energy_today']);
});

test('a wrong password stops every request until the configuration changes', async (t) => {
  const { gladys, powerfox, lines } = await timedWorld(t, {
    config: { email: ACCOUNT.email, password: 'wrong-password' },
    created: [IDS.prosumer],
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /mot de passe/);
  assert.equal(powerfox.calls.length, 1);
  for (let i = 0; i < 10; i += 1) {
    await tick(t, 60_000);
  }
  assert.equal(powerfox.calls.length, 1, 'no retry with a refused password');
  assert.equal(lines.filter((line) => line.includes('[ERROR]')).length, 1);

  await gladys.fake.configUpdated({ ...ACCOUNT });
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'power')), 111);
  await tick(t, 60_000);
  assert.equal(currentReads(powerfox, IDS.prosumer), 2, 'the timer runs again');
});

test('HTTP 429 pauses every request for the Retry-After delay', async (t) => {
  const { gladys, powerfox, lines } = await timedWorld(t, { created: [IDS.prosumer] });
  powerfox.failure = { status: 429, headers: { 'retry-after': '600' } };
  await tick(t, 60_000);
  assert.equal(powerfox.calls.length, 3, 'list, first read, refused read');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);

  for (let i = 0; i < 9; i += 1) {
    await tick(t, 60_000);
  }
  assert.equal(powerfox.calls.length, 3, 'nothing during the 10 minutes asked');

  powerfox.failure = null;
  await tick(t, 60_000);
  assert.equal(powerfox.calls.length, 4);
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  const warnings = lines.filter((line) => line.includes('[WARN]'));
  assert.equal(warnings.length, 1);
  assert.ok(infoLines(lines).some((line) => line.includes('accepts requests again')));
});

test('without Retry-After, the pause doubles up to 30 minutes', async (t) => {
  const { hub, powerfox } = await timedWorld(t, { created: [IDS.prosumer] });
  powerfox.failure = { status: 429 };
  const pauses = [];
  for (let i = 0; i < 6; i += 1) {
    const before = Date.now();
    await hub.pollMeter(hub.meters.get(IDS.prosumer), { force: true });
    pauses.push((hub.pausedUntil - before) / 60_000);
    t.mock.timers.tick(hub.pausedUntil - Date.now());
  }
  assert.deepEqual(pauses, [2, 4, 8, 16, 30, 30]);
});

test('an outage writes one line when it starts and one when it is over', async (t) => {
  const { gladys, powerfox, lines } = await timedWorld(t, { created: [IDS.prosumer] });
  powerfox.failure = 'network';
  for (let i = 0; i < 5; i += 1) {
    await tick(t, 60_000);
  }
  assert.equal(lines.filter((line) => line.includes('[WARN]')).length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.de, /antwortet nicht/);

  powerfox.failure = null;
  await tick(t, 60_000);
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  assert.equal(infoLines(lines).filter((line) => line.includes('reachable again')).length, 1);
});

test('a normal refresh cycle writes nothing at the info level', async (t) => {
  const { lines } = await timedWorld(t, { created: Object.values(IDS) });
  const startup = lines.length;
  for (let i = 0; i < 10; i += 1) {
    await tick(t, 60_000);
  }
  assert.deepEqual(lines.slice(startup), []);
});

test('no secret of the configuration ever reaches the logs, even at the debug level', async (t) => {
  process.env.LOG_LEVEL = 'debug';
  t.after(() => delete process.env.LOG_LEVEL);
  const { gladys, powerfox, lines } = await timedWorld(t, { created: Object.values(IDS) });
  await tick(t, 60_000);
  powerfox.failure = 'network';
  await tick(t, 60_000);
  powerfox.failure = null;
  await gladys.fake.action('test_connection', {});
  await gladys.fake.configUpdated({ email: ACCOUNT.email, password: 'another-Secret-42' });
  await tick(t, 60_000);
  assert.ok(
    lines.some((line) => line.includes('[DEBUG]')),
    'the debug lines are captured',
  );
  const basic = Buffer.from(`${ACCOUNT.email}:${ACCOUNT.password}`).toString('base64');
  for (const secret of [ACCOUNT.password, 'another-Secret-42', basic, ACCOUNT.email]) {
    assert.ok(
      !lines.some((line) => line.includes(secret)),
      `a log line holds "${secret.slice(0, 3)}…"`,
    );
  }
});

test('without an account, the configuration screen asks for it and nothing is requested', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { config: {} });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.es, /correo electrónico/);
  await tick(t, 120_000);
  assert.equal(powerfox.calls.length, 0);
  const ack = await gladys.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /e-mail and the password/);
});

test('after a Gladys reconnection, the devices and the states are sent again', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [IDS.prosumer] });
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(currentReads(powerfox, IDS.prosumer), 2);
  assert.equal(gladys.fake.discoveredDevices.length, 7);
});

test('the device list is read again every 6 hours: a new reader shows up', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, { created: [] });
  powerfox.devices = [
    ...powerfox.devices,
    { DeviceId: 'a0b1c2d3e4fe', Name: 'Garage', Division: 0, Prosumer: false },
  ];
  await tick(t, 3 * 3600_000);
  assert.equal(gladys.fake.discoveredDevices.length, 7);
  for (let elapsed = 0; elapsed < 3 * 3600_000; elapsed += 60_000) {
    await tick(t, 60_000);
  }
  assert.equal(gladys.fake.discoveredDevices.length, 8);
  assert.equal(powerfox.countPath('my/all/devices'), 2);
});

test('the Discovery tab reads the account again', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, {});
  await gladys.fake.scanRequest();
  assert.equal(powerfox.countPath('my/all/devices'), 2);
  assert.ok(
    gladys.fake.discoveredDevices.some((device) => device.external_id === deviceOf(IDS.gas)),
  );
});

test('saving the same refused password again is a new attempt', async (t) => {
  const { gladys, powerfox } = await timedWorld(t, {
    config: { ...ACCOUNT },
    powerfox: { account: { email: ACCOUNT.email, password: 'changed-in-the-app' } },
    created: [IDS.prosumer],
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  // The user fixed the password in the powerfox app, and saves the form as it is.
  powerfox.account = ACCOUNT;
  await gladys.fake.configUpdated({ ...ACCOUNT });
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  assert.equal(gladys.fake.lastState(feature(IDS.prosumer, 'power')), 111);
});

test('powerfox down at start: the device list is asked again once per interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-15T10:00:00Z') });
  captureLogs(t);
  const world = await createWorld({
    timers: true,
    connect: false,
    created: [IDS.prosumer],
  });
  t.after(() => world.app.stop());
  world.powerfox.failure = 'network';
  await world.gladys.connect();
  assert.equal(world.powerfox.countPath('my/all/devices'), 1, 'one attempt at start');
  await tick(t, 60_000);
  assert.equal(world.powerfox.countPath('my/all/devices'), 2);
  world.powerfox.failure = null;
  await tick(t, 60_000);
  assert.equal(world.powerfox.countPath('my/all/devices'), 3);
  assert.equal(world.gladys.fake.discoveredDevices.length, 7);
  assert.equal(world.gladys.fake.lastState(feature(IDS.prosumer, 'power')), 111);
});
