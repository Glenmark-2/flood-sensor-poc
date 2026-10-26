import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReading, LineBuffer, SerialSensor } from '../src/serialSensor.js';

test('accepts measured distances and rejects missing or invalid measurements', () => {
  assert.deepEqual(parseReading('{"distanceCm":42.3}', 123), { distanceCm:42.3, timestamp:123 });
  for (const line of ['boot log', '{}', 'null', '{"distanceCm":"42"}', '{"distanceCm":0}', '{"distanceCm":-1}', '{"distanceCm":1e999}', '{"error":"no_echo"}']) assert.throws(() => parseReading(line));
});
test('handles split lines, CRLF, multiple lines, and oversized input recovery', () => {
  const buffer = new LineBuffer(); const lines = []; const errors = [];
  const push = text => buffer.push(text, line => lines.push(line), error => errors.push(error));
  push('{"distance'); push('Cm":42}\r\n\n{"distanceCm":43}\n');
  assert.deepEqual(lines, ['{"distanceCm":42}', '{"distanceCm":43}']);
  push('x'.repeat(5000)); push('\n{"distanceCm":44}\n');
  assert.equal(errors.length, 1); assert.equal(lines.at(-1), '{"distanceCm":44}');
});
test('accepts the verified firmware distance line without guessing unrelated numbers', () => {
  assert.deepEqual(parseReading('Distance: 60.69 cm', 123), {distanceCm:60.69, timestamp:123});
  assert.equal(parseReading(' Distance: 61 cm\r ').distanceCm, 61);
  for (const line of ['Distance: 0 cm', 'Distance: -2 cm', 'Distance: NaN cm', 'Distance: 60.69 mm', 'boot 60.69', 'debug Distance: 60.69 cm', 'Distance: 60.69 cm extra']) assert.throws(() => parseReading(line));
});
test('disconnect cancels the pending read, releases the lock and closes the port', async () => {
  let finish; const events = []; const readings = [];
  let first = true;
  const reader = { read: async () => first ? (first = false, {value:new TextEncoder().encode('{"distanceCm":42}\n')}) : new Promise(resolve => { finish = resolve; }), cancel: async () => { events.push('cancel'); finish({done:true}); }, releaseLock: () => events.push('release') };
  const port = { open: async options => assert.equal(options.baudRate, 115200), readable:{getReader:() => reader}, close:async () => events.push('close'), getInfo:() => ({usbVendorId:1}) };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{serial:{requestPort:async () => port}}});
  try {
    const sensor = new SerialSensor({onReading:r => readings.push(r), onStatus:() => {}, onInvalid:message => assert.fail(message)});
    await sensor.connect(); await new Promise(resolve => setImmediate(resolve)); await sensor.disconnect();
    assert.equal(readings.length,1); assert.deepEqual(events,['cancel','release','close']); assert.equal(sensor.port,null);
  } finally { if(original) Object.defineProperty(globalThis,'navigator',original); else delete globalThis.navigator; }
});

// Hardware telemetry must not become a water-level reading.
test('validates hardware status, no-fix data, and GPS coordinate bounds', async () => {
  const { parseHardware } = await import('../src/serialSensor.js');
  const data = {type:'hardware', gps:{fix:false,chars:120,sentences:2,satellites:0,lat:null,lng:null},lora:{ready:true,frequencyMHz:433,tx:1,rx:0,rssi:null,lastPacket:''}};
  assert.equal(parseHardware(JSON.stringify(data),123).timestamp,123);
  assert.throws(() => parseReading(JSON.stringify(data)));
  data.gps.fix = true;
  assert.throws(() => parseHardware(JSON.stringify(data)));
  data.gps.lat = 1.3; data.gps.lng = 103.8;
  assert.equal(parseHardware(JSON.stringify(data)).gps.lat,1.3);
  data.gps.lat = 91;
  assert.throws(() => parseHardware(JSON.stringify(data)));
  data.gps.lat = 1.3; data.lora.tx = -1;
  assert.throws(() => parseHardware(JSON.stringify(data)));
});

// LoRa ground station output (firmware/ground_station).
test('parses ground-station node packets, including no-fix and no-echo', async () => {
  const { parseNode } = await import('../src/serialSensor.js');
  const packet = {type:'node',node:'FS01',seq:12,distanceCm:54.3,gps:{fix:true,lat:14.651234,lng:121.049876,satellites:7,chars:48211},rssi:-62,snr:9.5,lost:0};
  const parsed = parseNode(JSON.stringify(packet), 5);
  assert.equal(parsed.distanceCm, 54.3); assert.equal(parsed.gps.lat, 14.651234); assert.equal(parsed.timestamp, 5);
  assert.throws(() => parseReading(JSON.stringify(packet)));
  const noFix = {...packet, distanceCm:null, gps:{fix:false,lat:null,lng:null,satellites:0,chars:0}};
  assert.equal(parseNode(JSON.stringify(noFix)).distanceCm, null);
  assert.equal(parseNode(JSON.stringify(noFix)).gps.lat, null);
  for (const bad of [{...packet,node:'FS-01'}, {...packet,node:'TOOLONGID9'}, {...packet,seq:0}, {...packet,distanceCm:0}, {...packet,distanceCm:'54'},
    {...packet,gps:{...packet.gps,lat:91}}, {...packet,gps:{...packet.gps,lat:null}}, {...packet,rssi:null}, {...packet,lost:-1}]) assert.throws(() => parseNode(JSON.stringify(bad)));
});
test('parses the ground-station heartbeat', async () => {
  const { parseStation } = await import('../src/serialSensor.js');
  const beat = {type:'station',ready:true,frequencyMHz:433,sf:9,bandwidthKHz:125,rx:12,lost:1,acks:12,unknown:0,lastUnknown:'',uptimeS:130};
  assert.equal(parseStation(JSON.stringify(beat), 7).rx, 12);
  assert.equal(parseStation(JSON.stringify({...beat, ready:false})).ready, false);
  for (const bad of [{...beat,ready:'yes'}, {...beat,rx:-1}, {...beat,sf:9.5}, {...beat,lastUnknown:null}]) assert.throws(() => parseStation(JSON.stringify(bad)));
});
test('routes station and node lines to their own callbacks, never to water readings', async () => {
  let finish; const seen = [];
  const lines = '{"type":"station","ready":true,"frequencyMHz":433,"sf":9,"bandwidthKHz":125,"rx":0,"lost":0,"acks":0,"unknown":0,"lastUnknown":"","uptimeS":1}\n' +
    '{"type":"node","node":"FS01","seq":1,"distanceCm":80.5,"gps":{"fix":false,"lat":null,"lng":null,"satellites":0,"chars":0},"rssi":-70,"snr":8,"lost":0}\n';
  let first = true;
  const reader = { read: async () => first ? (first = false, {value:new TextEncoder().encode(lines)}) : new Promise(resolve => { finish = resolve; }), cancel: async () => finish({done:true}), releaseLock: () => {} };
  const port = { open: async () => {}, readable:{getReader:() => reader}, close:async () => {}, getInfo:() => ({}) };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{serial:{requestPort:async () => port}}});
  try {
    const sensor = new SerialSensor({onReading:() => seen.push('reading'), onStation:() => seen.push('station'), onNode:n => seen.push(`node ${n.distanceCm}`), onStatus:() => {}, onInvalid:message => assert.fail(message)});
    await sensor.connect(); await new Promise(resolve => setImmediate(resolve)); await sensor.disconnect();
    assert.deepEqual(seen, ['station', 'node 80.5']);
  } finally { if(original) Object.defineProperty(globalThis,'navigator',original); else delete globalThis.navigator; }
});

test('explains when the flood node (not the ground station) is connected', async () => {
  let finish; const messages = [];
  let first = true;
  const reader = { read: async () => first ? (first = false, {value:new TextEncoder().encode('  Link 0/5 acked\n')}) : new Promise(resolve => { finish = resolve; }), cancel: async () => finish({done:true}), releaseLock: () => {} };
  const port = { open: async () => {}, readable:{getReader:() => reader}, close:async () => {}, getInfo:() => ({}) };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {configurable:true,value:{serial:{requestPort:async () => port}}});
  try {
    const sensor = new SerialSensor({onReading:() => assert.fail('not a reading'), onStatus:() => {}, onInvalid:message => messages.push(message)});
    await sensor.connect(); await new Promise(resolve => setImmediate(resolve)); await sensor.disconnect();
    assert.match(messages[0], /GROUND STATION/);
  } finally { if(original) Object.defineProperty(globalThis,'navigator',original); else delete globalThis.navigator; }
});

test('accepts the node connected directly by USB, with or without an ACK', async () => {
  const { parseNode } = await import('../src/serialSensor.js');
  const usb = {type:'node',source:'usb',node:'FS01',seq:3,distanceCm:72.4,gps:{fix:false,lat:null,lng:null,satellites:4,chars:9120},rssi:null,snr:null,lost:0,lora:{ready:true,sent:3,acked:0,ackOk:false,stationRssi:null}};
  const parsed = parseNode(JSON.stringify(usb));
  assert.equal(parsed.source, 'usb'); assert.equal(parsed.rssi, null); assert.equal(parsed.lora.sent, 3);
  assert.equal(parseNode(JSON.stringify({...usb, rssi:-55, snr:9.5, lora:{...usb.lora, acked:1, ackOk:true, stationRssi:-57}})).lora.stationRssi, -57);
  assert.equal(parseNode(JSON.stringify({...usb, lora:{...usb.lora, ready:false, sent:0}})).lora.ready, false);
  for (const bad of [{...usb, lora:undefined}, {...usb, source:'wifi'}, {...usb, lora:{...usb.lora, sent:-1}}, {...usb, source:undefined}]) assert.throws(() => parseNode(JSON.stringify(bad)));
});

test('passes through the measuring medium reported by the floating node', async () => {
  const { parseNode } = await import('../src/serialSensor.js');
  const usb = {type:'node',source:'usb',medium:'water',node:'FS01',seq:1,distanceCm:112.4,gps:{fix:false,lat:null,lng:null,satellites:0,chars:10},rssi:null,snr:null,lost:0,lora:{ready:true,sent:1,acked:0,ackOk:false,stationRssi:null}};
  assert.equal(parseNode(JSON.stringify(usb)).medium, 'water');
  assert.equal(parseNode(JSON.stringify({...usb, medium:undefined})).medium, null);
  assert.throws(() => parseNode(JSON.stringify({...usb, medium:'oil'})));
});

test('accepts the per-window sample summary and rejects impossible counts', async () => {
  const { parseNode } = await import('../src/serialSensor.js');
  const usb = {type:'node',source:'usb',medium:'water',node:'FS01',seq:1,distanceCm:112.4,gps:{fix:false,lat:null,lng:null,satellites:0,chars:10},samples:{valid:38,pings:40,minCm:108.2,maxCm:117.9},rssi:null,snr:null,lost:0,lora:{ready:true,sent:1,acked:0,ackOk:false,stationRssi:null}};
  assert.equal(parseNode(JSON.stringify(usb)).samples.valid, 38);
  assert.equal(parseNode(JSON.stringify({...usb, distanceCm:null, samples:{valid:0,pings:40,minCm:null,maxCm:null}})).samples.pings, 40);
  assert.throws(() => parseNode(JSON.stringify({...usb, samples:{valid:41,pings:40,minCm:1,maxCm:2}})));
});

test('recognises ESP32 boot text so it is not reported as bad data', async () => {
  const { isBootLine } = await import('../src/serialSensor.js');
  for (const line of ['ets Jun  8 2016 00:22:57', 'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)', 'configsip: 0, SPIWP:0xee', 'clk_drv:0x00,q_drv:0x00,d_drv:0x00', 'mode:DIO, clock div:1', 'load:0x3fff0030,len:1184', 'ho 0 tail 12 room 4', 'entry 0x400805b4']) assert.ok(isBootLine(line), line);
  for (const line of ['{"type":"station"}', 'Distance: 60.69 cm', 'entry point']) assert.ok(!isBootLine(line), line);
});
test('accepts the RST pin the radio was found on', async () => {
  const { parseStation } = await import('../src/serialSensor.js');
  const beat = {type:'station',ready:false,frequencyMHz:433,sf:9,bandwidthKHz:125,rx:0,lost:0,acks:0,unknown:0,lastUnknown:'',uptimeS:5,rstPin:-1};
  assert.equal(parseStation(JSON.stringify(beat)).rstPin, -1);
  assert.equal(parseStation(JSON.stringify({...beat, ready:true, rstPin:2})).rstPin, 2);
});

test('treats the unreadable burst at reset as boot noise', async () => {
  const { isBootLine } = await import('../src/serialSensor.js');
  assert.ok(isBootLine('� � � � � � � � � �'.replace(/ /g, '')));
  assert.ok(!isBootLine('{"type":"station","ready":true}'));
});
test('reset noise with spaces between bytes is also ignored', async () => {
  const { isBootLine } = await import('../src/serialSensor.js');
  assert.ok(isBootLine(Array(40).fill('�').join(' ')));
});
