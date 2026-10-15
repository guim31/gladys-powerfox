import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { buildDevice } from '../src/devices.js';
import { formatTime } from '../src/widgets.js';
import { IDS, fixture } from './helpers/fakePowerfox.js';
import { SELECTOR, createWorld } from './helpers/world.js';

const deviceOf = (id) => `ext:${SELECTOR}:poweropti:${id}`;

async function content(gladys, id, language = 'fr') {
  const ack = await gladys.fake.widgetGet('energy_today', {
    settings: id === undefined ? {} : { device: deviceOf(id) },
    language,
  });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
}

/** Every feature a widget tile is bound to exists on the device (the core does not check it). */
function assertBoundFeaturesExist(hub, id, widget) {
  const device = buildDevice(hub.gladys, hub.meters.get(id), hub.config);
  const features = new Set(device.features.map((feature) => feature.external_id));
  for (const component of widget.components) {
    if (component.device_feature) {
      assert.ok(features.has(component.device_feature), `${component.device_feature} is unknown`);
    }
  }
}

test('electricity: live power, the energy of the day and the last reading', async (t) => {
  const { gladys, hub, app } = await createWorld({ created: [IDS.prosumer] });
  t.after(() => app.stop());
  const widget = await content(gladys, IDS.prosumer, 'en');
  assert.deepEqual(validateWidgetContent(widget), []);
  assertBoundFeaturesExist(hub, IDS.prosumer, widget);

  const tiles = widget.components.filter((component) => component.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => tile.label),
    ['Power', 'Used today', 'Fed in today'],
  );
  assert.equal(tiles[0].device_feature, `${deviceOf(IDS.prosumer)}:power`);
  assert.deepEqual([tiles[1].value, tiles[1].unit], [0.12, 'kWh']);
  assert.deepEqual([tiles[2].value, tiles[2].unit], [0, 'kWh']);

  const status = widget.components.find((component) => component.type === 'status');
  assert.equal(status.items[0].label, 'Last reading');
  assert.equal(status.items[1].value, 'Up to date');
  assert.equal(status.items[1].color, 'success');
});

test('the daily report behind the widget is read at most every 5 minutes', async (t) => {
  const { gladys, powerfox, app } = await createWorld({ created: [IDS.prosumer] });
  t.after(() => app.stop());
  await content(gladys, IDS.prosumer);
  await content(gladys, IDS.prosumer, 'de');
  await content(gladys, IDS.prosumer, 'es');
  assert.equal(powerfox.countPath(`my/${IDS.prosumer}/report`), 1);
});

test('a consumption-only meter has no feed-in tile; a stale reading shows as such', async (t) => {
  const stale = { ...fixture('power-meter-full'), Outdated: true };
  const { gladys, app } = await createWorld({
    created: [IDS.consumer],
    powerfox: { current: { [IDS.consumer]: stale } },
  });
  t.after(() => app.stop());
  const widget = await content(gladys, IDS.consumer, 'fr');
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.equal(widget.components.filter((component) => component.type === 'value').length, 2);
  const status = widget.components.find((component) => component.type === 'status');
  assert.deepEqual(
    { value: status.items[1].value, color: status.items[1].color },
    { value: 'Périmée', color: 'warning' },
  );
});

test('gas: the gas of the day, of the hour and its cost', async (t) => {
  const { gladys, app } = await createWorld({ created: [IDS.gas] });
  t.after(() => app.stop());
  const widget = await content(gladys, IDS.gas, 'de');
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.deepEqual(
    widget.components
      .filter((component) => component.type === 'value')
      .map((tile) => [tile.label, tile.value, tile.unit]),
    [
      ['Gas heute', 11.32, 'm³'],
      ['Diese Stunde', 0.12, 'm³'],
      ['Kosten heute', 17.14, '€'],
    ],
  );
});

test('water and heat: the indexes of the device, bound to its features', async (t) => {
  const { gladys, hub, app } = await createWorld({
    created: [IDS.hotWater, IDS.heat, IDS.coldHotWater],
  });
  t.after(() => app.stop());
  for (const id of [IDS.hotWater, IDS.heat, IDS.coldHotWater]) {
    const widget = await content(gladys, id, 'es');
    assert.deepEqual(validateWidgetContent(widget), []);
    assertBoundFeaturesExist(hub, id, widget);
  }
  const hot = await content(gladys, IDS.hotWater, 'en');
  assert.deepEqual(
    hot.components.filter((component) => component.type === 'value').map((tile) => tile.label),
    ['Hot water'],
  );
});

test('no meter chosen, or a meter gone from the account: a short explanation', async (t) => {
  const { gladys, app } = await createWorld({});
  t.after(() => app.stop());
  const empty = await content(gladys, undefined, 'fr');
  assert.match(empty.components[0].text, /Choisissez un compteur/);
  const gone = await content(gladys, 'ffffffffffff', 'en');
  assert.match(gone.components[0].text, /not in the powerfox account/);
});

test('the report cannot be read: the tiles say so instead of failing', async (t) => {
  const { gladys, powerfox, app } = await createWorld({ created: [IDS.prosumer] });
  t.after(() => app.stop());
  powerfox.failure = 'network';
  const widget = await content(gladys, IDS.prosumer, 'en');
  assert.deepEqual(validateWidgetContent(widget), []);
  const tiles = widget.components.filter((component) => component.type === 'value');
  assert.equal(tiles[1].value, '—');
});

test('the time of the last reading, today or another day', () => {
  const now = new Date(2026, 9, 15, 18, 0);
  assert.equal(formatTime(new Date(2026, 9, 15, 14, 32), 'fr', now), '14:32');
  assert.equal(formatTime(new Date(2026, 9, 12, 9, 5), 'de', now), '12.10. 09:05');
});
