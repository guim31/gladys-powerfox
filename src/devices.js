// -----------------------------------------------------------------------------
// One Gladys device per poweropti reader, in the vocabulary of the core.
//
// Electricity: the power (signed on a bidirectional meter: grid-sensor/power,
// import > 0, export < 0), the consumption index (energy-sensor/index: the
// core derives the 30-minute consumption and its cost from it, the Gladys
// energy tracking), the feed-in index (energy-production-sensor/index: the
// core's production tracking, and the feed-in revenue).
// Water: the cold and hot water indexes. Heat: the heat energy and the water
// volume. Gas: the daily report (today, this hour, cost of the day), the API
// gives no gas index.
//
// The heat energy is a counter, not an energy-sensor index: the core would
// attach an index to the main ELECTRIC meter and count heat as electricity.
//
// Every external id is built from the powerfox DeviceId, never from a name:
// it is the key of the device, its history and the scenes in Gladys.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DIVISION } from './powerfox/model.js';
import { meterIntervalMs, pollFrequencyMs } from './config.js';

export const DEVICE_TYPE = 'poweropti';

// Display bounds (the core never applies min/max to a state). The power is
// signed on a bidirectional meter: symmetric bounds, the gauge needle sits at
// the middle at 0.
const MAX_POWER_W = 20_000;
const MAX_INDEX = 100_000_000;

export const NAMES = {
  en: {
    power: 'Power',
    energy_import: 'Consumption index',
    energy_export: 'Feed-in index',
    outdated: 'Stale reading',
    cold_water: 'Cold water',
    warm_water: 'Hot water',
    heat_energy: 'Heat energy',
    heat_volume: 'Heating water volume',
    gas_today: 'Gas today',
    gas_this_hour: 'Gas this hour',
    gas_cost_today: 'Gas cost today',
  },
  fr: {
    power: 'Puissance',
    energy_import: 'Index de consommation',
    energy_export: "Index d'injection",
    outdated: 'Mesure périmée',
    cold_water: 'Eau froide',
    warm_water: 'Eau chaude',
    heat_energy: 'Énergie thermique',
    heat_volume: 'Volume de chauffage',
    gas_today: "Gaz aujourd'hui",
    gas_this_hour: 'Gaz cette heure',
    gas_cost_today: "Coût du gaz aujourd'hui",
  },
  de: {
    power: 'Leistung',
    energy_import: 'Bezugszählerstand',
    energy_export: 'Einspeisezählerstand',
    outdated: 'Messwert veraltet',
    cold_water: 'Kaltwasser',
    warm_water: 'Warmwasser',
    heat_energy: 'Wärmemenge',
    heat_volume: 'Heizwasservolumen',
    gas_today: 'Gas heute',
    gas_this_hour: 'Gas diese Stunde',
    gas_cost_today: 'Gaskosten heute',
  },
  es: {
    power: 'Potencia',
    energy_import: 'Índice de consumo',
    energy_export: 'Índice de vertido',
    outdated: 'Medición desactualizada',
    cold_water: 'Agua fría',
    warm_water: 'Agua caliente',
    heat_energy: 'Energía térmica',
    heat_volume: 'Volumen de calefacción',
    gas_today: 'Gas hoy',
    gas_this_hour: 'Gas esta hora',
    gas_cost_today: 'Coste del gas hoy',
  },
};

// Default device names, when the reader has no name in the powerfox app.
export const KIND_NAMES = {
  en: { power: 'Electricity meter', water: 'Water meter', heat: 'Heat meter', gas: 'Gas meter' },
  fr: {
    power: 'Compteur électrique',
    water: "Compteur d'eau",
    heat: 'Compteur de chaleur',
    gas: 'Compteur de gaz',
  },
  de: { power: 'Stromzähler', water: 'Wasserzähler', heat: 'Wärmezähler', gas: 'Gaszähler' },
  es: {
    power: 'Contador eléctrico',
    water: 'Contador de agua',
    heat: 'Contador de calor',
    gas: 'Contador de gas',
  },
};

const outdatedFeature = {
  key: 'outdated',
  category: CATEGORIES.INPUT,
  type: TYPES.INPUT.BINARY,
  min: 0,
  max: 1,
};

const volumeIndex = (key) => ({
  key,
  category: CATEGORIES.VOLUME_SENSOR,
  type: TYPES.VOLUME_SENSOR.DECIMAL,
  unit: UNITS.CUBIC_METER,
  min: 0,
  max: MAX_INDEX,
});

/**
 * The features of a reader. Fixed by the reader's type and its "Prosumer"
 * flag only, never by a reading: the structure stays the same from one
 * start to the next.
 * @returns {{ key: string, category: string, type: string, unit?: string, min: number, max: number }[]}
 */
export function featureSpecs(meter) {
  switch (meter.kind) {
    case 'power': {
      const specs = [
        meter.prosumer
          ? {
              key: 'power',
              category: CATEGORIES.GRID_SENSOR,
              type: TYPES.GRID_SENSOR.POWER,
              unit: UNITS.WATT,
              min: -MAX_POWER_W,
              max: MAX_POWER_W,
            }
          : {
              key: 'power',
              category: CATEGORIES.ENERGY_SENSOR,
              type: TYPES.ENERGY_SENSOR.POWER,
              unit: UNITS.WATT,
              min: 0,
              max: MAX_POWER_W,
            },
        {
          key: 'energy_import',
          category: CATEGORIES.ENERGY_SENSOR,
          type: TYPES.ENERGY_SENSOR.INDEX,
          unit: UNITS.KILOWATT_HOUR,
          min: 0,
          max: MAX_INDEX,
        },
      ];
      if (meter.prosumer) {
        specs.push({
          key: 'energy_export',
          category: CATEGORIES.ENERGY_PRODUCTION_SENSOR,
          type: TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
          unit: UNITS.KILOWATT_HOUR,
          min: 0,
          max: MAX_INDEX,
        });
      }
      specs.push(outdatedFeature);
      return specs;
    }
    case 'water': {
      const specs = [];
      if (meter.division !== DIVISION.HOT_WATER) {
        specs.push(volumeIndex('cold_water'));
      }
      if (meter.division !== DIVISION.COLD_WATER) {
        specs.push(volumeIndex('warm_water'));
      }
      specs.push(outdatedFeature);
      return specs;
    }
    case 'heat':
      return [
        {
          key: 'heat_energy',
          category: CATEGORIES.COUNTER_SENSOR,
          type: TYPES.SENSOR.INTEGER,
          unit: UNITS.KILOWATT_HOUR,
          min: 0,
          max: MAX_INDEX,
        },
        volumeIndex('heat_volume'),
        outdatedFeature,
      ];
    case 'gas':
      return [
        {
          key: 'gas_today',
          category: CATEGORIES.VOLUME_SENSOR,
          type: TYPES.VOLUME_SENSOR.DECIMAL,
          unit: UNITS.CUBIC_METER,
          min: 0,
          max: 1000,
        },
        {
          key: 'gas_this_hour',
          category: CATEGORIES.VOLUME_SENSOR,
          type: TYPES.VOLUME_SENSOR.DECIMAL,
          unit: UNITS.CUBIC_METER,
          min: 0,
          max: 100,
        },
        {
          key: 'gas_cost_today',
          category: CATEGORIES.CURRENCY,
          type: TYPES.CURRENCY.DECIMAL,
          unit: UNITS.EURO,
          min: 0,
          max: 10_000,
        },
      ];
    default:
      return [];
  }
}

export const deviceIds = (gladys, meter) => gladys.externalIds(DEVICE_TYPE, meter.id);

/** The name of the device: the one given in the powerfox app, or the meter type. */
export function deviceName(meter, language) {
  if (meter.name) {
    return meter.name;
  }
  const kind = (KIND_NAMES[language] ?? KIND_NAMES.en)[meter.kind];
  return `${kind} ${meter.id.slice(-4)}`;
}

/** The discovery payload of one reader. */
export function buildDevice(gladys, meter, config) {
  const ids = deviceIds(gladys, meter);
  const names = NAMES[config.language] ?? NAMES.en;
  return {
    name: deviceName(meter, config.language),
    external_id: ids.device,
    // The container polls by itself (src/hub.js); the core's polling is the
    // fallback, at a pace never faster than the reader's.
    should_poll: true,
    poll_frequency: pollFrequencyMs(meterIntervalMs(config, meter.kind)),
    params: [
      { name: 'powerfox_device_id', value: meter.id },
      { name: 'meter_type', value: meter.kind },
    ],
    features: featureSpecs(meter).map((spec) => ({
      name: names[spec.key],
      external_id: ids.feature(spec.key),
      category: spec.category,
      type: spec.type,
      ...(spec.unit ? { unit: spec.unit } : {}),
      min: spec.min,
      max: spec.max,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
  };
}

/**
 * The states of one reading, for the features the device has.
 * @param {object} meter
 * @param {{ values: Record<string, number|null>, outdated?: boolean }} reading
 * @returns {{ key: string, value: number }[]}
 */
export function readingStates(meter, reading) {
  const states = [];
  for (const spec of featureSpecs(meter)) {
    if (spec.key === 'outdated') {
      states.push({ key: 'outdated', value: reading.outdated ? 1 : 0 });
      continue;
    }
    let value = reading.values[spec.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    if (spec.type === TYPES.SENSOR.INTEGER) {
      value = Math.round(value);
    }
    states.push({ key: spec.key, value });
  }
  return states;
}

const round = (value, digits) =>
  typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** A gas report, as a reading of the gas features (the API sends 15 decimals). */
export function gasReading(report) {
  const gas = report.gas ?? {};
  return {
    outdated: false,
    values: {
      gas_today: round(gas.today, 3),
      gas_this_hour: round(gas.thisHour, 3),
      gas_cost_today: round(gas.costToday, 2),
    },
  };
}

/** The indexes, which only go up: a lower value is a glitch, never published. */
export const INDEX_KEYS = new Set([
  'energy_import',
  'energy_export',
  'cold_water',
  'warm_water',
  'heat_energy',
  'heat_volume',
]);
