// -----------------------------------------------------------------------------
// The powerfox account seen from Gladys: discovery of the readers, the
// container's own polling timer, the rate-limit backoff and the connection
// status of the Configuration screen.
//
// Polling. The devices are published with `should_poll: true` and a valid
// `poll_frequency`, but the core cannot be trusted to call onPoll: Gladys
// 5.2.x skips devices created without `should_poll`, and a device keeps the
// polling fields it was created with (GladysAssistant/Gladys#3198). So the
// container reads the API by itself, at the configured pace, and the core's
// onPoll is a fallback that skips a reader read less than 90 % of a period
// ago. Only the readers the user added to Gladys (`gladys.devices`) are read:
// the core drops the states of a device it does not know.
//
// Quotas. One request per reader and per period (gas: every 5 minutes at
// most), the device list every 6 hours. A 429 pauses every request, for the
// Retry-After the API gives or an exponential backoff (up to 30 minutes). A
// 401 stops everything until the configuration changes: retrying a wrong
// password could lock the account.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasCredentials, meterIntervalMs } from './config.js';
import { INDEX_KEYS, buildDevice, deviceIds, gasReading, readingStates } from './devices.js';
import { IssueLog } from './issues.js';
import {
  PowerfoxAuthError,
  PowerfoxClient,
  PowerfoxPrivacyError,
  PowerfoxRateLimitError,
} from './powerfox/client.js';
import { localDay, parseCurrent, parseDevices, parseReport } from './powerfox/model.js';

const logger = createLogger({ name: 'powerfox' });

export const WIDGET_KEY = 'energy_today';

// An unchanged value is published again every 6 hours: the Gladys front
// shows "no recent value" past 48 hours, and a scene reads a recent state.
export const STATE_HEARTBEAT_MS = 6 * 3600_000;
export const DISCOVERY_PERIOD_MS = 6 * 3600_000;
const MAX_BACKOFF_MS = 30 * 60_000;
// The daily report behind the widget and the scene action: built from
// hourly values, read at most every 5 minutes per reader.
export const REPORT_MAX_AGE_MS = 5 * 60_000;
// An index reading lower than the last one is a glitch, unless it lasts
// (a replaced meter): accepted after that many readings in a row.
const INDEX_DROP_TOLERANCE = 10;

export const CONNECTION_TEXT = {
  missing: {
    en: 'Enter the e-mail and the password of your powerfox account.',
    fr: 'Saisissez l’e-mail et le mot de passe de votre compte powerfox.',
    de: 'Gib die E-Mail-Adresse und das Passwort deines powerfox-Kontos ein.',
    es: 'Introduzca el correo electrónico y la contraseña de su cuenta powerfox.',
  },
  auth: {
    en: 'powerfox refused the e-mail or the password: check them, then save.',
    fr: 'powerfox refuse l’e-mail ou le mot de passe : vérifiez-les, puis enregistrez.',
    de: 'powerfox lehnt die E-Mail-Adresse oder das Passwort ab: Prüfe sie und speichere erneut.',
    es: 'powerfox rechaza el correo electrónico o la contraseña: compruébelos y guarde de nuevo.',
  },
  unreachable: {
    en: 'The powerfox cloud does not answer: new attempt at the next refresh.',
    fr: 'Le cloud powerfox ne répond pas : nouvel essai au prochain rafraîchissement.',
    de: 'Die powerfox-Cloud antwortet nicht: neuer Versuch bei der nächsten Aktualisierung.',
    es: 'La nube de powerfox no responde: nuevo intento en la próxima actualización.',
  },
  rateLimited: {
    en: 'powerfox asks to slow down: readings paused for a while, choose a longer interval.',
    fr: 'powerfox demande de ralentir : relevés suspendus un moment, choisissez un intervalle plus long.',
    de: 'powerfox bittet um weniger Anfragen: Abfragen pausiert, wähle ein längeres Intervall.',
    es: 'powerfox pide reducir el ritmo: lecturas en pausa, elija un intervalo más largo.',
  },
};

export class PowerfoxHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {typeof fetch} [options.fetch] test seam
   * @param {boolean} [options.timers] run the periodic timer (tests may turn it off)
   * @param {() => number} [options.now]
   */
  constructor({ gladys, fetch, timers = true, now = () => Date.now() }) {
    this.gladys = gladys;
    this.fetch = fetch;
    this.timers = timers;
    this.now = now;
    this.issues = new IssueLog(logger);
    this.config = null;
    this.client = null;
    /** @type {Map<string, object>} the supported readers, by powerfox id */
    this.meters = new Map();
    this.discoveredAt = null;
    this.discoveryAttemptAt = null;
    this.authFailed = false;
    this.pausedUntil = 0;
    this.backoffStep = 0;
    this.timer = null;
    this.stopped = false;
    this.cycling = null;
    this.status = null;
    this.lastPolledAt = new Map();
    this.inFlight = new Map();
    /** Last reading of each reader (electricity, water, heat). */
    this.readings = new Map();
    /** Daily reports: { at, report } by reader id, and the requests in progress. */
    this.reports = new Map();
    this.reportRequests = new Map();
    this.lastIndex = new Map();
    this.indexDrops = new Map();
    this.unsupported = new Set();
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** (Re)start with a configuration: discovery, then the first readings. */
  async start(config) {
    this.stopTimer();
    this.stopped = false;
    this.config = config;
    this.authFailed = false;
    this.pausedUntil = 0;
    this.backoffStep = 0;
    this.issues.clear();
    this.lastPolledAt.clear();
    this.reports.clear();
    if (!hasCredentials(config)) {
      this.client = null;
      logger.info('No powerfox account configured yet');
      await this.setStatus(false, 'missing');
      return;
    }
    this.client = new PowerfoxClient({
      email: config.email,
      password: config.password,
      fetch: this.fetch,
      userAgent: 'gladys-powerfox (+https://github.com/guim31/gladys-powerfox)',
    });
    await this.discover();
    await this.cycle({ force: true });
    this.schedule();
  }

  /** A new configuration from the user. */
  async reconfigure(config) {
    const previous = this.config;
    const sameAccount =
      previous &&
      previous.email === config.email &&
      previous.password === config.password &&
      this.client !== null &&
      // Saving the form again after a refused password is a new attempt.
      !this.authFailed;
    if (!sameAccount) {
      logger.info('New powerfox configuration: reconnecting to the account');
      await this.start(config);
      return;
    }
    this.config = config;
    // Names (language) and poll frequency of the devices not created yet.
    await this.publishDevices();
    this.schedule();
  }

  /** Gladys came back (WebSocket reconnected): re-send what it may have lost. */
  async resync() {
    if (!this.client || this.authFailed) {
      return;
    }
    await this.publishDevices();
    await this.cycle({ force: true });
    this.schedule();
  }

  /** The Discovery tab asks for the devices: read the account again. */
  async rediscover() {
    if (!this.client) {
      await this.gladys.publishDiscoveredDevices([]);
      return;
    }
    await this.discover();
  }

  stop() {
    this.stopped = true;
    this.stopTimer();
  }

  stopTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    this.stopTimer();
    if (!this.timers || this.stopped || !this.client || this.authFailed) {
      return;
    }
    const paused = this.pausedUntil - this.now();
    const delay = Math.max(1000, paused > 0 ? paused : this.config.refreshIntervalMs);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.cycle();
      } catch (err) {
        logger.error(`Refresh cycle failed (${err.message})`);
      } finally {
        this.schedule();
      }
    }, delay);
  }

  // --- Discovery -----------------------------------------------------------------

  async discover() {
    if (!this.client || this.authFailed || this.isPaused()) {
      return false;
    }
    let devices;
    this.discoveryAttemptAt = this.now();
    try {
      devices = parseDevices(await this.client.allDevices());
    } catch (err) {
      await this.handleError(err);
      return false;
    }
    await this.apiWorks();
    this.discoveredAt = this.now();
    const meters = new Map();
    for (const device of devices) {
      if (device.kind === null) {
        if (!this.unsupported.has(device.id)) {
          this.unsupported.add(device.id);
          logger.info(`Reader ${device.id} of type ${device.division} is not supported, ignored`);
        }
        continue;
      }
      meters.set(device.id, device);
    }
    const before = [...this.meters.keys()].sort().join(',');
    this.meters = meters;
    if (before !== [...meters.keys()].sort().join(',')) {
      logger.info(`powerfox account: ${meters.size} reader(s) found`);
    }
    await this.publishDevices();
    return true;
  }

  async publishDevices() {
    if (!this.config) {
      return;
    }
    const devices = [...this.meters.values()].map((meter) =>
      buildDevice(this.gladys, meter, this.config),
    );
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.issues.recover('gladys-discovery', 'Gladys accepts the discovered devices again');
    } catch (err) {
      this.issues.fail(
        'gladys-discovery',
        `Gladys refused the discovered devices (${err.message})`,
      );
    }
  }

  // --- Polling -------------------------------------------------------------------

  isPaused() {
    return this.pausedUntil > this.now();
  }

  /** The readers whose device the user added to Gladys. */
  createdMeters() {
    const created = new Set((this.gladys.devices ?? []).map((device) => device.external_id));
    return [...this.meters.values()].filter((meter) =>
      created.has(deviceIds(this.gladys, meter).device),
    );
  }

  findMeter(externalId) {
    return [...this.meters.values()].find(
      (meter) => deviceIds(this.gladys, meter).device === externalId,
    );
  }

  /** One cycle: the device list when due, then every added reader, one after the other. */
  async cycle({ force = false } = {}) {
    if (this.cycling) {
      return this.cycling;
    }
    this.cycling = (async () => {
      if (!this.client || this.authFailed || this.gladys.connected === false) {
        return;
      }
      if (this.isPaused()) {
        logger.debug('powerfox rate limit: refresh skipped');
        return;
      }
      const sinceAttempt = this.now() - (this.discoveryAttemptAt ?? -Infinity);
      const due =
        this.discoveredAt === null
          ? // Never listed yet (powerfox down at start): once per interval.
            sinceAttempt >= this.config.refreshIntervalMs / 2
          : this.now() - this.discoveredAt >= DISCOVERY_PERIOD_MS;
      if (due) {
        await this.discover();
      }
      for (const meter of this.createdMeters()) {
        if (this.authFailed || this.isPaused()) {
          break;
        }
        await this.pollMeter(meter, { force }).catch(() => {});
      }
    })();
    try {
      await this.cycling;
    } finally {
      this.cycling = null;
    }
  }

  /**
   * Read one reader, unless it is not due yet. `source: 'timer'`: due once
   * its period has elapsed, give or take half a timer tick (a gas meter is
   * read every 5 minutes while the timer ticks every interval); `'core'`:
   * the fallback, due 90 % of a period after the last read.
   * Never throws: the errors are logged once while they last.
   */
  async pollMeter(meter, { force = false, source = 'timer' } = {}) {
    const running = this.inFlight.get(meter.id);
    if (running) {
      return running;
    }
    if (!this.client || this.authFailed || this.isPaused()) {
      return undefined;
    }
    const period = meterIntervalMs(this.config, meter.kind);
    const last = this.lastPolledAt.get(meter.id);
    const early = source === 'core' ? period * 0.1 : this.config.refreshIntervalMs / 2;
    if (!force && last !== undefined && this.now() - last < period - early) {
      logger.debug(`${meter.id}: read ${this.now() - last} ms ago, skipped`);
      return undefined;
    }
    this.lastPolledAt.set(meter.id, this.now());
    const run = this.readMeter(meter);
    this.inFlight.set(meter.id, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(meter.id);
    }
  }

  async readMeter(meter) {
    let states;
    let outdated = false;
    try {
      if (meter.kind === 'gas') {
        const report = await this.fetchReport(meter);
        states = readingStates(meter, gasReading(report));
      } else {
        const reading = parseCurrent(await this.client.current(meter.id), meter.kind);
        this.readings.set(meter.id, reading);
        outdated = reading.outdated;
        states = readingStates(meter, reading);
      }
    } catch (err) {
      await this.handleError(err, meter);
      return;
    }
    await this.apiWorks(meter);
    logger.debug(`${meter.id}: ${states.map(({ key, value }) => `${key}=${value}`).join(' ')}`);
    await this.publish(meter, states, outdated);
  }

  /** The daily report of a reader, from the cache when recent enough. */
  async today(meter, { maxAgeMs = REPORT_MAX_AGE_MS } = {}) {
    const cached = this.reports.get(meter.id);
    if (cached && this.now() - cached.at < maxAgeMs) {
      return cached.report;
    }
    if (!this.client || this.authFailed || this.isPaused()) {
      return cached?.report ?? null;
    }
    try {
      const report = await this.fetchReport(meter);
      await this.apiWorks(meter);
      return report;
    } catch (err) {
      await this.handleError(err, meter);
      return cached?.report ?? null;
    }
  }

  async fetchReport(meter) {
    let request = this.reportRequests.get(meter.id);
    if (!request) {
      request = (async () => {
        const report = parseReport(
          await this.client.report(meter.id, localDay(new Date(this.now()))),
        );
        this.reports.set(meter.id, { at: this.now(), report });
        return report;
      })();
      this.reportRequests.set(meter.id, request);
      request.then(
        () => this.reportRequests.delete(meter.id),
        () => this.reportRequests.delete(meter.id),
      );
    }
    return request;
  }

  /** Publish the changed states; a stale reading does not refresh its old values. */
  async publish(meter, states, outdated) {
    const ids = deviceIds(this.gladys, meter);
    const entries = [];
    for (const { key, value } of states) {
      const id = ids.feature(key);
      if (INDEX_KEYS.has(key) && !this.acceptIndex(id, value)) {
        continue;
      }
      entries.push({ device_feature_external_id: id, state: value });
    }
    const flagId = ids.feature('outdated');
    const flag = entries.filter((entry) => entry.device_feature_external_id === flagId);
    const measures = entries.filter((entry) => entry.device_feature_external_id !== flagId);
    try {
      if (outdated) {
        // The values are the old ones: no heartbeat, Gladys keeps their date.
        await this.gladys.publishChangedStates(measures);
        await this.gladys.publishChangedStates(flag, { heartbeat: STATE_HEARTBEAT_MS });
      } else {
        await this.gladys.publishChangedStates(entries, { heartbeat: STATE_HEARTBEAT_MS });
      }
      this.issues.recover('gladys-states', 'Gladys accepts the states again');
    } catch (err) {
      this.issues.fail('gladys-states', `Gladys refused the states (${err.message})`);
    }
  }

  acceptIndex(id, value) {
    const last = this.lastIndex.get(id);
    if (last !== undefined && value < last) {
      const drops = (this.indexDrops.get(id) ?? 0) + 1;
      this.indexDrops.set(id, drops);
      if (drops < INDEX_DROP_TOLERANCE) {
        logger.debug(`${id}: index ${value} lower than ${last}, ignored`);
        return false;
      }
      logger.info(`${id}: the index went down from ${last} to ${value} and stays there, accepted`);
    }
    this.indexDrops.delete(id);
    this.lastIndex.set(id, value);
    return true;
  }

  /** The core's onPoll (fallback): reads the reader unless the timer just did. */
  async pollFromCore(device) {
    const meter = this.findMeter(device.external_id);
    if (!meter) {
      logger.debug(`onPoll ignored for ${device.external_id}`);
      return;
    }
    await this.pollMeter(meter, { source: 'core' });
  }

  /** A device was just added (or updated): send its states now, then nudge the widget. */
  async onDeviceCreated(device) {
    const meter = this.findMeter(device.external_id);
    if (meter) {
      await this.pollMeter(meter, { force: true });
    }
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Errors and connection status --------------------------------------------

  async handleError(err, meter) {
    if (err instanceof PowerfoxAuthError) {
      this.authFailed = true;
      this.stopTimer();
      this.issues.fail(
        'auth',
        'powerfox refused the e-mail or the password: no more requests until the configuration changes',
        'error',
      );
      await this.setStatus(false, 'auth');
      return;
    }
    if (err instanceof PowerfoxRateLimitError) {
      const interval = this.config.refreshIntervalMs;
      const backoff = Math.min(interval * 2 ** (this.backoffStep + 1), MAX_BACKOFF_MS);
      const delay = Math.max(err.retryAfterMs ?? backoff, interval);
      this.backoffStep += 1;
      this.pausedUntil = this.now() + delay;
      this.issues.fail(
        'rate',
        `powerfox asks to slow down (HTTP 429): requests paused for ${Math.round(delay / 1000)} s`,
      );
      await this.setStatus(false, 'rateLimited');
      this.schedule();
      return;
    }
    if (err instanceof PowerfoxPrivacyError && meter) {
      this.issues.fail(
        `privacy:${meter.id}`,
        `Reader ${meter.id}: the data transfer is denied in the powerfox app`,
      );
      return;
    }
    if (meter && err.status !== undefined && err.status < 500) {
      // A reader the API answers about with an error, the others work.
      this.issues.fail(`meter:${meter.id}`, `Reader ${meter.id}: ${err.message}`);
      return;
    }
    this.issues.fail('api', `${err.message}: new attempt at the next refresh`);
    await this.setStatus(false, 'unreachable');
  }

  async apiWorks(meter) {
    this.backoffStep = 0;
    this.issues.recover('auth', 'powerfox accepts the e-mail and the password again');
    this.issues.recover('rate', 'powerfox accepts requests again');
    this.issues.recover('api', 'powerfox reachable again');
    if (meter) {
      this.issues.recover(`privacy:${meter.id}`, `Reader ${meter.id}: data available again`);
      this.issues.recover(`meter:${meter.id}`, `Reader ${meter.id}: readings work again`);
    }
    await this.setStatus(true);
  }

  async setStatus(connected, reason) {
    const key = connected ? 'ok' : reason;
    if (this.status === key) {
      return;
    }
    this.status = key;
    try {
      if (connected) {
        await this.gladys.setConnectionStatus(true);
      } else {
        await this.gladys.setConnectionStatus(false, CONNECTION_TEXT[reason]);
      }
    } catch (err) {
      // Gladys unreachable: sent again on the next change of status.
      this.status = null;
      logger.debug(`Connection status not sent (${err.message})`);
    }
  }

  // --- Configuration-screen action -----------------------------------------------

  /** "Test the connection": reads the device list now, whatever the pace. */
  async testConnection() {
    if (!this.client) {
      return { ok: false, reason: 'missing' };
    }
    if (this.isPaused()) {
      return { ok: false, reason: 'rateLimited' };
    }
    // A user asking again after fixing the password in the powerfox app.
    this.authFailed = false;
    const found = await this.discover();
    if (!found) {
      return { ok: false, reason: this.authFailed ? 'auth' : this.status };
    }
    this.schedule();
    return { ok: true, meters: [...this.meters.values()] };
  }
}
