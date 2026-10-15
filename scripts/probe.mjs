#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe of the real powerfox cloud API, read only, through the client of the
// integration (src/powerfox/client.js).
//
//   node scripts/probe.mjs
//     Signs in with an invented account and expects powerfox to refuse it
//     (HTTP 401): proves the URL, the Basic authentication and the error
//     mapping against the live service.
//
//   POWERFOX_EMAIL=… POWERFOX_PASSWORD=… node scripts/probe.mjs
//     With a real account: lists the readers and reads each one ONCE (current
//     reading, daily report), printing only the SHAPE of the answers — field
//     names, types, the Outdated flag, the age of the reading. Never an id, a
//     name, a value, the e-mail or the password.
//
// Exit code 0 when everything behaved as the integration expects.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import {
  API_BASE,
  PowerfoxAuthError,
  PowerfoxClient,
  PowerfoxError,
} from '../src/powerfox/client.js';
import { localDay, parseDevices } from '../src/powerfox/model.js';

// Headers worth knowing about (quotas, caching); their values hold no secret.
const INTERESTING_HEADERS =
  /^(retry-after|x-rate-?limit.*|ratelimit.*|content-type|cache-control)$/i;

/** A fetch that records what came back, for the report. */
function recordingFetch(log) {
  return async (url, init) => {
    const started = Date.now();
    try {
      const response = await fetch(url, init);
      const headers = [...response.headers.entries()]
        .filter(([name]) => INTERESTING_HEADERS.test(name))
        .map(([name, value]) => `${name}: ${value}`);
      // The path only, with the reader id masked.
      const path = new URL(url).pathname.replace(/\/my\/[^/]+\//, '/my/<id>/');
      log.push({ path, status: response.status, ms: Date.now() - started, headers });
      return response;
    } catch (err) {
      log.push({
        path: String(url),
        error: err?.cause?.code ?? err?.name,
        ms: Date.now() - started,
      });
      throw err;
    }
  };
}

function printLog(log) {
  for (const entry of log.splice(0)) {
    if (entry.error) {
      console.log(`  ${entry.path} → network error ${entry.error} (${entry.ms} ms)`);
      continue;
    }
    console.log(`  GET ${entry.path} → HTTP ${entry.status} (${entry.ms} ms)`);
    for (const header of entry.headers) {
      console.log(`      ${header}`);
    }
  }
}

/** The shape of a JSON value: keys and types, never the values. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${shape(value[0], depth + 1)}, … ×${value.length}]`;
  }
  if (value && typeof value === 'object') {
    if (depth > 2) {
      return '{…}';
    }
    const fields = Object.entries(value).map(([key, item]) => `${key}: ${shape(item, depth + 1)}`);
    return `{ ${fields.join(', ')} }`;
  }
  return value === null ? 'null' : typeof value;
}

async function probeRefusal() {
  console.log(`powerfox API: ${API_BASE}`);
  console.log('1. Invented account (must be refused):');
  const log = [];
  const client = new PowerfoxClient({
    email: `probe-${randomBytes(4).toString('hex')}@example.invalid`,
    password: randomBytes(12).toString('hex'),
    fetch: recordingFetch(log),
    userAgent: 'gladys-powerfox-probe',
  });
  try {
    await client.allDevices();
    printLog(log);
    console.log('   ✗ the invented account was accepted: unexpected');
    return false;
  } catch (err) {
    printLog(log);
    if (err instanceof PowerfoxAuthError) {
      console.log('   ✓ refused as expected (PowerfoxAuthError)');
      return true;
    }
    console.log(`   ✗ ${err.name}: ${err.message}`);
    return false;
  }
}

async function probeAccount(email, password) {
  console.log('2. Real account (read only, one request per endpoint and reader):');
  const log = [];
  const client = new PowerfoxClient({
    email,
    password,
    fetch: recordingFetch(log),
    userAgent: 'gladys-powerfox-probe',
  });
  let ok = true;
  const raw = await client.allDevices();
  printLog(log);
  console.log(`   devices: ${shape(raw)}`);
  const devices = parseDevices(raw);
  const byDivision = {};
  for (const device of devices) {
    byDivision[device.division] = (byDivision[device.division] ?? 0) + 1;
  }
  console.log(`   readers by Division: ${JSON.stringify(byDivision)}`);
  for (const [index, device] of devices.entries()) {
    const label = `reader #${index + 1} (Division ${device.division}, Prosumer ${device.prosumer})`;
    try {
      const current = await client.current(device.id);
      printLog(log);
      console.log(`   ${label} current: ${shape(current)}`);
      if (typeof current?.Timestamp === 'number') {
        const age = Math.round(Date.now() / 1000 - current.Timestamp);
        console.log(`      Outdated: ${current.Outdated}, reading age: ${age} s`);
      }
      if (typeof current?.Watt === 'number') {
        console.log(`      Watt sign: ${Math.sign(current.Watt)}`);
      }
    } catch (err) {
      printLog(log);
      console.log(`   ${label} current: ${err.name} (${err.message})`);
      ok = ok && device.kind === 'gas';
    }
    try {
      const report = await client.report(device.id, localDay(new Date()));
      printLog(log);
      console.log(`   ${label} report: ${shape(report)}`);
    } catch (err) {
      printLog(log);
      console.log(`   ${label} report: ${err.name} (${err.message})`);
    }
  }
  return ok;
}

let ok = await probeRefusal();
const { POWERFOX_EMAIL: email, POWERFOX_PASSWORD: password } = process.env;
if (email && password) {
  try {
    ok = (await probeAccount(email, password)) && ok;
  } catch (err) {
    console.log(`   ✗ ${err instanceof PowerfoxError ? err.name : 'Error'}: ${err.message}`);
    ok = false;
  }
} else {
  console.log('2. Real account: skipped (set POWERFOX_EMAIL and POWERFOX_PASSWORD to run it)');
}
process.exitCode = ok ? 0 : 1;
