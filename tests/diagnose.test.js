import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/diagnose.js';

const NOW = 1_000_000;
const beat = (over = {}) => ({ ready: true, frequencyMHz: 433, sf: 9, bandwidthKHz: 125, rx: 0, lost: 0, acks: 0, unknown: 0, lastUnknown: '', uptimeS: 10, rstPin: 14, timestamp: NOW - 1000, ...over });
const loraPkt = (over = {}) => ({ node: 'FS01', seq: 3, distanceCm: 140, rssi: -60, snr: 9, lost: 0, source: 'lora', lora: null, medium: 'water',
  samples: { valid: 38, pings: 40, minCm: 135, maxCm: 146 }, gps: { fix: false, lat: null, lng: null, satellites: 0, chars: 3000 }, timestamp: NOW - 2000, ...over });
const usbPkt = (lora, over = {}) => loraPkt({ source: 'usb', rssi: null, snr: null, lora: { ready: true, sent: 5, acked: 0, ackOk: false, stationRssi: null, rstPin: 14, ...lora }, ...over });
const run = over => diagnose({ status: 'connected', station: null, packets: [], now: NOW, connectedAt: NOW - 60000, floating: true, ...over });

test('blames the ground station when its radio did not start', () => {
  const r = run({ station: beat({ ready: false, rstPin: -1 }) });
  assert.equal(r.verdict.state, 'fail'); assert.match(r.verdict.text, /GROUND STATION/);
});
test('ground station fine but silent node points at the flood sensor', () => {
  const r = run({ station: beat() });
  assert.match(r.verdict.text, /FLOOD SENSOR/);
});
test('wrong COM port / sketch: connected but no station status', () => {
  assert.match(run({}).verdict.text, /wrong COM port/);
});
test('everything working over LoRa', () => {
  const r = run({ station: beat({ rx: 3, acks: 3 }), packets: [loraPkt({ seq: 2, timestamp: NOW - 12000, gps: { fix: false, lat: null, lng: null, satellites: 0, chars: 2000 } }), loraPkt()] });
  assert.notEqual(r.verdict.state, 'fail');
  assert.equal(r.fs.find(x => x.label.startsWith('GPS module')).state, 'ok');
});
test('GPS with zero bytes is flagged on the flood sensor', () => {
  const r = run({ station: beat({ rx: 1 }), packets: [loraPkt({ gps: { fix: false, lat: null, lng: null, satellites: 0, chars: 0 } })] });
  assert.equal(r.fs.find(x => x.label.startsWith('GPS module')).state, 'fail');
  assert.match(r.verdict.text, /sensor on the FLOOD SENSOR/);
});
test('node on USB with no ACKs points at the ground station side', () => {
  const r = run({ packets: [usbPkt({ sent: 6, acked: 0 })] });
  assert.match(r.verdict.text, /GROUND STATION side/);
});
test('node on USB with a dead radio blames the flood sensor', () => {
  const r = run({ packets: [usbPkt({ ready: false, sent: 0, rstPin: -1 })] });
  assert.match(r.verdict.text, /FLOOD SENSOR: its LoRa radio/);
});

test('sound-speed conversion: air-calibrated in, water or air out, old firmware undone', async () => {
  const { toAirCalibrated, speedFactor, inMedium } = await import('../src/measure.js');
  const air = { distanceCm: 90, medium: 'air', samples: { valid: 3, pings: 4, minCm: 89, maxCm: 91 } };
  assert.equal(inMedium(air, speedFactor('air', 1480)).distanceCm, 90);
  assert.ok(Math.abs(inMedium(air, speedFactor('water', 1480)).distanceCm - 90 * 1480 / 343) < 1e-9);
  assert.ok(Math.abs(inMedium(air, speedFactor('water', 1480)).samples.maxCm - 91 * 1480 / 343) < 1e-9);
  const old = toAirCalibrated({ distanceCm: 388.3, medium: 'water', samples: null });   // old sketch converted itself
  assert.ok(Math.abs(old.distanceCm - 90) < 0.1); assert.equal(old.medium, 'air');
  assert.equal(toAirCalibrated({ distanceCm: null, medium: 'water', samples: null }).distanceCm, null);
  assert.equal(speedFactor('water', 'abc'), 1480 / 343);
});
