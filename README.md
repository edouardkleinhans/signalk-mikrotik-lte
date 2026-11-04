# signalk-mikrotik-lte

Signal K plugin that polls a MikroTik RouterOS v7 LTE interface (tested: wAP R / R11e-LTE, RouterOS 7.23.8)
through the REST API. Paths follow the `networking.lte.*` convention of the netgear / Teltonika / Huawei
LTE plugins, so `@meri-imperiumi/signalk-internet` and Status Tiles work unchanged.

- Radio: `networking.lte.{rsrp,rsrq,sinr,rssi,cqi,radioQuality,bars,connectionType,curBand,cellId,pci,roaming}`,
  cleared to `null` when the modem is not registered or the router is unreachable.
  `rsrp` and `sinr` carry `meta.zones`: the server raises `notifications.networking.lte.*` on weak signal.
- Link: `networking.lte.{connectionText,registerNetworkDisplay,routerLink}`, `networking.wan.ip`, `networking.modem.uptime`.
- Counters: `networking.lte.usage.{rx,tx}` (bytes since the last LTE session start).
- Data plan (when `planMiB` > 0): `networking.lte.plan.{totalBytes,usedBytes,remainingBytes,usedRatio,periodEnd}`.
  Usage is counted by the plugin from counter deltas (survives router reboots), state in the plugin data dir.
  `usedRatio` zones warn at 80 % and alarm at 95 % by default. "Set used data" is applied once each time its value changes.
- SMS: `networking.lte.{lastMessage,lastMessageTime,sms.count}` and a `notifications.networking.lte.sms`
  alert per new message. The text ends up in Signal K data (and history, if recorded): turn `sms` off if that matters.

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
