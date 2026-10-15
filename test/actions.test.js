import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT } from './helpers/fakePowerfox.js';
import { captureLogs, createWorld } from './helpers/world.js';

test('"Test the connection" lists the readers, in four languages, one info line', async (t) => {
  const lines = captureLogs(t);
  const { gladys, powerfox, app } = await createWorld({});
  t.after(() => app.stop());
  const before = lines.length;
  const calls = powerfox.calls.length;
  const ack = await gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  const { message } = ack.data;
  assert.deepEqual(Object.keys(message), ['en', 'fr', 'de', 'es']);
  assert.match(
    message.fr,
    /^Connecté à powerfox : 7 lecteur\(s\), Wohnung unten \(compteur électrique\)/,
  );
  assert.match(message.de, /Wohnung unten \(Stromzähler\)/, 'German nouns keep their capital');
  assert.match(message.en, /…\.$/, 'four readers named at most');
  for (const text of Object.values(message)) {
    assert.ok(text.length <= 200, `${text.length} characters`);
  }
  assert.equal(powerfox.calls.length, calls + 1, 'the device list only');
  assert.deepEqual(lines.slice(before).filter((line) => line.includes('[INFO]')).length, 1);
});

test('"Test the connection" with a wrong password says so', async (t) => {
  const { gladys, app } = await createWorld({
    config: { email: ACCOUNT.email, password: 'nope' },
  });
  t.after(() => app.stop());
  const ack = await gladys.fake.action('test_connection', {});
  assert.match(ack.data.message.en, /refused the e-mail or the password/);
  assert.match(ack.data.message.es, /contraseña/);
});

test('an account without any supported reader', async (t) => {
  const { gladys, app } = await createWorld({ powerfox: { devices: [] } });
  t.after(() => app.stop());
  const ack = await gladys.fake.action('test_connection', {});
  assert.match(ack.data.message.fr, /aucun lecteur/);
});
