# powerfox API fixtures

Real responses of the powerfox cloud API (`https://backend.powerfox.energy/api/2.0/`), taken from the
test fixtures of [`klaasnicolaas/python-powerfox`](https://github.com/klaasnicolaas/python-powerfox) (MIT,
© Klaas Schoute), the library behind the Home Assistant `powerfox` integration. The device ids were
replaced by invented ones.

| File                       | Endpoint                           | Notes                                                     |
| -------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `all-devices.json`         | `my/all/devices`                   | two electricity meters, a water meter, a gas meter        |
| `power-meter.json`         | `my/<id>/current?unit=kwh`         | electricity meter                                         |
| `power-meter-full.json`    | `my/<id>/current?unit=kwh`         | with the high and low tariff registers                    |
| `power-meter-invalid.json` | `my/<id>/current?unit=kwh`         | `A_Plus` and `A_Minus` at 0: no reading of the totals     |
| `water-meter.json`         | `my/<id>/current?unit=kwh`         | cold water meter                                          |
| `heat-meter.json`          | `my/<id>/current?unit=kwh`         | heat meter                                                |
| `gas-report.json`          | `my/<id>/report?year=&month=&day=` | gas meter, daily report (`Gas` section)                   |
| `power-report.json`        | `my/<id>/report?year=&month=&day=` | electricity meter, daily report (`Consumption`, `FeedIn`) |

`all-types.json` is **not** a recorded response: it is built from the `all-devices.json` shape to hold one
device of every `Division` (0 electricity, 1 cold water, 2 hot water, 3 heat, 4 gas, 5 cold and hot water,
-1 no type).
