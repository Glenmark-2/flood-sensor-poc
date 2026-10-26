// Health check logic for the System check panel (kept free of JSX so it can be unit-tested).
// state: 'ok' (green) · 'warn' (amber) · 'fail' (red) · 'idle' (grey, unknown yet)

// A node sends every ~10 s; allow two missed packets before calling it stale.
export const NODE_STALE_MS = 25000;
export const STATION_STALE_MS = 6000;

export function quality(rssi) {
  if (rssi == null) return null;
  return rssi > -90 ? 'Excellent' : rssi > -105 ? 'Good' : rssi > -115 ? 'Weak' : 'Very weak';
}

const secs = ms => `${Math.max(0, Math.round(ms / 1000))} s`;

export function diagnose({ status, station, packets, now, connectedAt }) {
  const connected = status === 'connected';
  const sinceConnect = connected && connectedAt ? now - connectedAt : 0;
  const last = packets.at(-1);
  const prev = packets.at(-2);
  const viaUsb = last?.source === 'usb';
  const stationLive = connected && station && now - station.timestamp < STATION_STALE_MS;
  const nodeAge = last ? now - last.timestamp : null;
  const nodeLive = connected && last && nodeAge < NODE_STALE_MS;
  const usbLora = viaUsb ? last.lora : null;

  const gs = [];   // ground station rows
  const fs = [];   // flood sensor rows

  // ---------------- Ground station ----------------
  if (viaUsb) {
    gs.push({ label: 'Plugged into this laptop', state: 'idle', detail: 'No — the flood sensor is plugged in instead (bench test)' });
    gs.push(usbLora.acked > 0
      ? { label: 'Answering the flood sensor', state: usbLora.ackOk ? 'ok' : 'warn', detail: `${usbLora.acked}/${usbLora.sent} packets ACKed${usbLora.stationRssi != null ? ` · it hears the sensor at ${usbLora.stationRssi} dBm` : ''}` }
      : { label: 'Answering the flood sensor', state: usbLora.ready && usbLora.sent >= 2 ? 'fail' : 'idle', detail: usbLora.ready ? `0/${usbLora.sent} packets ACKed — ground station off, its radio not working, wrong sketch, or out of range` : 'Unknown (flood sensor radio is not working)' });
  } else {
    gs.push(!connected ? { label: 'Plugged into this laptop', state: 'idle', detail: 'Not connected — click Connect Sensor' }
      : stationLive ? { label: 'Plugged in & running ground_station.ino', state: 'ok', detail: `Status received ${secs(now - station.timestamp)} ago` }
      : station ? { label: 'Plugged in & running ground_station.ino', state: 'fail', detail: `No status for ${secs(now - station.timestamp)} — board reset, unplugged or crashed` }
      : sinceConnect > STATION_STALE_MS ? { label: 'Plugged in & running ground_station.ino', state: 'fail', detail: 'Connected, but no ground-station status — wrong COM port, or ground_station.ino is not uploaded' }
      : { label: 'Plugged in & running ground_station.ino', state: 'idle', detail: 'Waiting for its first status message…' });
    gs.push(!station ? { label: 'LoRa radio (Ra-02)', state: 'idle', detail: '—' }
      : station.ready ? { label: 'LoRa radio (Ra-02)', state: 'ok', detail: `Started${station.rstPin != null && station.rstPin >= 0 ? ` · RST on D${station.rstPin}` : ''} · ${station.frequencyMHz} MHz SF${station.sf}` }
      : { label: 'LoRa radio (Ra-02)', state: 'fail', detail: station.rstPin == null
          ? 'Did not start. This board runs an OLDER ground_station.ino (only tries RST on D14) — upload the latest one, then check Ra-02 3.3V, GND, NSS D5, SCK D18, MISO D19, MOSI D23'
          : 'Did not start (tried RST on D14 and D2) — check Ra-02 3.3V, GND, NSS D5, SCK D18, MISO D19, MOSI D23. Quick test: swap Ra-02 modules with the flood sensor' });
    const heard = station ? station.rx - station.unknown : 0;
    gs.push(!station?.ready ? { label: 'Receiving the flood sensor', state: 'idle', detail: '—' }
      : nodeLive ? { label: 'Receiving the flood sensor', state: 'ok', detail: `${heard} packets · last ${secs(nodeAge)} ago · ${last.rssi} dBm (${quality(last.rssi)})` }
      : last ? { label: 'Receiving the flood sensor', state: 'fail', detail: `Nothing for ${secs(nodeAge)} (expected every ~10 s)` }
      : { label: 'Receiving the flood sensor', state: sinceConnect > NODE_STALE_MS ? 'fail' : 'idle', detail: sinceConnect > NODE_STALE_MS ? `Nothing heard in ${secs(sinceConnect)}` : 'Listening… (sensor sends every ~10 s)' });
    if (station?.unknown > 0) gs.push({ label: 'Other LoRa packets', state: 'warn', detail: `${station.unknown} not from flood_node.ino (e.g. an old test sketch): “${station.lastUnknown}”` });
    if (station?.ready && station.lost > 0) {
      const pct = station.lost / (heard + station.lost) * 100;
      gs.push({ label: 'Packet loss', state: pct > 20 ? 'warn' : 'ok', detail: `${station.lost} lost (${pct.toFixed(0)}%)` });
    }
  }

  // ---------------- Flood sensor ----------------
  if (!last) {
    fs.push({ label: 'Running & sending', state: 'idle', detail: viaUsb ? '—' : stationLive && station.ready ? 'Not heard yet. To test it directly, plug the flood sensor into the laptop and connect to it.' : 'Unknown until the ground station is working' });
  } else {
    fs.push(nodeLive ? { label: 'Running & sending', state: 'ok', detail: `${last.node} · reading #${last.seq} · ${viaUsb ? 'via USB' : 'via LoRa'}` }
      : { label: 'Running & sending', state: 'fail', detail: `Silent for ${secs(nodeAge)} — power, reset or (via LoRa) out of range` });
    fs.push(viaUsb ? (usbLora.ready ? { label: 'LoRa radio (Ra-02)', state: 'ok', detail: `Started${usbLora.rstPin != null && usbLora.rstPin >= 0 ? ` · RST on D${usbLora.rstPin}` : ''} · ${usbLora.sent} packets sent` }
        : { label: 'LoRa radio (Ra-02)', state: 'fail', detail: 'Did not start — check Ra-02 3.3V, GND, NSS D5, SCK D18, MISO D19, MOSI D23, RST D14' })
      : { label: 'LoRa radio (Ra-02)', state: 'ok', detail: 'Working — the ground station hears it' });
    const s = last.samples;
    fs.push(last.distanceCm == null ? { label: 'JSN-SR04T (water depth)', state: 'fail', detail: `No echo${s ? ` in ${s.pings} pings` : ''} — wiring (TRIG D32, ECHO D33, 5V), or water shallower than ~1 m when floating` }
      : { label: 'JSN-SR04T (water depth)', state: s && s.valid < s.pings / 2 ? 'warn' : 'ok', detail: `${last.distanceCm.toFixed(1)} cm${s ? ` · echo on ${s.valid}/${s.pings} pings` : ''}` });
    const gps = last.gps;
    const growing = prev ? gps.chars > prev.gps.chars : gps.chars > 0;
    fs.push(gps.chars === 0 ? { label: 'GPS module (NEO-6M)', state: 'fail', detail: 'No data at all — GPS TX → D16 (RX2), VCC → VIN, GND, or loose jumper' }
      : !growing ? { label: 'GPS module (NEO-6M)', state: 'warn', detail: `Data stopped at ${gps.chars} bytes` }
      : { label: 'GPS module (NEO-6M)', state: 'ok', detail: `Sending data (${gps.chars} bytes)` });
    fs.push(gps.fix ? { label: 'GPS position fix', state: 'ok', detail: `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} · ${gps.satellites} satellites` }
      : { label: 'GPS position fix', state: gps.chars ? 'warn' : 'idle', detail: gps.chars ? `No fix yet (${gps.satellites} satellites) — normal indoors, needs open sky` : '—' });
  }

  // ---------------- Verdict ----------------
  let verdict;
  if (!connected) verdict = { state: 'idle', text: 'Connect the ground station (or the flood sensor for a bench test) to run the check.' };
  else if (viaUsb) {
    if (!usbLora.ready) verdict = { state: 'fail', text: 'Problem is on the FLOOD SENSOR: its LoRa radio did not start.' };
    else if (usbLora.acked === 0 && usbLora.sent >= 2) verdict = { state: 'fail', text: 'Flood sensor radio works, but nothing answers → the problem is on the GROUND STATION side (not running ground_station.ino, its radio, or too far/close). Plug the ground station in to check it.' };
    else verdict = fs.some(r => r.state === 'fail') ? { state: 'fail', text: 'Radio link OK. Problem is a sensor on the FLOOD SENSOR (see the red items).' } : { state: 'ok', text: 'Flood sensor and radio link are working.' };
  } else if (!station) verdict = sinceConnect > STATION_STALE_MS ? { state: 'fail', text: 'This port is not sending ground-station data → GROUND STATION: wrong COM port or ground_station.ino not uploaded.' } : { state: 'idle', text: 'Checking…' };
  else if (!stationLive) verdict = { state: 'fail', text: 'GROUND STATION stopped responding (reset, unplugged or crashed).' };
  else if (!station.ready) verdict = { state: 'fail', text: 'Problem is on the GROUND STATION: its LoRa radio did not start (wiring/power).' };
  else if (!last) verdict = sinceConnect > NODE_STALE_MS
    ? { state: 'fail', text: 'Ground station is fine but hears nothing → likely the FLOOD SENSOR (power, its radio, wrong sketch) or the antennas/distance. Plug the flood sensor into the laptop to test it directly.' }
    : { state: 'idle', text: 'Ground station OK · waiting for the first packet from the flood sensor (~10 s)…' };
  else if (!nodeLive) verdict = { state: 'fail', text: 'Ground station OK, but the FLOOD SENSOR went silent (power, reset, or out of range).' };
  else verdict = fs.some(r => r.state === 'fail') ? { state: 'fail', text: 'Ground station and radio link OK. Problem is a sensor on the FLOOD SENSOR (see the red items).' }
    : { state: fs.some(r => r.state === 'warn') ? 'warn' : 'ok', text: fs.some(r => r.state === 'warn') ? 'Everything is talking. Amber rows are worth a look but not blocking.' : 'Everything is working: flood sensor → LoRa → ground station → dashboard.' };

  return { gs, fs, verdict, viaUsb };
}

