'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { mapMonitor, mapInterface, toValues } = require('..')._test

// Real RouterOS 7.23.8 / R11e-LTE responses (identifiers trimmed).
const MON = { 'access-technology': 'LTE', cqi: '15', 'current-cellid': '20604929', 'current-operator': 'Orange F', earfcn: '3000 (band 7, bandwidth 20Mhz)', roaming: 'true', rsrp: '-73', rsrq: '-7', sinr: '23', status: 'registered' }

test('monitor values become typed Signal K values', () => {
  assert.deepStrictEqual(mapMonitor(MON), {
    status: 'registered', operator: 'Orange F', roaming: true, accessTechnology: 'LTE', band: 7, cellId: '20604929', rsrp: -73, rsrq: -7, sinr: 23, rssi: undefined, cqi: 15
  })
})

test('interface counters and missing fields are dropped from the delta', () => {
  const v = toValues({ ...mapMonitor({ status: 'searching' }), ...mapInterface({ running: 'false', 'rx-byte': '4351011638', 'tx-byte': '935519202' }) })
  assert.deepStrictEqual(v, [
    { path: 'mikrotik.lte.status', value: 'searching' },
    { path: 'mikrotik.lte.running', value: false },
    { path: 'mikrotik.lte.rxBytes', value: 4351011638 },
    { path: 'mikrotik.lte.txBytes', value: 935519202 }
  ])
})
