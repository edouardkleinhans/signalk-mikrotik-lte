'use strict'
// Signal K plugin: polls a MikroTik RouterOS v7 LTE interface over the REST API.
// Paths follow the networking.lte.* convention of the netgear / teltonika / huawei
// LTE plugins, so consumers like @meri-imperiumi/signalk-internet work unchanged.

const fs = require('fs')
const path = require('path')
const https = require('https')

const P = 'networking.lte.'
const MIB = 1024 * 1024 // Orange counts plans in "Mo" = MiB (307200 Mo = 300 Go)
const NO_SERVICE = 'No service'

const NUM = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? undefined : Number(v))
const linear = (lower, upper) => ({ lower, upper, type: 'linear' })

// radioQuality: RSRP and SINR each mapped linearly poor→good, the worse one wins
// (same anchors as signalk-huawei-b311-221).
const RSRP_POOR = -120; const RSRP_GOOD = -80
const SINR_POOR = 0; const SINR_GOOD = 20
const RSRP_ZONES = [
  { upper: -115, state: 'alarm', message: 'LTE signal very weak' },
  { lower: -115, upper: -105, state: 'warn', message: 'LTE signal weak' },
  { lower: -105, state: 'normal', message: 'LTE signal good' }
]
const SINR_ZONES = [
  { upper: 0, state: 'alarm', message: 'LTE signal noisy' },
  { lower: 0, upper: 5, state: 'warn', message: 'LTE signal quality low' },
  { lower: 5, state: 'normal', message: 'LTE signal quality good' }
]

function planZones (warn, alarm) {
  return [
    { upper: warn, state: 'normal', message: 'Data plan OK' },
    { lower: warn, upper: alarm, state: 'warn', message: `Data plan over ${Math.round(warn * 100)} %` },
    { lower: alarm, state: 'alarm', message: `Data plan over ${Math.round(alarm * 100)} %` }
  ]
}

function buildMeta (o) {
  return {
    [P + 'rssi']: { displayName: 'RSSI', description: 'Received signal strength indicator', units: 'dBm', displayScale: linear(-110, -50) },
    [P + 'rsrp']: { displayName: 'RSRP', description: 'LTE reference signal received power', units: 'dBm', displayScale: linear(-140, -40), zones: RSRP_ZONES },
    [P + 'rsrq']: { displayName: 'RSRQ', description: 'LTE reference signal received quality', units: 'dB', displayScale: linear(-20, 0) },
    [P + 'sinr']: { displayName: 'SINR', description: 'LTE signal to interference plus noise ratio', units: 'dB', displayScale: linear(-10, 30), zones: SINR_ZONES },
    [P + 'cqi']: { displayName: 'CQI', description: 'Channel quality indicator, 0 to 15', displayScale: linear(0, 15) },
    [P + 'bars']: { displayName: 'Signal bars', description: 'Signal strength as bars, 0 to 5, derived from radioQuality', displayScale: linear(0, 5) },
    [P + 'radioQuality']: { displayName: 'Radio quality', description: 'Overall radio quality from 0 (poor) to 1 (good), derived from RSRP and SINR', units: 'ratio', displayScale: linear(0, 1) },
    [P + 'connectionType']: { displayName: 'Network type', description: 'Mobile network technology in use, such as LTE' },
    [P + 'registerNetworkDisplay']: { displayName: 'Operator', description: 'Name of the mobile network operator the modem is registered to' },
    [P + 'connectionText']: { displayName: 'Connection', description: 'Operator name when registered on a network, or the text No service' },
    [P + 'curBand']: { displayName: 'Band', description: 'LTE frequency band in use' },
    [P + 'cellId']: { displayName: 'Cell ID', description: 'Identifier of the serving cell' },
    [P + 'pci']: { displayName: 'PCI', description: 'Physical cell identifier of the serving cell' },
    [P + 'roaming']: { displayName: 'Roaming', description: 'True when the modem is roaming on a foreign network' },
    [P + 'usage.rx']: { displayName: 'Data received', description: 'Bytes received on the LTE interface since router boot', units: 'B' },
    [P + 'usage.tx']: { displayName: 'Data sent', description: 'Bytes sent on the LTE interface since router boot', units: 'B' },
    [P + 'routerLink']: { displayName: 'Router link', description: 'State of the plugin connection to the router: connecting, ok, auth-failed or unreachable' },
    'networking.wan.ip': { displayName: 'WAN IP', description: 'IP address of the router on the mobile network' },
    'networking.modem.uptime': { displayName: 'Session uptime', description: 'Time since the modem data session started', units: 's' },
    [P + 'plan.totalBytes']: { displayName: 'Plan size', description: 'Data allowance of the current plan period', units: 'B' },
    [P + 'plan.usedBytes']: { displayName: 'Plan used', description: 'Data used in the current plan period, counted by the plugin', units: 'B' },
    [P + 'plan.remainingBytes']: { displayName: 'Plan remaining', description: 'Data left in the current plan period', units: 'B' },
    [P + 'plan.usedRatio']: { displayName: 'Plan used share', description: 'Share of the data plan used, from 0 to 1 (may exceed 1)', units: 'ratio', displayScale: linear(0, 1), zones: planZones(o.planWarnRatio, o.planAlarmRatio) },
    [P + 'plan.periodEnd']: { displayName: 'Plan period end', description: 'ISO 8601 time at which the current plan period ends' },
    [P + 'lastMessage']: { displayName: 'Last SMS', description: 'Sender and text of the latest received SMS, shortened' },
    [P + 'lastMessageTime']: { displayName: 'Last SMS time', description: 'ISO 8601 time the latest received SMS arrived' },
    [P + 'sms.count']: { displayName: 'SMS in inbox', description: 'Number of SMS stored on the SIM / modem' }
  }
}

const SIGNAL_PATHS = ['rssi', 'rsrp', 'rsrq', 'sinr', 'cqi', 'bars', 'radioQuality', 'connectionType', 'registerNetworkDisplay', 'curBand', 'cellId', 'pci', 'roaming'].map((k) => P + k)

function scale (v, poor, good) {
  return v === undefined ? undefined : Math.min(1, Math.max(0, (v - poor) / (good - poor)))
}

function radioQuality (rsrp, sinr) {
  const parts = [scale(rsrp, RSRP_POOR, RSRP_GOOD), scale(sinr, SINR_POOR, SINR_GOOD)].filter((q) => q !== undefined)
  return parts.length ? Math.min(...parts) : undefined
}

// RouterOS duration "3d11h29m9s" / "1w2d" → seconds.
function parseDuration (s) {
  if (!s) return undefined
  const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }
  let total = 0; let matched = false
  for (const [, n, u] of String(s).matchAll(/(\d+)([wdhms])/g)) { total += Number(n) * mult[u]; matched = true }
  return matched ? total : undefined
}

// RouterOS REST returns every value as a string; map to Signal K path → value.
function mapMonitor (m) {
  const registered = m.status === 'registered'
  const out = {}
  for (const p of SIGNAL_PATHS) out[p] = null // cleared unless registered: never serve stale radio values
  out[P + 'connectionText'] = NO_SERVICE
  if (!registered) return out
  const rsrp = NUM(m.rsrp); const sinr = NUM(m.sinr)
  const q = radioQuality(rsrp, sinr)
  const band = /band (\d+)/.exec(m.earfcn || '')
  Object.assign(out, {
    [P + 'rssi']: NUM(m.rssi) ?? null,
    [P + 'rsrp']: rsrp ?? null,
    [P + 'rsrq']: NUM(m.rsrq) ?? null,
    [P + 'sinr']: sinr ?? null,
    [P + 'cqi']: NUM(m.cqi) ?? null,
    [P + 'radioQuality']: q ?? null,
    [P + 'bars']: q === undefined ? null : Math.round(q * 5),
    [P + 'connectionType']: m['access-technology'] || null,
    [P + 'registerNetworkDisplay']: m['current-operator'] || null,
    [P + 'connectionText']: m['current-operator'] || NO_SERVICE,
    [P + 'curBand']: band ? Number(band[1]) : null,
    [P + 'cellId']: m['current-cellid'] || null,
    [P + 'pci']: NUM(m['phy-cellid']) ?? null,
    [P + 'roaming']: m.roaming === 'true'
  })
  out['networking.modem.uptime'] = parseDuration(m['session-uptime']) ?? null
  return out
}

// --- data plan ---------------------------------------------------------------

function periodBounds (now, resetDay) {
  const at = (y, mo) => new Date(y, mo, Math.min(resetDay, new Date(y, mo + 1, 0).getDate()))
  let start = at(now.getFullYear(), now.getMonth())
  if (now < start) start = at(now.getFullYear(), now.getMonth() - 1)
  const end = at(start.getFullYear(), start.getMonth() + 1)
  return { start, end }
}

// Counts LTE bytes itself from rx/tx counter deltas, so a router reboot
// (counters back to 0) does not lose or double-count usage.
function accountPlan (state, { rx, tx, now, resetDay, setUsedMiB }) {
  const s = { ...state }
  const { start, end } = periodBounds(now, resetDay)
  if (s.periodStart !== start.toISOString()) {
    s.periodStart = start.toISOString()
    s.usedBytes = 0
  } else if (s.lastRx !== undefined && rx !== undefined && tx !== undefined) {
    s.usedBytes += (rx >= s.lastRx ? rx - s.lastRx : rx) + (tx >= s.lastTx ? tx - s.lastTx : tx)
  }
  if (rx !== undefined) { s.lastRx = rx; s.lastTx = tx }
  // "Set used data" in the config is applied once, each time its value changes.
  if (typeof setUsedMiB === 'number' && setUsedMiB >= 0 && setUsedMiB !== s.appliedSetUsedMiB) {
    s.usedBytes = Math.round(setUsedMiB * MIB)
    s.appliedSetUsedMiB = setUsedMiB
  }
  return { state: s, periodEnd: end }
}

function planValues (usedBytes, planMiB, periodEnd) {
  if (!(planMiB > 0)) return {}
  const total = Math.round(planMiB * MIB)
  return {
    [P + 'plan.totalBytes']: total,
    [P + 'plan.usedBytes']: usedBytes,
    [P + 'plan.remainingBytes']: Math.max(0, total - usedBytes),
    [P + 'plan.usedRatio']: usedBytes / total,
    [P + 'plan.periodEnd']: periodEnd.toISOString()
  }
}

// --- SMS -----------------------------------------------------------------------

const smsTime = (t) => new Date(String(t).replace(' ', 'T'))

// RouterOS stores each part of a long SMS as its own entry; join parts that
// share sender and timestamp, in id order.
function groupSms (inbox) {
  const byKey = new Map()
  for (const m of [...inbox].sort((a, b) => parseInt(a['.id'].slice(1), 16) - parseInt(b['.id'].slice(1), 16))) {
    const key = `${m.phone}|${m.timestamp}`
    if (!byKey.has(key)) byKey.set(key, { phone: m.phone, time: smsTime(m.timestamp), text: '' })
    byKey.get(key).text += m.message || ''
  }
  return [...byKey.values()].filter((m) => !isNaN(m.time)).sort((a, b) => a.time - b.time)
}

const shorten = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

// --- plugin ----------------------------------------------------------------------

function request (o, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = https.request({
      host: o.host,
      port: o.port || 443,
      method,
      path: `/rest/${p}`,
      auth: `${o.username}:${o.password}`,
      rejectUnauthorized: !!o.rejectUnauthorized,
      timeout: 20000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const e = new Error(`${method} ${p}: HTTP ${res.statusCode} ${buf.slice(0, 200)}`)
          e.status = res.statusCode
          return reject(e)
        }
        try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${p}: timeout`)))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

module.exports = function (app) {
  let timer
  let state = {}
  let stateFile
  const plugin = {
    id: 'signalk-mikrotik-lte',
    name: 'MikroTik LTE',
    description: 'LTE signal, operator, data plan and SMS from a MikroTik RouterOS v7 router (REST API)'
  }

  plugin.schema = {
    type: 'object',
    required: ['host', 'username', 'password'],
    properties: {
      host: { type: 'string', title: 'Router address', default: '192.168.88.1' },
      port: { type: 'number', title: 'HTTPS port', default: 443 },
      username: { type: 'string', title: 'Username (group with read, api, rest-api)', default: 'signalk' },
      password: { type: 'string', title: 'Password' },
      interface: { type: 'string', title: 'LTE interface', default: 'lte1' },
      intervalSeconds: { type: 'number', title: 'Poll interval (s)', default: 60 },
      rejectUnauthorized: { type: 'boolean', title: 'Verify TLS certificate (off for self-signed)', default: false },
      planMiB: { type: 'number', title: 'Data plan size in Mo/MiB (0 = no plan tracking)', default: 0 },
      planResetDay: { type: 'number', title: 'Day of month the plan resets', default: 1, minimum: 1, maximum: 31 },
      setUsedMiB: { type: 'number', title: 'Set used data in Mo/MiB (applied once each time you change it; e.g. the figure from the carrier)' },
      planWarnRatio: { type: 'number', title: 'Warn when this share of the plan is used', default: 0.8 },
      planAlarmRatio: { type: 'number', title: 'Alarm when this share of the plan is used', default: 0.95 },
      sms: { type: 'boolean', title: 'Publish received SMS (text goes into Signal K data and notifications)', default: true }
    }
  }

  const send = (values) => app.handleMessage(plugin.id, { updates: [{ values: Object.entries(values).filter(([, v]) => v !== undefined).map(([p, value]) => ({ path: p, value })) }] })

  function saveState () {
    try { fs.writeFileSync(stateFile, JSON.stringify(state)) } catch (e) { app.error(`state save: ${e.message}`) }
  }

  async function pollSms (o) {
    const msgs = groupSms(await request(o, 'GET', 'tool/sms/inbox?.proplist=.id,phone,timestamp,message'))
    const last = msgs[msgs.length - 1]
    const values = { [P + 'sms.count']: msgs.length }
    if (last) {
      values[P + 'lastMessage'] = shorten(`${last.phone}: ${last.text}`)
      values[P + 'lastMessageTime'] = last.time.toISOString()
    }
    send(values)
    const seen = state.lastSmsTime ? new Date(state.lastSmsTime) : null
    // first run: remember the newest SMS without notifying for the backlog
    if (seen) {
      for (const m of msgs.filter((x) => x.time > seen)) {
        send({ [`notifications.${P}sms`]: { state: 'alert', method: ['visual'], message: shorten(`SMS ${m.phone}: ${m.text}`, 300) } })
      }
    }
    if (last && (!seen || last.time > seen)) { state.lastSmsTime = last.time.toISOString(); saveState() }
  }

  let busy = false
  async function poll (o) {
    if (busy) return // a slow LTE link can make one poll outlast the interval
    busy = true
    const iface = o.interface || 'lte1'
    try {
      const [mon] = await request(o, 'POST', 'interface/lte/monitor', { numbers: iface, once: '' })
      const [ifc] = await request(o, 'GET', `interface?name=${encodeURIComponent(iface)}&.proplist=rx-byte,tx-byte`)
      const [addr] = await request(o, 'GET', `ip/address?interface=${encodeURIComponent(iface)}&.proplist=address`)
      const rx = NUM(ifc?.['rx-byte']); const tx = NUM(ifc?.['tx-byte'])
      const values = {
        ...mapMonitor(mon || {}),
        [P + 'usage.rx']: rx,
        [P + 'usage.tx']: tx,
        'networking.wan.ip': addr ? addr.address.split('/')[0] : null,
        [P + 'routerLink']: 'ok'
      }
      if (o.planMiB > 0) {
        const r = accountPlan(state, { rx, tx, now: new Date(), resetDay: o.planResetDay || 1, setUsedMiB: o.setUsedMiB })
        state = r.state
        saveState()
        Object.assign(values, planValues(state.usedBytes, o.planMiB, r.periodEnd))
      }
      send(values)
      if (o.sms !== false) await pollSms(o).catch((e) => app.error(`SMS: ${e.message}`))
      app.setPluginStatus(`${values[P + 'connectionText']} ${values[P + 'connectionType'] || ''} RSRP ${values[P + 'rsrp'] ?? '?'} dBm` +
        (o.planMiB > 0 ? `, plan ${Math.round(values[P + 'plan.usedRatio'] * 100)} %` : ''))
    } catch (e) {
      const link = e.status === 401 ? 'auth-failed' : 'unreachable'
      // last good counters stay in state; usage made while unreachable is counted on the next good poll
      send({ ...Object.fromEntries(SIGNAL_PATHS.map((p) => [p, null])), [P + 'routerLink']: link })
      app.setPluginError(`${link}: ${e.message}`)
    } finally {
      busy = false
    }
  }

  plugin.start = function (options) {
    const o = { planWarnRatio: 0.8, planAlarmRatio: 0.95, ...options }
    const dir = app.getDataDirPath()
    stateFile = path.join(dir, 'state.json')
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { state = {} }
    app.handleMessage(plugin.id, { updates: [{ meta: Object.entries(buildMeta(o)).map(([p, value]) => ({ path: p, value })) }] })
    send({ [P + 'routerLink']: 'connecting' })
    poll(o)
    timer = setInterval(() => poll(o), Math.max(10, o.intervalSeconds || 60) * 1000)
  }

  plugin.stop = function () {
    clearInterval(timer)
  }

  return plugin
}

module.exports._test = { mapMonitor, radioQuality, parseDuration, periodBounds, accountPlan, planValues, groupSms }
