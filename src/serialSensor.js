export function parseHardware(line, timestamp = Date.now()) {
  const data = JSON.parse(line);
  if (data?.type !== 'hardware' || typeof data.gps?.fix !== 'boolean' || typeof data.lora?.ready !== 'boolean') throw new Error('Invalid hardware status.');
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!count(data.gps.chars) || !count(data.gps.sentences) || !count(data.gps.satellites) || !count(data.lora.tx) || !count(data.lora.rx) || !Number.isFinite(data.lora.frequencyMHz)) throw new Error('Invalid hardware counters.');
  if (data.gps.fix && (!Number.isFinite(data.gps.lat) || Math.abs(data.gps.lat) > 90 || !Number.isFinite(data.gps.lng) || Math.abs(data.gps.lng) > 180)) throw new Error('Invalid GPS coordinates.');
  if (data.lora.rssi !== null && !Number.isFinite(data.lora.rssi)) throw new Error('Invalid RSSI.');
  if (typeof data.lora.lastPacket !== 'string' || data.lora.lastPacket.length > 255) throw new Error('Invalid packet.');
  return { gps: data.gps, lora: data.lora, timestamp };
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;

// LoRa reading forwarded by the ground station (firmware/ground_station).
export function parseNode(line, timestamp = Date.now()) {
  const data = JSON.parse(line);
  if (data?.type !== 'node' || typeof data.node !== 'string' || !/^[A-Za-z0-9]{1,8}$/.test(data.node)) throw new Error('Invalid node id.');
  if (!Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error('Invalid sequence number.');
  if (data.distanceCm !== null && (typeof data.distanceCm !== 'number' || !Number.isFinite(data.distanceCm) || data.distanceCm <= 0)) throw new Error('Invalid distance.');
  const gps = data.gps;
  if (typeof gps?.fix !== 'boolean' || !isCount(gps.satellites) || !isCount(gps.chars)) throw new Error('Invalid node GPS status.');
  if (gps.fix && (!Number.isFinite(gps.lat) || Math.abs(gps.lat) > 90 || !Number.isFinite(gps.lng) || Math.abs(gps.lng) > 180)) throw new Error('Invalid GPS coordinates.');
  // source "usb": the node itself on USB (rssi/snr = its last ACK, null if none); default: relayed by the ground station.
  const source = data.source === undefined ? 'lora' : data.source;
  if (source !== 'lora' && source !== 'usb') throw new Error('Invalid source.');
  const radio = value => source === 'usb' ? value === null || Number.isFinite(value) : Number.isFinite(value);
  if (!radio(data.rssi) || !radio(data.snr) || !isCount(data.lost)) throw new Error('Invalid radio values.');
  let lora = null;
  if (source === 'usb') {
    const l = data.lora;
    if (typeof l?.ready !== 'boolean' || typeof l.ackOk !== 'boolean' || !isCount(l.sent) || !isCount(l.acked) || (l.stationRssi !== null && !Number.isFinite(l.stationRssi))) throw new Error('Invalid node LoRa status.');
    if (l.rstPin !== undefined && !Number.isSafeInteger(l.rstPin)) throw new Error('Invalid RST pin.');
    lora = { ready: l.ready, sent: l.sent, acked: l.acked, ackOk: l.ackOk, stationRssi: l.stationRssi, rstPin: l.rstPin ?? null };
  }
  if (data.medium !== undefined && data.medium !== 'water' && data.medium !== 'air') throw new Error('Invalid medium.');
  let samples = null;   // optional: how many pings made up this median, and their spread
  if (data.samples !== undefined) {
    const s = data.samples, cm = v => v === null || (Number.isFinite(v) && v > 0);
    if (!isCount(s?.valid) || !isCount(s.pings) || s.valid > s.pings || !cm(s.minCm) || !cm(s.maxCm)) throw new Error('Invalid samples.');
    samples = { valid: s.valid, pings: s.pings, minCm: s.minCm, maxCm: s.maxCm };
  }
  return { node: data.node, seq: data.seq, distanceCm: data.distanceCm, rssi: data.rssi, snr: data.snr, lost: data.lost, source, lora, medium: data.medium ?? null, samples,
    gps: { fix: gps.fix, lat: gps.fix ? gps.lat : null, lng: gps.fix ? gps.lng : null, satellites: gps.satellites, chars: gps.chars }, timestamp };
}

// Ground station heartbeat, printed every 2 s even when no node is heard.
export function parseStation(line, timestamp = Date.now()) {
  const data = JSON.parse(line);
  if (data?.type !== 'station' || typeof data.ready !== 'boolean') throw new Error('Invalid station status.');
  if (!Number.isFinite(data.frequencyMHz) || !Number.isSafeInteger(data.sf) || !Number.isFinite(data.bandwidthKHz)) throw new Error('Invalid radio settings.');
  for (const key of ['rx', 'lost', 'acks', 'unknown', 'uptimeS']) if (!isCount(data[key])) throw new Error(`Invalid station ${key}.`);
  if (typeof data.lastUnknown !== 'string' || data.lastUnknown.length > 255) throw new Error('Invalid station packet preview.');
  if (data.rstPin !== undefined && !Number.isSafeInteger(data.rstPin)) throw new Error('Invalid RST pin.');
  const { ready, frequencyMHz, sf, bandwidthKHz, rx, lost, acks, unknown, lastUnknown, uptimeS } = data;
  return { ready, frequencyMHz, sf, bandwidthKHz, rx, lost, acks, unknown, lastUnknown, uptimeS, rstPin: data.rstPin ?? null, timestamp };
}

// Text the ESP32's ROM bootloader prints at 115200 after every reset (opening the
// port resets the board). It is expected and never a reading, so it is skipped quietly.
export const isBootLine = line => /^(ets [A-Z][a-z]{2} |rst:0x|configsip:|clk_drv:|mode:(DIO|QIO|DOUT|QOUT)|load:0x|ho \d+ tail|entry 0x)/.test(line)
  // A burst of unreadable bytes is normal while the ESP32 resets as the port opens.
  || ((t => t.length >= 8 && (t.match(/[\uFFFD\x00-\x08\x0E-\x1F]/g) || []).length / t.length > 0.5)(line.replace(/\s/g, '')));

export function parseReading(line, timestamp = Date.now()) {
  // Support the exact output observed from the user's verified firmware.
  // Anchor the entire line so boot logs and unrelated numbers are never readings.
  const legacy = /^Distance:\s*(\d+(?:\.\d+)?)\s*cm$/i.exec(line.trim());
  const data = legacy ? { distanceCm: Number(legacy[1]) } : JSON.parse(line);
  // Typed messages (hardware, node, station) have their own parsers.
  if (!data || data.type !== undefined || typeof data.distanceCm !== 'number' || !Number.isFinite(data.distanceCm) || data.distanceCm <= 0) {
    throw new Error('Expected a positive, finite distanceCm number.');
  }
  return { distanceCm: data.distanceCm, timestamp };
}

// Preserve partial lines across USB chunks; limit memory for malformed streams.
export class LineBuffer {
  buffer = '';
  dropping = false;
  push(text, onLine, onInvalid) {
    for (const char of text) {
      if (char === '\n') {
        if (!this.dropping && this.buffer.trim()) onLine(this.buffer.trim());
        this.buffer = ''; this.dropping = false;
      } else if (!this.dropping) {
        this.buffer += char;
        if (this.buffer.length > 4096) {
          this.buffer = ''; this.dropping = true; onInvalid('Serial line exceeded 4096 characters.');
        }
      }
    }
  }
}

export class SerialSensor {
  constructor({ onReading, onHardware = () => {}, onNode = () => {}, onStation = () => {}, onStatus, onInvalid }) {
    Object.assign(this, { onReading, onHardware, onNode, onStation, onStatus, onInvalid });
    this.port = null; this.reader = null; this.stopping = false;
  }
  async connect() {
    if (this.port) return;
    if (!globalThis.navigator?.serial) throw new Error('Web Serial is unavailable. Open localhost in desktop Chrome or Edge.');
    this.onStatus('connecting');
    let port;
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
    } catch (error) {
      this.onStatus('disconnected');
      if (error.name === 'NotFoundError') throw new Error('No port selected. Click Connect Sensor to try again.');
      throw new Error('Could not open the serial port. Close Arduino Serial Monitor and other serial apps, check USB, and try again. ' + error.message);
    }
    this.port = port; this.stopping = false;
    this.onStatus('connected', port.getInfo());
    this.readTask = this.read();
  }
  async read() {
    const decoder = new TextDecoder();
    const lines = new LineBuffer();
    let failure;
    try {
      this.reader = this.port.readable.getReader();
      while (!this.stopping) {
        const { value, done } = await this.reader.read();
        if (done) break;
        lines.push(decoder.decode(value, { stream: true }), line => {
          if (isBootLine(line)) return;
          if (/Brownout detector was triggered/i.test(line)) { this.onInvalid('The ESP32 restarted because its supply voltage dipped (brownout). Use a better USB cable/port or charger.', line.slice(0, 300)); return; }
          try {
            let type;
            if (line.startsWith('{')) { try { type = JSON.parse(line)?.type; } catch { /* handled below */ } }
            if (type === 'hardware') this.onHardware(parseHardware(line));
            else if (type === 'node') this.onNode(parseNode(line));
            else if (type === 'station') this.onStation(parseStation(line));
            else this.onReading(parseReading(line));
          }
          catch {
            let message = 'Ignored invalid serial data. Expected ground-station JSON, a JSON distanceCm reading or Distance: 60.69 cm, one reading per line. Check firmware output and 115200 baud.';
            // Debug text from firmware/flood_node means the wrong board's COM port was picked.
            if (/^(=== Flood Sensor Node|#\d+\s+TX:|\s*(Distance|GPS|ACK|Link)\b|\[(LoRa|GPS)\])/.test(line)) {
              message = 'This is debug text from an older flood-node sketch. Upload the latest firmware/flood_node/flood_node.ino (it sends dashboard data over USB), or connect the GROUND STATION board instead.';
            }
            try {
              if (JSON.parse(line)?.error === 'no_echo') message = 'The ESP32 reports no echo. Check the target, probe placement, wiring, and sensor range.';
            } catch { /* Non-JSON output is displayed verbatim for diagnosis. */ }
            this.onInvalid(message, line.slice(0, 300));
          }
        }, this.onInvalid);
      }
    } catch (error) { if (!this.stopping) failure = error.message; }
    finally {
      this.reader?.releaseLock(); this.reader = null;
      try { await this.port?.close(); } catch { /* USB may already be removed. */ }
      this.port = null;
      this.onStatus('disconnected');
      if (!this.stopping) this.onInvalid('Connection lost. Check USB and reconnect.' + (failure ? ' ' + failure : ''));
    }
  }
  async disconnect() {
    this.stopping = true;
    await this.reader?.cancel().catch(() => {});
    await this.readTask;
  }
}
