# Changelog

## 0.2.1 — 2026-11-04

- Published from GitHub Actions through npm Trusted Publishing, with provenance. No code change.

## 0.2.0 — 2026-11-04

- Paths moved to the `networking.lte.*` convention of the netgear / Teltonika / Huawei LTE plugins, so `@meri-imperiumi/signalk-internet` and Status Tiles read them unchanged.
- `radioQuality` (0–1, worse of RSRP and SINR) and `bars` (0–5).
- `meta.zones` on RSRP and SINR: the server raises weak-signal notifications.
- Radio values cleared to `null` when the modem is not registered or the router does not answer.
- `routerLink`, `networking.wan.ip`, `networking.modem.uptime`.
- Data plan tracking: size, reset day, usage counted from counter deltas (survives router reboots and LTE session restarts), one-shot "set used data" correction, warn/alarm zones on `plan.usedRatio`.
- SMS: last message, inbox count, one notification per new message; multi-part messages joined.

## 0.1.0 — 2026-11-04

- First version: LTE signal, operator, roaming, band and data counters under `mikrotik.lte.*`.
