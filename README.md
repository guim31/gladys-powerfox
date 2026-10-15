# powerfox for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that brings the
**powerfox poweropti** meter readers into Gladys, through the **powerfox cloud API**: the optical readers
clipped on electricity, gas, water and heat meters, widely used in Germany and Austria. Read only.

> **Developed without the hardware: feedback welcome.** The integration is built and tested against the real
> answers of the powerfox API published by the `python-powerfox` library, not against a poweropti or a
> powerfox account. Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-powerfox/issues).
>
> This project is **not affiliated with powerfox GmbH**. powerfox and poweropti are trademarks of their
> owner.

## Features

- **One device per poweropti** of the account:
  - **electricity meter**: the instantaneous power (signed on a bidirectional meter: import > 0, feed-in < 0),
    the **consumption index** and the **feed-in index** in kWh. Gladys derives the 30-minute consumption, its
    cost and the production tracking from them (energy tracking);
  - **water meter**: cold and/or hot water index (m³);
  - **heat meter**: heat energy (kWh) and heating water volume (m³);
  - **gas meter**: gas today, gas this hour (m³) and the gas cost of the day (€), from the daily report (the
    API gives no gas index);
  - a **stale reading** flag (every type except gas), from the `Outdated` flag of powerfox.
- **Dashboard widget** "powerfox": the live power, the energy used and fed in today, the time of the last
  reading (gas: the gas of the day, of the hour and its cost).
- **Scene action** _powerfox: energy of the day_: the totals of the day of an electricity or gas meter, and a
  ready-made sentence for a message.
- **Configuration action** _Test the connection_: signs in and lists the readers of the account.
- Readings at the pace you choose (10 s to 5 min, 1 min by default), backoff on `HTTP 429`, no retry on a
  refused password, quiet logs.

## Requirements

- Gladys Assistant **5.1.0** or later (5.2 recommended: energy tracking of external integrations).
- A poweropti set up in the powerfox app, and the e-mail and password of that account.
- Internet access from Gladys (`backend.powerfox.energy`).

## Installation

1. In Gladys, open **Integrations → Install from GitHub** and enter
   `https://github.com/guim31/gladys-powerfox` (or install **powerfox** from the catalog once it is listed).
2. In the **Configuration** of the integration, enter the e-mail and the password of the powerfox app, then
   click **Test the connection**.
3. Open the **Discover** tab and add the readers you want. Only the added readers are read.

The user guide is in [`docs/en.md`](docs/en.md) (also in [French](docs/fr.md), [German](docs/de.md) and
[Spanish](docs/es.md)); Gladys links it from the Configuration screen.

## How it works

```
Integration container ──HTTPS, Basic auth──▶ backend.powerfox.energy/api/2.0/
   my/all/devices              the readers of the account (start, every 6 h, Discover tab)
   my/<id>/current?unit=kwh    the last reading of each added reader, every interval
   my/<id>/report?year&month&day   the hourly report of the day (gas, widget, scene action)
        │
        └── SDK (WebSocket + host API) ──▶ Gladys: devices, changed states, widget, scene action
```

- The devices are identified by the powerfox **DeviceId**: renaming a reader in the app changes nothing.
- The container reads the readers **by itself**, on its own timer (the Gladys core does not reliably poll
  external devices, GladysAssistant/Gladys#3198); the core's `onPoll` remains as a fallback and never causes
  a second request in the same period.
- Only the **changed** values are published, plus every value once every 6 hours (so Gladys never shows "no
  recent value"); a stale reading does not refresh its old values.
- An index lower than the previous one, or a total at 0, is a reading glitch: never published (Gladys would
  count it as a huge consumption).
- `HTTP 429`: no request at all for the `Retry-After` delay, or a pause doubling up to 30 minutes.
  `HTTP 401`: no request until the configuration is saved again.
- Nothing is written in `/data`: the integration keeps no state on disk. The credentials stay in the Gladys
  configuration and never reach the logs.

## Limits

- Cloud only: the local interface some readers offer is not used.
- Read only. The high and low tariff registers are not published separately; gas meters have no index.
- Costs in euros, the currency of powerfox.
- The powerfox API publishes no request quota: the defaults stay well below the pace of the Home Assistant
  integration (every 10 s).

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
node scripts/probe.mjs   # the real API: an invented account must be refused (401)
```

`scripts/probe.mjs` signs in to the real powerfox API with an invented account and checks that it is refused.
With `POWERFOX_EMAIL` and `POWERFOX_PASSWORD` set, it also reads a real account once, read only, and prints
the shape of the answers (field names and types), never an id, a name, a value or a credential.

The tests run against the fake Gladys of the SDK (`@gladysassistant/integration-sdk/testing`) and a fake
powerfox cloud serving recorded responses (`test/fixtures/powerfox`); they never touch the network.
`test/gladys-rules.test.js` checks every device against the feature table of the Gladys core.

Releases are made by the **Release** workflow (Actions → Release), which bumps the versions, rolls
[`CHANGELOG.md`](CHANGELOG.md), tags and builds the multi-arch image to `ghcr.io/guim31/gladys-powerfox`.

> Prefer the terminal? A hand-pushed `vX.Y.Z` tag triggers the same build and GitHub Release, but does not
> touch the files: bump `version` in `package.json` and in `gladys-assistant-integration.json` (with the
> `docker_image` tag) and commit it **before** tagging.

## Credits

- [`klaasnicolaas/python-powerfox`](https://github.com/klaasnicolaas/python-powerfox) (MIT, © Klaas Schoute):
  the endpoints, the field names and the recorded API responses used as test fixtures.
- The Home Assistant [`powerfox` integration](https://www.home-assistant.io/integrations/powerfox/)
  (Apache-2.0): the mapping of the readers and the refresh pace.
- Built from the official
  [Gladys JavaScript integration template](https://github.com/GladysAssistant/integration-template-js).

## License

[Apache-2.0](LICENSE)
