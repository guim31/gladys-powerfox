import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import {
  buildDevice,
  deviceName,
  featureSpecs,
  gasReading,
  readingStates,
} from '../src/devices.js';
import { parseCurrent, parseDevices, parseReport } from '../src/powerfox/model.js';
import { ACCOUNT, IDS, fixture } from './helpers/fakePowerfox.js';

const gladys = createFakeGladys();
const meters = Object.fromEntries(
  parseDevices(fixture('all-types')).map((meter) => [meter.id, meter]),
);
const config = normalizeConfig(ACCOUNT);
const keys = (meter) => featureSpecs(meter).map((spec) => spec.key);
const spec = (meter, key) => featureSpecs(meter).find((item) => item.key === key);

test('the external ids are built from the powerfox DeviceId, never from a name', () => {
  const device = buildDevice(gladys, meters[IDS.prosumer], config);
  assert.equal(device.external_id, `ext:test-integration:poweropti:${IDS.prosumer}`);
  assert.equal(device.features[0].external_id, `${device.external_id}:power`);
  // Renaming the reader in the powerfox app changes nothing.
  const renamed = buildDevice(gladys, { ...meters[IDS.prosumer], name: 'Keller' }, config);
  assert.deepEqual(
    renamed.features.map((feature) => feature.external_id),
    device.features.map((feature) => feature.external_id),
  );
});

test('a bidirectional electricity meter: signed grid power, consumption and feed-in indexes', () => {
  const meter = meters[IDS.prosumer];
  assert.deepEqual(keys(meter), ['power', 'energy_import', 'energy_export', 'outdated']);
  assert.deepEqual(
    { ...spec(meter, 'power') },
    {
      key: 'power',
      category: 'grid-sensor',
      type: 'power',
      unit: 'watt',
      min: -20000,
      max: 20000,
    },
  );
  // The core derives the energy tracking (30-minute consumption, cost) from
  // an energy-sensor index, the production tracking from a production index.
  assert.equal(spec(meter, 'energy_import').category, 'energy-sensor');
  assert.equal(spec(meter, 'energy_import').type, 'index');
  assert.equal(spec(meter, 'energy_import').unit, 'kilowatt-hour');
  assert.equal(spec(meter, 'energy_export').category, 'energy-production-sensor');
  assert.equal(spec(meter, 'energy_export').type, 'index');
});

test('a consumption-only electricity meter: positive power, no feed-in index', () => {
  const meter = meters[IDS.consumer];
  assert.deepEqual(keys(meter), ['power', 'energy_import', 'outdated']);
  assert.equal(spec(meter, 'power').category, 'energy-sensor');
  assert.equal(spec(meter, 'power').min, 0);
});

test('water meters have the indexes of their type', () => {
  assert.deepEqual(keys(meters[IDS.coldWater]), ['cold_water', 'outdated']);
  assert.deepEqual(keys(meters[IDS.hotWater]), ['warm_water', 'outdated']);
  assert.deepEqual(keys(meters[IDS.coldHotWater]), ['cold_water', 'warm_water', 'outdated']);
  assert.equal(spec(meters[IDS.coldWater], 'cold_water').unit, 'cubicmeter');
});

test('the heat energy is a counter: Gladys must not count it as electricity', () => {
  const meter = meters[IDS.heat];
  assert.deepEqual(keys(meter), ['heat_energy', 'heat_volume', 'outdated']);
  assert.notEqual(spec(meter, 'heat_energy').category, 'energy-sensor');
  assert.equal(spec(meter, 'heat_energy').category, 'counter-sensor');
  assert.equal(spec(meter, 'heat_energy').unit, 'kilowatt-hour');
});

test('a gas meter publishes the daily report: today, this hour, cost', () => {
  const meter = meters[IDS.gas];
  assert.deepEqual(keys(meter), ['gas_today', 'gas_this_hour', 'gas_cost_today']);
  const states = readingStates(meter, gasReading(parseReport(fixture('gas-report'))));
  assert.deepEqual(states, [
    { key: 'gas_today', value: 11.32 },
    { key: 'gas_this_hour', value: 0.12 },
    { key: 'gas_cost_today', value: 17.14 },
  ]);
});

test('the states of a reading: only the features of the device, the stale flag as 0/1', () => {
  const states = readingStates(meters[IDS.consumer], parseCurrent(fixture('power-meter'), 'power'));
  assert.deepEqual(states, [
    { key: 'power', value: 111 },
    { key: 'energy_import', value: 1111.111 },
    { key: 'outdated', value: 0 },
  ]);
  const stale = readingStates(meters[IDS.coldWater], {
    outdated: true,
    values: { cold_water: null },
  });
  assert.deepEqual(stale, [{ key: 'outdated', value: 1 }]);
});

test('the structure depends on the reader type only, never on a reading', () => {
  // A prosumer meter whose feed-in total is still 0 keeps its feed-in index.
  assert.deepEqual(keys(meters[IDS.prosumer]), [
    'power',
    'energy_import',
    'energy_export',
    'outdated',
  ]);
  const states = readingStates(
    meters[IDS.prosumer],
    parseCurrent(fixture('power-meter-invalid'), 'power'),
  );
  assert.ok(!states.some((state) => state.key === 'energy_export'), 'a 0 total is not published');
});

test('the device names: the powerfox name, or the meter type and the end of the id', () => {
  assert.equal(deviceName(meters[IDS.prosumer], 'fr'), 'Wohnung unten');
  assert.equal(deviceName(meters[IDS.consumer], 'fr'), 'Compteur électrique e4f9');
  assert.equal(deviceName(meters[IDS.coldWater], 'de'), 'Wasserzähler e4f7');
});

test('the polling fields follow the refresh interval, gas every 5 minutes at most', () => {
  const at = (interval, id) =>
    buildDevice(gladys, meters[id], normalizeConfig({ ...ACCOUNT, refresh_interval: interval }))
      .poll_frequency;
  assert.equal(at('10', IDS.prosumer), 10_000);
  assert.equal(at('15', IDS.prosumer), 15_000);
  assert.equal(at('30', IDS.prosumer), 30_000);
  assert.equal(at('60', IDS.prosumer), 60_000);
  assert.equal(at('300', IDS.prosumer), 60_000);
  assert.equal(at('10', IDS.gas), 60_000);
});
