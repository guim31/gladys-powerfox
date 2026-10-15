// -----------------------------------------------------------------------------
// The powerfox payloads, turned into plain readings. Nothing here trusts the
// API: a missing or non-numeric field is `null`, never 0 (a 0 on a meter index
// would make Gladys count the whole index as one half-hour of consumption).
// Field names from the python-powerfox models (MIT) and their fixtures.
// -----------------------------------------------------------------------------

import { isValidDeviceId } from './client.js';

// `Division` of my/all/devices.
export const DIVISION = {
  NONE: -1,
  POWER: 0,
  COLD_WATER: 1,
  HOT_WATER: 2,
  HEAT: 3,
  GAS: 4,
  COLD_HOT_WATER: 5,
};

/** The kind of meter a reader is clipped on, or null when not supported. */
export function meterKind(division) {
  switch (division) {
    case DIVISION.POWER:
      return 'power';
    case DIVISION.COLD_WATER:
    case DIVISION.HOT_WATER:
    case DIVISION.COLD_HOT_WATER:
      return 'water';
    case DIVISION.HEAT:
      return 'heat';
    case DIVISION.GAS:
      return 'gas';
    default:
      return null;
  }
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// A meter total at 0 is "no reading" for powerfox (python-powerfox drops it too).
const total = (value) => {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
};

/**
 * my/all/devices → the readers, unknown ids dropped.
 * @returns {{ id: string, name: string|null, division: number, kind: string|null,
 *   prosumer: boolean, main: boolean }[]}
 */
export function parseDevices(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const seen = new Set();
  const devices = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || !isValidDeviceId(entry.DeviceId)) {
      continue;
    }
    if (seen.has(entry.DeviceId)) {
      continue;
    }
    seen.add(entry.DeviceId);
    const division = Number.isInteger(entry.Division) ? entry.Division : DIVISION.NONE;
    const name = typeof entry.Name === 'string' && entry.Name.trim() ? entry.Name.trim() : null;
    devices.push({
      id: entry.DeviceId,
      name: name ? name.slice(0, 80) : null,
      division,
      kind: meterKind(division),
      prosumer: entry.Prosumer === true,
      main: entry.MainDevice === true,
    });
  }
  return devices;
}

/**
 * my/<id>/current → one reading. `values` only holds the fields of the kind.
 * @param {object} body
 * @param {string} kind 'power' | 'water' | 'heat'
 */
export function parseCurrent(body, kind) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const seconds = finite(source.Timestamp);
  const reading = {
    timestamp: seconds !== null && seconds > 0 ? new Date(seconds * 1000) : null,
    outdated: source.Outdated === true,
    values: {},
  };
  const values = reading.values;
  if (kind === 'power') {
    values.power = finite(source.Watt);
    // The total consumption register, or high + low tariff when the meter
    // only shows those (power-meter-invalid.json: A_Plus at 0).
    const high = total(source.A_Plus_HT);
    const low = finite(source.A_Plus_NT);
    values.energy_import =
      total(source.A_Plus) ?? (high !== null && low !== null && low >= 0 ? high + low : null);
    values.energy_export = total(source.A_Minus);
  } else if (kind === 'water') {
    values.cold_water = finite(source.CubicMeterCold);
    values.warm_water = finite(source.CubicMeterWarm);
  } else if (kind === 'heat') {
    values.heat_energy = total(source.KiloWattHour);
    values.heat_volume = total(source.CubicMeter);
  }
  return reading;
}

/**
 * my/<id>/report → the totals of the day. Electricity in kWh (Consumption,
 * FeedIn), gas in m³ (Gas.Sum) with its kWh equivalent and cost.
 */
export function parseReport(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const section = (key) =>
    source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
      ? source[key]
      : null;
  const consumption = section('Consumption');
  const feedIn = section('FeedIn');
  const gas = section('Gas');
  const nonNegative = (value) => {
    const number = finite(value);
    return number !== null && number >= 0 ? number : null;
  };
  return {
    consumption: consumption ? nonNegative(consumption.Sum) : null,
    feedIn: feedIn ? nonNegative(feedIn.Sum) : null,
    gas: gas
      ? {
          today: nonNegative(gas.Sum),
          todayKwh: nonNegative(gas.ConsumptionKWh),
          thisHour: nonNegative(gas.CurrentConsumption),
          costToday: nonNegative(gas.SumCurrency),
        }
      : null,
  };
}

/** The local calendar day of `date` (the container runs in the Gladys timezone, TZ). */
export function localDay(date) {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}
