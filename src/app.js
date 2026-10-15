// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake
// Gladys) and returns the hub, so index.js stays a few lines and the tests
// drive the very same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { KIND_NAMES, deviceName } from './devices.js';
import { CONNECTION_TEXT, PowerfoxHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { WIDGETS } from './widgets.js';

const logger = createLogger({ name: 'powerfox-app' });

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// The report shown under the "Test the connection" button.
export const TEST_TEXT = {
  en: {
    none: 'Connected to powerfox, but the account has no supported reader.',
    found: (count, list) => `Connected to powerfox: ${count} reader(s), ${list}.`,
  },
  fr: {
    none: 'Connecté à powerfox, mais le compte n’a aucun lecteur pris en charge.',
    found: (count, list) => `Connecté à powerfox : ${count} lecteur(s), ${list}.`,
  },
  de: {
    none: 'Mit powerfox verbunden, aber das Konto hat keinen unterstützten Zähler.',
    found: (count, list) => `Mit powerfox verbunden: ${count} Zähler, ${list}.`,
  },
  es: {
    none: 'Conectado a powerfox, pero la cuenta no tiene ningún lector compatible.',
    found: (count, list) => `Conectado a powerfox: ${count} lector(es), ${list}.`,
  },
};

/** The multi-language message of the "Test the connection" action. */
export function testMessage(result) {
  return Object.fromEntries(
    Object.keys(TEST_TEXT).map((language) => {
      if (!result.ok) {
        const reason = CONNECTION_TEXT[result.reason] ?? CONNECTION_TEXT.unreachable;
        return [language, reason[language]];
      }
      const text = TEST_TEXT[language];
      if (result.meters.length === 0) {
        return [language, text.none];
      }
      // The message is shown under the button: four readers named at most.
      const named = result.meters.slice(0, 4).map((meter) => {
        const kind = KIND_NAMES[language][meter.kind];
        // German nouns keep their capital letter.
        const inSentence = language === 'de' ? kind : kind.toLowerCase();
        const name = deviceName(meter, language);
        return name.startsWith(kind) ? name : `${name} (${inSentence})`;
      });
      if (result.meters.length > 4) {
        named.push('…');
      }
      const list = named.join(', ');
      return [language, text.found(result.meters.length, list)];
    }),
  );
}

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: fetch, timers, now
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new PowerfoxHub({
    gladys,
    fetch: options.fetch,
    timers: options.timers ?? true,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // request arriving during the first discovery is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): re-send what Gladys may have lost.
        await hub.resync();
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  // The devices are read by the container's own timer; this only serves a
  // Gladys that polls them anyway (and stays the fallback if the timer stalls).
  gladys.onPoll(whenReady((device) => hub.pollFromCore(device)));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));
  gladys.onDeviceUpdated(whenReady((device) => hub.onDeviceCreated(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'test_connection',
    whenReady(async () => {
      const result = await hub.testConnection();
      logger.info(
        result.ok
          ? `Connection test: ${result.meters.length} reader(s)`
          : `Connection test failed (${result.reason})`,
      );
      return testMessage(result);
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  for (const [key, widget] of Object.entries(WIDGETS)) {
    gladys.onWidgetGet(
      key,
      whenReady((request) => widget.get(hub, request)),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
