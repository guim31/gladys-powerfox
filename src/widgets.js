// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `energy_today`.
//
// What the device box cannot show: the energy of the day. An electricity
// meter shows its live power (a tile bound to the feature, it follows the
// published states), the consumption and the feed-in of the day (the powerfox
// daily report), and when the last reading was taken. A gas meter shows the
// gas of the day, of the hour and its cost; a water or heat meter its indexes.
//
// Budget (8 components, 2 texts, 1 status, 6 tiles): up to three tiles, one
// status list, one caption when there is nothing to show. No button: the
// integration is read only.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { NAMES, deviceIds, deviceName, featureSpecs } from './devices.js';
import { WIDGET_KEY } from './hub.js';

export const TEXT = {
  pick: {
    en: 'Choose a powerfox meter in the settings of this widget.',
    fr: 'Choisissez un compteur powerfox dans les réglages de ce widget.',
    de: 'Wähle in den Einstellungen dieses Widgets einen powerfox-Zähler aus.',
    es: 'Elija un contador powerfox en la configuración de este widget.',
  },
  unknown: {
    en: 'This meter is not in the powerfox account any more.',
    fr: 'Ce compteur n’est plus dans le compte powerfox.',
    de: 'Dieser Zähler ist nicht mehr im powerfox-Konto.',
    es: 'Este contador ya no está en la cuenta powerfox.',
  },
  power: { en: 'Power', fr: 'Puissance', de: 'Leistung', es: 'Potencia' },
  consumedToday: { en: 'Used today', fr: 'Conso. du jour', de: 'Bezug heute', es: 'Consumo hoy' },
  fedInToday: {
    en: 'Fed in today',
    fr: 'Injecté ce jour',
    de: 'Einspeisung heute',
    es: 'Vertido hoy',
  },
  gasToday: { en: 'Gas today', fr: 'Gaz du jour', de: 'Gas heute', es: 'Gas hoy' },
  gasHour: { en: 'This hour', fr: 'Cette heure', de: 'Diese Stunde', es: 'Esta hora' },
  costToday: { en: 'Cost today', fr: 'Coût du jour', de: 'Kosten heute', es: 'Coste hoy' },
  lastReading: {
    en: 'Last reading',
    fr: 'Dernière mesure',
    de: 'Letzte Messung',
    es: 'Última medición',
  },
  reading: { en: 'Reading', fr: 'Mesure', de: 'Messung', es: 'Medición' },
  upToDate: { en: 'Up to date', fr: 'À jour', de: 'Aktuell', es: 'Actualizada' },
  outdated: { en: 'Stale', fr: 'Périmée', de: 'Veraltet', es: 'Desactualizada' },
  waiting: { en: 'Waiting', fr: 'En attente', de: 'Ausstehend', es: 'En espera' },
};

const t = (text, language) => text[language] ?? text.en;

// The widget tiles show at most 12 characters and a 6-character unit.
const round = (value, digits) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** "14:32", or "12/10 14:32" for another day, in the Gladys timezone (TZ). */
export function formatTime(date, language, now) {
  const locale = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' }[language] ?? 'en-GB';
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) {
    return time;
  }
  const day = date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
  return `${day} ${time}`;
}

const valueTile = (label, value, unit, language, icon) => ({
  type: 'value',
  label: t(label, language),
  value: value ?? '—',
  ...(value === null ? {} : { unit }),
  icon,
});

/**
 * The content of the widget.
 * @param {import('./hub.js').PowerfoxHub} hub
 * @param {{ settings?: object, language?: string }} request
 */
export async function widgetContent(hub, { settings = {}, language = 'en' } = {}) {
  const lang = ['en', 'fr', 'de', 'es'].includes(language) ? language : 'en';
  if (!settings.device) {
    return { ttl_seconds: 300, components: [{ type: 'text', text: t(TEXT.pick, lang) }] };
  }
  const meter = hub.findMeter(settings.device);
  if (!meter) {
    return { ttl_seconds: 300, components: [{ type: 'text', text: t(TEXT.unknown, lang) }] };
  }
  const ids = deviceIds(hub.gladys, meter);
  const names = NAMES[lang];
  const components = [{ type: 'text', variant: 'caption', text: deviceName(meter, lang) }];

  if (meter.kind === 'power') {
    const report = await hub.today(meter);
    components.push({
      type: 'value',
      label: t(TEXT.power, lang),
      device_feature: ids.feature('power'),
      icon: 'zap',
    });
    components.push(
      valueTile(TEXT.consumedToday, round(report?.consumption, 2), 'kWh', lang, 'arrow-down'),
    );
    if (meter.prosumer) {
      components.push(valueTile(TEXT.fedInToday, round(report?.feedIn, 2), 'kWh', lang, 'sun'));
    }
  } else if (meter.kind === 'gas') {
    const report = await hub.today(meter);
    components.push(
      valueTile(TEXT.gasToday, round(report?.gas?.today, 2), 'm³', lang, 'thermometer'),
      valueTile(TEXT.gasHour, round(report?.gas?.thisHour, 2), 'm³', lang, 'clock'),
      valueTile(TEXT.costToday, round(report?.gas?.costToday, 2), '€', lang, 'credit-card'),
    );
  } else {
    // Water and heat: the indexes the device has, bound to its features.
    for (const spec of featureSpecs(meter).filter((item) => item.key !== 'outdated')) {
      components.push({
        type: 'value',
        label: names[spec.key],
        device_feature: ids.feature(spec.key),
        icon: meter.kind === 'heat' ? 'thermometer' : 'droplet',
      });
    }
  }

  if (meter.kind !== 'gas') {
    const reading = hub.readings.get(meter.id);
    const items = [];
    if (reading?.timestamp) {
      items.push({
        label: t(TEXT.lastReading, lang),
        value: formatTime(reading.timestamp, lang, new Date(hub.now())),
        icon: 'clock',
      });
    }
    items.push(
      reading
        ? {
            label: t(TEXT.reading, lang),
            value: t(reading.outdated ? TEXT.outdated : TEXT.upToDate, lang),
            color: reading.outdated ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
          }
        : {
            label: t(TEXT.reading, lang),
            value: t(TEXT.waiting, lang),
            color: WIDGET_COLORS.NEUTRAL,
          },
    );
    components.push({ type: 'status', items });
  }

  // The daily totals move every few minutes: the core pulls again after that.
  return { ttl_seconds: 120, components };
}

export const WIDGETS = {
  [WIDGET_KEY]: {
    get: (hub, request) => widgetContent(hub, request),
  },
};
