import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACCOUNT, IDS } from './helpers/fakePowerfox.js';
import { SELECTOR, createWorld } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const declaredOutputs = new Set(
  manifest.scene_actions
    .find((action) => action.key === 'daily_energy')
    .outputs.map((output) => output.key),
);
const deviceOf = (id) => `ext:${SELECTOR}:poweropti:${id}`;

async function run(gladys, id) {
  return gladys.fake.sceneAction('daily_energy', { device: deviceOf(id) });
}

test('electricity: the totals of the day, the power and a sentence for a message', async (t) => {
  const { gladys, app } = await createWorld({ created: [IDS.prosumer] });
  t.after(() => app.stop());
  const ack = await run(gladys, IDS.prosumer);
  assert.deepEqual(ack, {
    success: true,
    data: {
      outputs: {
        consumption_kwh: 0.12,
        feed_in_kwh: 0,
        power_w: 111,
        summary: 'Aujourd’hui : 0,12 kWh consommés, 0 kWh injectés.',
      },
    },
  });
  for (const key of Object.keys(ack.data.outputs)) {
    assert.ok(declaredOutputs.has(key), `output "${key}" is not declared in the manifest`);
  }
});

test('gas: the volume of the day and its cost, in the configured language', async (t) => {
  const { gladys, app } = await createWorld({
    config: { ...ACCOUNT, language: 'de' },
    created: [IDS.gas],
  });
  t.after(() => app.stop());
  const ack = await run(gladys, IDS.gas);
  // Intl puts a no-break space before the euro sign.
  const summary = ack.data.outputs.summary.replace(/[\u00a0\u202f]/g, ' ');
  assert.deepEqual(
    { ...ack.data.outputs, summary },
    { gas_m3: 11.32, gas_cost: 17.14, summary: 'Heute: 11,32 m³ Gas (17,14 €).' },
  );
});

test('a water or heat meter, or an unknown one, fails the action with a clear message', async (t) => {
  const { gladys, app } = await createWorld({
    config: { ...ACCOUNT, language: 'en' },
    created: [IDS.coldWater],
  });
  t.after(() => app.stop());
  const water = await run(gladys, IDS.coldWater);
  assert.equal(water.success, false);
  assert.match(water.error, /Only the electricity and gas meters/);
  const unknown = await run(gladys, 'ffffffffffff');
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /not in the powerfox account/);
});

test('the report cannot be read: the action fails instead of giving zeros', async (t) => {
  const { gladys, powerfox, app } = await createWorld({ created: [IDS.consumer] });
  t.after(() => app.stop());
  powerfox.failure = 'network';
  const ack = await run(gladys, IDS.consumer);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore disponible/);
});
