'use strict'
// Signal K plugin: polls a MikroTik RouterOS v7 LTE interface over the REST API
// and publishes radio quality, operator and data counters under mikrotik.lte.*.

const https = require('https')

const NUM = (v) => (v === undefined || v === '' || isNaN(Number(v)) ? undefined : Number(v))

const META = {
  rsrp: { units: 'dBm', description: 'LTE Reference Signal Received Power' },
  rsrq: { units: 'dB', description: 'LTE Reference Signal Received Quality' },
  sinr: { units: 'dB', description: 'LTE Signal to Interference plus Noise Ratio' },
  rssi: { units: 'dBm', description: 'Received Signal Strength Indicator' },
  cqi: { description: 'Channel Quality Indicator (0-15)' },
  rxBytes: { units: 'bytes', description: 'Bytes received on the LTE interface since router boot' },
  txBytes: { units: 'bytes', description: 'Bytes sent on the LTE interface since router boot' }
}

// RouterOS REST returns every value as a string; map to typed Signal K values.
function mapMonitor (m) {
  const band = /band (\d+)/.exec(m.earfcn || '')
  return {
    status: m.status,
    operator: m['current-operator'],
    roaming: m.roaming === undefined ? undefined : m.roaming === 'true',
    accessTechnology: m['access-technology'],
    band: band ? Number(band[1]) : undefined,
    cellId: m['current-cellid'],
    rsrp: NUM(m.rsrp),
    rsrq: NUM(m.rsrq),
    sinr: NUM(m.sinr),
    rssi: NUM(m.rssi),
    cqi: NUM(m.cqi)
  }
}

function mapInterface (i) {
  return { running: i.running === 'true', rxBytes: NUM(i['rx-byte']), txBytes: NUM(i['tx-byte']) }
}

function toValues (obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ path: `mikrotik.lte.${k}`, value: v }))
}

function request (o, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = https.request({
      host: o.host,
      port: o.port || 443,
      method,
      path: `/rest/${path}`,
      auth: `${o.username}:${o.password}`,
      rejectUnauthorized: !!o.rejectUnauthorized,
      timeout: 20000,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${method} ${path}: HTTP ${res.statusCode} ${buf.slice(0, 200)}`))
        try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timeout`)))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

module.exports = function (app) {
  let timer
  let metaSent = false
  const plugin = {
    id: 'signalk-mikrotik-lte',
    name: 'MikroTik LTE',
    description: 'LTE signal, operator and data counters from a MikroTik RouterOS v7 router (REST API)'
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
      rejectUnauthorized: { type: 'boolean', title: 'Verify TLS certificate (off for self-signed)', default: false }
    }
  }

  async function poll (o) {
    const iface = o.interface || 'lte1'
    try {
      const [mon] = await request(o, 'POST', 'interface/lte/monitor', { numbers: iface, once: '' })
      const [ifc] = await request(o, 'GET', `interface?name=${encodeURIComponent(iface)}&.proplist=running,rx-byte,tx-byte`)
      if (!metaSent) {
        app.handleMessage(plugin.id, { updates: [{ meta: Object.entries(META).map(([k, v]) => ({ path: `mikrotik.lte.${k}`, value: v })) }] })
        metaSent = true
      }
      app.handleMessage(plugin.id, { updates: [{ values: toValues({ ...mapMonitor(mon || {}), ...mapInterface(ifc || {}) }) }] })
      app.setPluginStatus(`${mon?.['current-operator'] || '?'} ${mon?.['access-technology'] || ''} RSRP ${mon?.rsrp ?? '?'} dBm`)
    } catch (e) {
      app.setPluginError(e.message)
    }
  }

  plugin.start = function (options) {
    const o = { ...options }
    poll(o)
    timer = setInterval(() => poll(o), Math.max(10, o.intervalSeconds || 60) * 1000)
  }

  plugin.stop = function () {
    clearInterval(timer)
    metaSent = false
  }

  return plugin
}

module.exports._test = { mapMonitor, mapInterface, toValues }
