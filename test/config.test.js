import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  hasCredentials,
  meterIntervalMs,
  normalizeConfig,
  pollFrequencyMs,
} from '../src/config.js';

test('the defaults: no account, one minute, French', () => {
  const config = normalizeConfig();
  assert.deepEqual(config, {
    email: '',
    password: '',
    refreshIntervalMs: 60_000,
    language: 'fr',
  });
  assert.equal(hasCredentials(config), false);
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('the e-mail is trimmed, the password taken as typed', () => {
  const config = normalizeConfig({ email: ' jane@example.com ', password: ' pass ' });
  assert.equal(config.email, 'jane@example.com');
  assert.equal(config.password, ' pass ');
  assert.equal(hasCredentials(config), true);
});

test('an unknown interval or language falls back to the defaults', () => {
  const config = normalizeConfig({ refresh_interval: '1', language: 'it' });
  assert.equal(config.refreshIntervalMs, 60_000);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ refresh_interval: 300 }).refreshIntervalMs, 300_000);
});

test('the gas meters are read every 5 minutes at most', () => {
  const config = normalizeConfig({ refresh_interval: '10' });
  assert.equal(meterIntervalMs(config, 'power'), 10_000);
  assert.equal(meterIntervalMs(config, 'gas'), 300_000);
});

test('the poll frequency is a value Gladys accepts, never faster than the pace', () => {
  assert.equal(pollFrequencyMs(10_000), 10_000);
  assert.equal(pollFrequencyMs(20_000), 15_000);
  assert.equal(pollFrequencyMs(120_000), 60_000);
  assert.equal(pollFrequencyMs(500), 1000);
});
