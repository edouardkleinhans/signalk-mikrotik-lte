'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { mapMonitor, radioQuality, parseDuration, periodBounds, accountPlan, planValues, groupSms } = require('..')._test

// Real RouterOS 7.23.8 / R11e-LTE response (identifiers replaced by fake values).
const MON = { 'access-technology': 'LTE', cqi: '15', 'current-cellid': '12345678', 'current-operator': 'Orange F', earfcn: '3000 (band 7, bandwidth 20Mhz)', 'phy-cellid': '101', roaming: 'true', rsrp: '-73', rsrq: '-7', sinr: '23', status: 'registered', 'session-uptime': '3d11h29m9s' }

test('registered monitor maps to networking.lte.* convention', () => {
  const v = mapMonitor(MON)
  assert.strictEqual(v['networking.lte.rsrp'], -73)
  assert.strictEqual(v['networking.lte.connectionText'], 'Orange F')
  assert.strictEqual(v['networking.lte.registerNetworkDisplay'], 'Orange F')
  assert.strictEqual(v['networking.lte.connectionType'], 'LTE')
  assert.strictEqual(v['networking.lte.curBand'], 7)
  assert.strictEqual(v['networking.lte.pci'], 101)
  assert.strictEqual(v['networking.lte.roaming'], true)
  assert.strictEqual(v['networking.lte.rssi'], null)
  assert.strictEqual(v['networking.lte.radioQuality'], 1) // RSRP -73 and SINR 23 both above "good"
  assert.strictEqual(v['networking.lte.bars'], 5)
  assert.strictEqual(v['networking.modem.uptime'], 300549)
})

test('no service clears radio values instead of keeping stale ones', () => {
  const v = mapMonitor({ status: 'searching', rsrp: '-90' })
  assert.strictEqual(v['networking.lte.rsrp'], null)
  assert.strictEqual(v['networking.lte.roaming'], null)
  assert.strictEqual(v['networking.lte.connectionText'], 'No service')
})

test('radioQuality takes the worse of RSRP and SINR', () => {
  assert.strictEqual(radioQuality(-100, 20), 0.5)
  assert.strictEqual(radioQuality(-70, 5), 0.25)
  assert.strictEqual(radioQuality(undefined, undefined), undefined)
  assert.strictEqual(parseDuration('1w2h'), 612000)
})

test('plan period clamps the reset day to short months', () => {
  const { start, end } = periodBounds(new Date(2026, 1, 15), 31)
  assert.deepStrictEqual([start.getMonth(), start.getDate(), end.getMonth(), end.getDate()], [0, 31, 1, 28])
  const b = periodBounds(new Date(2026, 10, 4, 7), 1)
  assert.deepStrictEqual([b.start.getMonth(), b.start.getDate(), b.end.getMonth(), b.end.getDate()], [10, 1, 11, 1])
})

test('plan accounting survives router reboot, applies correction once, resets with the period', () => {
  const now = new Date(2026, 10, 4)
  let s = accountPlan({}, { rx: 1000, tx: 500, now, resetDay: 1 }).state
  assert.strictEqual(s.usedBytes, 0)
  s = accountPlan(s, { rx: 1500, tx: 700, now, resetDay: 1 }).state
  assert.strictEqual(s.usedBytes, 700)
  s = accountPlan(s, { rx: 100, tx: 50, now, resetDay: 1 }).state // reboot: counters restart
  assert.strictEqual(s.usedBytes, 850)
  s = accountPlan(s, { rx: 100, tx: 50, now, resetDay: 1, setUsedMiB: 727 }).state
  assert.strictEqual(s.usedBytes, 727 * 1048576)
  s = accountPlan(s, { rx: 200, tx: 50, now, resetDay: 1, setUsedMiB: 727 }).state // not re-applied
  assert.strictEqual(s.usedBytes, 727 * 1048576 + 100)
  s = accountPlan(s, { rx: 300, tx: 50, now: new Date(2026, 11, 1, 0, 5), resetDay: 1, setUsedMiB: 727 }).state
  assert.strictEqual(s.usedBytes, 0)
  const v = planValues(1048576 * 10, 100, new Date(2026, 11, 1))
  assert.strictEqual(v['networking.lte.plan.usedRatio'], 0.1)
  assert.strictEqual(v['networking.lte.plan.remainingBytes'], 1048576 * 90)
})

test('multi-part SMS are joined in id order and sorted by time', () => {
  const m = groupSms([
    { '.id': '*CA', phone: 'Orange', timestamp: '2026-06-04 13:40:37+00:00', message: 'world' },
    { '.id': '*C9', phone: 'Orange', timestamp: '2026-06-04 13:40:37+00:00', message: 'hello ' },
    { '.id': '*D0', phone: '+33600000000', timestamp: '2026-10-23 15:11:00+00:00', message: 'quota' }
  ])
  assert.strictEqual(m.length, 2)
  assert.strictEqual(m[0].text, 'hello world')
  assert.strictEqual(m[1].time.toISOString(), '2026-10-23T15:11:00.000Z')
})
