# signalk-mikrotik-lte

Signal K plugin that polls a MikroTik RouterOS v7 LTE interface (tested: wAP R / R11e-LTE, RouterOS 7.23.8)
through the REST API and publishes:

| Path | Unit |
|---|---|
| `mikrotik.lte.rsrp`, `.rssi` | dBm |
| `mikrotik.lte.rsrq`, `.sinr` | dB |
| `mikrotik.lte.cqi` | 0-15 |
| `mikrotik.lte.operator`, `.status`, `.accessTechnology`, `.cellId` | string |
| `mikrotik.lte.band` | number |
| `mikrotik.lte.roaming`, `.running` | boolean |
| `mikrotik.lte.rxBytes`, `.txBytes` | bytes since router boot |

## Router setup

`www-ssl` must be enabled. Use a dedicated account: REST needs the `api` policy as well as `rest-api`.

```
/user group add name=signalk policy=read,api,rest-api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!test,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=signalk group=signalk address=<signalk-server-ip>/32 password=<random>
```

## Test

```
npm test
```
