// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered, in seconds (a select: Gladys renders number
// fields without `step`). One request per reader and per interval.
export const REFRESH_INTERVALS = ['10', '15', '30', '60', '120', '300'];

// The gas meters are read through the daily report, built from hourly
// values: no need to ask more than every 5 minutes.
export const GAS_MIN_INTERVAL_MS = 300_000;

export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  refresh_interval: '60',
  language: 'fr',
};

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const email = typeof source.email === 'string' ? source.email.trim() : '';
  // A password is taken as typed: spaces may be part of it.
  const password = typeof source.password === 'string' ? source.password : '';
  const interval = REFRESH_INTERVALS.includes(String(source.refresh_interval))
    ? String(source.refresh_interval)
    : DEFAULT_CONFIG.refresh_interval;
  return {
    email,
    password,
    refreshIntervalMs: Number(interval) * 1000,
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

export const hasCredentials = (config) => config.email !== '' && config.password !== '';

/** The pace of one reader: the configured interval, 5 minutes at least for gas. */
export function meterIntervalMs(config, kind) {
  return kind === 'gas'
    ? Math.max(config.refreshIntervalMs, GAS_MIN_INTERVAL_MS)
    : config.refreshIntervalMs;
}

/**
 * The poll_frequency published for a reader: the slowest frequency Gladys
 * knows that is not slower than the reader's pace (the core caps at 1 min).
 * Only the core's fallback polling uses it: the container polls by itself.
 */
export function pollFrequencyMs(intervalMs) {
  const allowed = Object.values(DEVICE_POLL_FREQUENCIES).sort((a, b) => a - b);
  return allowed.filter((frequency) => frequency <= intervalMs).at(-1) ?? allowed[0];
}
