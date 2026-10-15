# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- One Gladys device per powerfox poweropti reader of the account, read through
  the powerfox cloud API with the e-mail and password of the powerfox app.
- Electricity meters: instantaneous power (signed on a bidirectional meter),
  consumption index and feed-in index in kWh, which feed the Gladys energy
  tracking (30-minute consumption, cost, production).
- Water meters (cold and/or hot water index), heat meters (heat energy and
  heating water volume) and gas meters (gas today, this hour, cost of the day).
- A "Stale reading" flag, raised when powerfox says the last reading is old.
- Dashboard widget "powerfox": live power, energy used and fed in today, time
  of the last reading.
- Scene action "powerfox: energy of the day": the totals of the day and a
  ready-made sentence for a message.
- "Test the connection" button in the configuration.
- Refresh interval from 10 seconds to 5 minutes (1 minute by default); pause on
  a powerfox rate limit, no retry on a refused password.
- Names, messages and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-powerfox/commits/main
