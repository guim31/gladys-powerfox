// -----------------------------------------------------------------------------
// Scene action (manifest `scene_actions`, Gladys 5.1+): `daily_energy`.
//
// Reads the totals of the day of an electricity or gas meter and hands them to
// the next steps of the scene: numbers to test with "Continue only if", and a
// ready-made sentence for a message ("Today: 12.4 kWh used, 3.1 kWh fed in.").
// A scene action does not receive the user's language: the sentence follows
// the `language` of the configuration.
//
// No scene trigger: everything the readers tell is a device state already
// (power, indexes, stale reading), which the core's device triggers cover.
// -----------------------------------------------------------------------------

import { REPORT_MAX_AGE_MS } from './hub.js';

export const SCENE_TEXT = {
  en: {
    power: (used, fedIn) =>
      fedIn === null ? `Today: ${used} kWh used.` : `Today: ${used} kWh used, ${fedIn} kWh fed in.`,
    gas: (volume, cost) =>
      cost === null ? `Today: ${volume} m³ of gas.` : `Today: ${volume} m³ of gas (${cost}).`,
    unknown: 'This meter is not in the powerfox account.',
    noReport: 'Only the electricity and gas meters have a daily report.',
    unavailable: 'The daily report of this meter is not available yet.',
  },
  fr: {
    power: (used, fedIn) =>
      fedIn === null
        ? `Aujourd’hui : ${used} kWh consommés.`
        : `Aujourd’hui : ${used} kWh consommés, ${fedIn} kWh injectés.`,
    gas: (volume, cost) =>
      cost === null
        ? `Aujourd’hui : ${volume} m³ de gaz.`
        : `Aujourd’hui : ${volume} m³ de gaz (${cost}).`,
    unknown: 'Ce compteur n’est pas dans le compte powerfox.',
    noReport: 'Seuls les compteurs d’électricité et de gaz ont un relevé du jour.',
    unavailable: 'Le relevé du jour de ce compteur n’est pas encore disponible.',
  },
  de: {
    power: (used, fedIn) =>
      fedIn === null
        ? `Heute: ${used} kWh bezogen.`
        : `Heute: ${used} kWh bezogen, ${fedIn} kWh eingespeist.`,
    gas: (volume, cost) =>
      cost === null ? `Heute: ${volume} m³ Gas.` : `Heute: ${volume} m³ Gas (${cost}).`,
    unknown: 'Dieser Zähler ist nicht im powerfox-Konto.',
    noReport: 'Nur Strom- und Gaszähler haben einen Tagesbericht.',
    unavailable: 'Der Tagesbericht dieses Zählers ist noch nicht verfügbar.',
  },
  es: {
    power: (used, fedIn) =>
      fedIn === null
        ? `Hoy: ${used} kWh consumidos.`
        : `Hoy: ${used} kWh consumidos, ${fedIn} kWh vertidos.`,
    gas: (volume, cost) =>
      cost === null ? `Hoy: ${volume} m³ de gas.` : `Hoy: ${volume} m³ de gas (${cost}).`,
    unknown: 'Este contador no está en la cuenta powerfox.',
    noReport: 'Solo los contadores de electricidad y de gas tienen un informe diario.',
    unavailable: 'El informe diario de este contador aún no está disponible.',
  },
};

const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

const round = (value, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function formatNumber(value, language) {
  return new Intl.NumberFormat(LOCALES[language] ?? 'en-GB', {
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatEuro(value, language) {
  return new Intl.NumberFormat(LOCALES[language] ?? 'en-GB', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}

/**
 * @param {import('./hub.js').PowerfoxHub} hub
 * @param {{ fields: { device?: string } }} request
 */
export async function dailyEnergy(hub, { fields }) {
  const language = hub.config?.language ?? 'fr';
  const text = SCENE_TEXT[language] ?? SCENE_TEXT.en;
  const meter = hub.findMeter(fields?.device);
  if (!meter) {
    throw new Error(text.unknown);
  }
  if (meter.kind !== 'power' && meter.kind !== 'gas') {
    throw new Error(text.noReport);
  }
  // A scene wants today's figures: a report a minute old at most.
  const report = await hub.today(meter, { maxAgeMs: Math.min(60_000, REPORT_MAX_AGE_MS) });
  if (meter.kind === 'power') {
    const used = round(report?.consumption);
    if (used === null) {
      throw new Error(text.unavailable);
    }
    const fedIn = meter.prosumer ? round(report.feedIn) : null;
    const power = hub.readings.get(meter.id)?.values.power ?? null;
    return {
      consumption_kwh: used,
      ...(fedIn === null ? {} : { feed_in_kwh: fedIn }),
      ...(power === null ? {} : { power_w: power }),
      summary: text.power(
        formatNumber(used, language),
        fedIn === null ? null : formatNumber(fedIn, language),
      ),
    };
  }
  const volume = round(report?.gas?.today);
  if (volume === null) {
    throw new Error(text.unavailable);
  }
  const cost = round(report.gas.costToday);
  return {
    gas_m3: volume,
    ...(cost === null ? {} : { gas_cost: cost }),
    summary: text.gas(
      formatNumber(volume, language),
      cost === null ? null : formatEuro(cost, language),
    ),
  };
}

export const SCENE_ACTIONS = {
  daily_energy: (hub, request) => dailyEnergy(hub, request),
};
