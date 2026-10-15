import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIVISION,
  localDay,
  meterKind,
  parseCurrent,
  parseDevices,
  parseReport,
} from '../src/powerfox/model.js';
import { fixture } from './helpers/fakePowerfox.js';

test('the device list keeps the readers, their type and their Prosumer flag', () => {
  const devices = parseDevices(fixture('all-devices'));
  assert.deepEqual(devices[0], {
    id: 'a0b1c2d3e4f5',
    name: 'Wohnung unten',
    division: DIVISION.POWER,
    kind: 'power',
    prosumer: true,
    main: true,
  });
  // A reader without a name in the powerfox app.
  assert.equal(devices[2].name, null);
  assert.equal(devices[2].kind, 'water');
  assert.equal(devices[3].kind, 'gas');
});

test('every Division maps to a kind of meter, unknown ones to none', () => {
  assert.deepEqual([-1, 0, 1, 2, 3, 4, 5, 6].map(meterKind), [
    null,
    'power',
    'water',
    'water',
    'heat',
    'gas',
    'water',
    null,
  ]);
});

test('the device list drops invalid and duplicate ids', () => {
  const devices = parseDevices([
    { DeviceId: 'ok1', Division: 0 },
    { DeviceId: 'ok1', Division: 0 },
    { DeviceId: '../x', Division: 0 },
    { DeviceId: 42, Division: 0 },
    null,
  ]);
  assert.deepEqual(
    devices.map((device) => device.id),
    ['ok1'],
  );
  assert.deepEqual(parseDevices({}), []);
});

test('an electricity reading: power, consumption and feed-in indexes, timestamp', () => {
  const reading = parseCurrent(fixture('power-meter'), 'power');
  assert.deepEqual(reading, {
    timestamp: new Date(1703069331 * 1000),
    outdated: false,
    values: { power: 111, energy_import: 1111.111, energy_export: 111.111 },
  });
});

test('a total at 0 is no reading; the tariff registers stand in for the consumption', () => {
  const reading = parseCurrent(fixture('power-meter-invalid'), 'power');
  assert.equal(reading.values.energy_import, 1111.111 + 1111.111);
  assert.equal(reading.values.energy_export, null);
  const nothing = parseCurrent({ Watt: 5, A_Plus: 0, Outdated: true }, 'power');
  assert.equal(nothing.values.energy_import, null);
  assert.equal(nothing.outdated, true);
  assert.equal(nothing.timestamp, null);
});

test('water and heat readings', () => {
  assert.deepEqual(parseCurrent(fixture('water-meter'), 'water').values, {
    cold_water: 1111.111,
    warm_water: 0,
  });
  assert.deepEqual(parseCurrent(fixture('heat-meter'), 'heat').values, {
    heat_energy: 66000,
    heat_volume: 4500.1,
  });
});

test('a payload of the wrong shape gives no value, never 0', () => {
  for (const body of [null, [], 'text', { Watt: '111', A_Plus: 'x' }]) {
    const reading = parseCurrent(body, 'power');
    assert.deepEqual(reading.values, { power: null, energy_import: null, energy_export: null });
  }
});

test('the daily reports: electricity in kWh, gas in m³ with its cost', () => {
  assert.deepEqual(parseReport(fixture('power-report')), {
    consumption: 0.12,
    feedIn: 0,
    gas: null,
  });
  assert.deepEqual(parseReport(fixture('gas-report')), {
    consumption: null,
    feedIn: null,
    gas: { today: 11.32, todayKwh: 113.2, thisHour: 0.12, costToday: 17.1412903225806 },
  });
  assert.deepEqual(parseReport({}), { consumption: null, feedIn: null, gas: null });
});

test('the report day is the local calendar day', () => {
  assert.deepEqual(localDay(new Date(2026, 0, 31, 23, 59)), { year: 2026, month: 1, day: 31 });
});
