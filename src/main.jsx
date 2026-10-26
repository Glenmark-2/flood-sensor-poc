import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SerialSensor } from './serialSensor';
import './style.css';
import HardwarePanel from './HardwarePanel';
import NodePanel, { NODE_STALE_MS, STATION_STALE_MS } from './NodePanel';
import SummaryStrip from './SummaryStrip';
import SystemCheck, { HealthCard } from './SystemCheck';
import { diagnose } from './diagnose.js';
import { AIR_SPEED, DEFAULT_WATER_SPEED, toAirCalibrated, speedFactor, inMedium } from './measure.js';

const format = value => value == null ? '—' : value.toFixed(1);
const time = stamp => new Date(stamp).toLocaleTimeString();

// Settings remembered in this browser (survive a refresh).
function useStored(key, fallback) {
  const [value, setValue] = useState(() => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } });
  useEffect(() => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }, [key, value]);
  return [value, setValue];
}

function App() {
  const [tab, setTab] = useState('water');
  const [hardware, setHardware] = useState(null);
  const [traffic, setTraffic] = useState(null);
  const [station, setStation] = useState(null);
  const [rawPackets, setPackets] = useState([]);    // air-calibrated cm
  const [rawReadings, setReadings] = useState([]);  // air-calibrated cm
  const [status, setStatus] = useState('disconnected');
  const [info, setInfo] = useState(null);
  const [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState(0);
  const [rejectedLine, setRejectedLine] = useState('');
  const [now, setNow] = useState(Date.now());
  const [connectedAt, setConnectedAt] = useState(null);
  // 'float': probe floats just under the surface pointing down -> flood height = reading + probe depth.
  // 'fixed': probe fixed above the water pointing down     -> flood height = reference height − reading.
  const [mode, setMode] = useStored('floodMode', 'float');
  const [medium, setMedium] = useStored('floodMedium', 'water');        // what the sound travels through (floating mode)
  const [waterSpeed, setWaterSpeed] = useStored('floodWaterSpeed', String(DEFAULT_WATER_SPEED));
  const [offset, setOffset] = useStored('floodProbeDepthCm', '0');
  const [reference, setReference] = useStored('floodReferenceCm', '100');
  const sensor = useRef(null);

  useEffect(() => {
    sensor.current = new SerialSensor({
      onHardware: reading => {
        setHardware(reading);
        setTraffic(previous => ({ chars: reading.gps.chars, sentences: reading.gps.sentences,
          byteAt: !previous || reading.gps.chars !== previous.chars ? (reading.gps.chars > 0 ? reading.timestamp : null) : previous.byteAt,
          sentenceAt: !previous || reading.gps.sentences !== previous.sentences ? (reading.gps.sentences > 0 ? reading.timestamp : null) : previous.sentenceAt }));
      },
      onReading: reading => setReadings(previous => [...previous.slice(-119), reading]),
      onStation: setStation,
      onNode: incoming => {
        const packet = toAirCalibrated(incoming);
        setPackets(previous => [...previous.slice(-119), packet]);
        if (packet.distanceCm != null) setReadings(previous => [...previous.slice(-119), { distanceCm: packet.distanceCm, timestamp: packet.timestamp, source: packet.source, node: packet.node, rssi: packet.rssi, seq: packet.seq, samples: packet.samples }]);
      },
      onStatus: (next, portInfo) => { setStatus(next); if (portInfo) setInfo(portInfo); if (next === 'connected') setConnectedAt(Date.now()); },
      onInvalid: (message, line) => { setNotice(message); if (line !== undefined) { setRejectedLine(line); setInvalid(count => count + 1); } },
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); sensor.current.disconnect(); };
  }, []);

  // ---------- measurement maths ----------
  const floating = mode === 'float';
  const throughWater = floating && medium === 'water';
  const factor = floating ? speedFactor(medium, waterSpeed) : 1;
  const packets = rawPackets.map(p => inMedium(p, factor));
  const readings = rawReadings.map(r => inMedium(r, factor));
  const height = Number(reference);
  const probeDepth = Number(offset);
  const validSettings = floating ? Number.isFinite(probeDepth) && probeDepth >= 0 : Number.isFinite(height) && height > 0;
  const depthOf = distance => distance == null || !validSettings ? null : floating ? distance + probeDepth : height - distance;

  // ---------- liveness ----------
  const supported = !!navigator.serial && window.isSecureContext;
  const connected = status === 'connected';
  const latest = readings.at(-1);
  const rawLatest = rawReadings.at(-1);
  const age = latest ? Math.max(0, (now - latest.timestamp) / 1000) : null;
  const viaLora = latest?.source === 'lora';
  const fromNode = viaLora || latest?.source === 'usb';
  const live = connected && latest && age < (fromNode ? NODE_STALE_MS / 1000 : 3);
  const hardwareLive = connected && hardware && now - hardware.timestamp < 3000;
  const stationLive = connected && station && now - station.timestamp < STATION_STALE_MS;
  const lastPacket = packets.at(-1);
  const packetLive = connected && lastPacket && now - lastPacket.timestamp < NODE_STALE_MS;
  const anyLive = live || hardwareLive || stationLive || packetLive;
  const depth = latest ? depthOf(latest.distanceCm) : null;
  const noEcho = lastPacket && lastPacket.distanceCm == null && (!latest || lastPacket.timestamp >= latest.timestamp);

  // Trend: change over roughly the last minute.
  const chart = readings.map(r => ({ ...r, depth: depthOf(r.distanceCm) })).filter(r => r.depth != null);
  const past = chart.length > 1 ? (chart.filter(r => r.timestamp <= chart.at(-1).timestamp - 55000).at(-1) ?? chart[0]) : null;
  // Needs at least 30 s of history, otherwise a little noise looks like a huge rate.
  const ratePerMin = past && chart.at(-1).timestamp - past.timestamp >= 30000 ? (chart.at(-1).depth - past.depth) / ((chart.at(-1).timestamp - past.timestamp) / 60000) : null;
  const trend = ratePerMin == null ? null : Math.abs(ratePerMin) < 0.5 ? { cls: 'steady', text: 'Steady' }
    : ratePerMin > 0 ? { cls: 'rising', text: `▲ Rising ${ratePerMin.toFixed(1)} cm/min` } : { cls: 'falling', text: `▼ Falling ${Math.abs(ratePerMin).toFixed(1)} cm/min` };

  // Level drawing / chart scale. Floating has no fixed top, so scale to the deepest reading (min 150 cm).
  const scale = floating ? Math.max(150, Math.ceil(Math.max(0, ...chart.map(r => r.depth)) * 1.25 / 50) * 50) : height;
  const fill = depth == null ? 0 : Math.max(0, Math.min(100, depth / scale * 100));
  const min = Math.min(0, ...chart.map(r => r.depth));
  const max = Math.max(scale || 1, ...chart.map(r => r.depth));
  const start = chart[0]?.timestamp;
  const span = Math.max(1, (chart.at(-1)?.timestamp || 0) - (start || 0));
  const points = chart.map(r => `${10 + (r.timestamp - start) / span * 580},${150 - (r.depth - min) / (max - min) * 130}`).join(' ');

  const health = diagnose({ status, station, packets, now, connectedAt });
  const recent = readings.filter(r => now - r.timestamp < 5000);
  const nodeRecent = readings.filter(r => r.source === 'lora' || r.source === 'usb').slice(-6);
  const interval = nodeRecent.length > 1 ? (nodeRecent.at(-1).timestamp - nodeRecent[0].timestamp) / (nodeRecent.length - 1) / 1000 : null;
  const rate = recent.length > 1 ? (recent.length - 1) / ((recent.at(-1).timestamp - recent[0].timestamp) / 1000) : null;

  async function connect() {
    setNotice(''); setReadings([]); setHardware(null); setTraffic(null); setStation(null); setPackets([]); setInvalid(0); setInfo(null); setRejectedLine('');
    try { await sensor.current.connect(); } catch (error) { setNotice(error.message); }
  }
  const nodeOnUsb = lastPacket?.source === 'usb';
  const label = status === 'connecting' ? 'Selecting sensor…' : !connected ? 'Not connected'
    : stationLive && !station.ready ? 'Ground station connected · its LoRa radio did not start'
    : stationLive && !packetLive && !hardwareLive ? (packets.length ? 'Ground station connected · flood sensor silent' : 'Ground station connected · listening for flood sensor')
    : anyLive ? 'Connected · receiving live data' : !latest && !hardware && !station ? 'Connected · waiting for data' : 'Connected · no recent data';
  const subtitle = !latest ? (noEcho ? 'Sensor reports no echo' : 'Waiting for the first reading…') : !live ? `Last reading ${Math.floor(age)} s ago · not live`
    : viaLora ? `Via LoRa from ${latest.node} · ${latest.rssi} dBm` : fromNode ? `Flood sensor ${latest.node} on USB` : 'USB sensor';

  return <main>
    <header><div className="brand"><span className="brand-icon">≈</span><div><h1>Flood Sensor</h1><p>LOCAL MONITORING STATION</p></div></div><span className="local">USB SERIAL <span> / </span> ESP32</span></header>
    <section className="connection"><div><span className={`dot ${anyLive ? 'live' : ''}`}/><strong>{label}</strong><span className="connection-detail">{connected ? (station ? 'LoRa ground station · 115200 baud' : nodeOnUsb ? `Flood sensor ${lastPacket.node} on USB (bench test)` : 'ESP32 · 115200 baud') : 'Field: plug in the GROUND STATION · bench test: the flood sensor'}</span></div><button disabled={!supported || status === 'connecting'} onClick={connected ? () => sensor.current.disconnect() : connect}>{connected ? 'Disconnect' : status === 'connecting' ? 'Connecting…' : 'Connect Sensor'} <span>↗</span></button></section>
    <nav className="tabs" aria-label="Monitor views"><button aria-pressed={tab === 'water'} onClick={() => setTab('water')}>Dashboard</button><button aria-pressed={tab === 'hardware'} onClick={() => setTab('hardware')}>GPS & LoRa test (old firmware)</button></nav>
    {tab === 'hardware' && <HardwarePanel data={hardware} live={hardwareLive} traffic={traffic} now={now}/>}
    {!supported && <div className="notice" role="alert">Use desktop Chrome or Edge at http://127.0.0.1:5173. This browser or context does not support Web Serial.</div>}
    {notice && <div className="notice" role="alert">{notice} <button className="text-button" onClick={() => setNotice('')}>Dismiss</button></div>}
    {rejectedLine && <details className="serial-diagnostic"><summary>Serial diagnostic · last rejected line</summary><pre>{rejectedLine}</pre><p>The actual text received that the dashboard could not read. Unreadable text usually means a baud mismatch.</p></details>}

    <div hidden={tab !== 'water'}>
      {/* ---------- 1. At a glance ---------- */}
      <div className="overview">
        <section className="hero-card">
          <div className="eyebrow">FLOOD HEIGHT · {live ? <b className="live-tag">LIVE</b> : 'NOT LIVE'}</div>
          <div className={`hero-number ${!live ? 'muted' : ''}`}>{format(depth)}<span>cm</span></div>
          <div className="hero-meta">
            {trend && live && <span className={`trend ${trend.cls}`}>{trend.text}</span>}
            <span>{subtitle}</span>
          </div>
          <div className="hero-facts">
            <div><span>Sensor reading</span><strong>{noEcho ? 'No echo' : `${format(latest?.distanceCm)} cm`}</strong></div>
            <div><span>Updated</span><strong>{age == null ? '—' : age < 1 ? 'just now' : `${Math.floor(age)} s ago`}</strong></div>
            <div><span>Measuring</span><strong>{floating ? `Floating · ${throughWater ? 'water' : 'air'}` : 'Fixed · air'}</strong></div>
          </div>
          {floating && !throughWater && <p className="hero-warn">Converting for <b>air</b> (desk test). Switch to <b>Water</b> in settings before using it in a flood.</p>}
          {!floating && depth < 0 && <p className="hero-warn">Negative: Reference height ({format(height)} cm) is smaller than the reading. Fix it in settings.</p>}
        </section>
        <HealthCard health={health}/>
      </div>
      <SummaryStrip latest={latest} live={live} packets={packets} station={station} stationLive={stationLive} age={age}/>

      {/* ---------- 2. Trend ---------- */}
      <section className="trend-card">
        <div className="section-heading"><div><span className="eyebrow">TREND</span><h2>Flood height over time</h2></div><span>{fromNode ? (interval >= 1 ? `1 reading / ${interval.toFixed(0)} s · ` : '') : rate != null && Number.isFinite(rate) ? `${rate.toFixed(1)} readings/s · ` : ''}{readings.length} / 120 readings</span></div>
        {chart.length > 1 ? <div className="chart"><svg viewBox="0 0 600 170" preserveAspectRatio="none" role="img" aria-label="Flood height over time"><path d="M10 150 H590 M10 85 H590 M10 20 H590" stroke="#e3e9e9" fill="none" vectorEffect="non-scaling-stroke"/><polyline points={points} fill="none" stroke="#198b88" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/></svg><div><span>{time(start)} · {format(min)}–{format(max)} cm</span><span>{time(chart.at(-1).timestamp)}</span></div></div>
          : <div className="empty">The trend appears after two readings.</div>}
      </section>

      {/* ---------- 3. Settings + level drawing ---------- */}
      <div className="dashboard">
        <section className="measurements settings">
          <div className="eyebrow">MEASUREMENT SETTINGS</div>
          <div className="setting"><span className="setting-label">How is the sensor mounted?</span>
            <div className="mode" role="group" aria-label="Mounting"><button type="button" aria-pressed={floating} onClick={() => setMode('float')}>Floating on the water</button><button type="button" aria-pressed={!floating} onClick={() => setMode('fixed')}>Fixed above the water</button></div></div>
          {floating && <div className="setting"><span className="setting-label">Sound travels through</span>
            <div className="mode" role="group" aria-label="Medium"><button type="button" aria-pressed={medium === 'water'} onClick={() => setMedium('water')}>Water (field)</button><button type="button" aria-pressed={medium === 'air'} onClick={() => setMedium('air')}>Air (desk test)</button></div>
            <p className="hint">{throughWater
              ? <>Raw reading × <b>{factor.toFixed(2)}</b> ({format(Number(waterSpeed) || DEFAULT_WATER_SPEED)} ÷ {AIR_SPEED} m/s).{rawLatest && <> Now: {format(rawLatest.distanceCm)} cm raw → <b>{format(latest.distanceCm)} cm</b> through water.</>}</>
              : <>No conversion: use this when pointing the probe through air, e.g. at the ceiling or floor.</>}</p></div>}
          {throughWater && <div className="calibration"><label htmlFor="speed">Speed of sound in water <span>m/s</span></label><input id="speed" type="number" min="1300" max="1600" step="5" value={waterSpeed} onChange={event => setWaterSpeed(event.target.value)}/><p>About 1480 for fresh water at 20 °C, 1500 at 30 °C.</p></div>}
          {floating ? <div className="calibration"><label htmlFor="offset">Probe depth below surface <span>cm</span></label><input id="offset" type="number" min="0" step="0.5" value={offset} onChange={event => setOffset(event.target.value)}/><p>How far the probe face sits under the water on your float; added to the reading.</p>{!validSettings && <p className="error">Enter 0 or a positive number.</p>}</div>
            : <div className="calibration"><label htmlFor="reference">Reference height <span>cm</span></label><input id="reference" type="number" min="0.1" step="0.1" value={reference} onChange={event => setReference(event.target.value)}/><p>Probe face straight down to the <strong>dry ground</strong>.</p>{latest && <button type="button" className="calibrate" onClick={() => setReference(latest.distanceCm.toFixed(1))}>Use current reading ({format(latest.distanceCm)} cm) as dry ground</button>}{!validSettings && <p className="error">Enter a reference height greater than zero.</p>}</div>}
          <p className="formula">{floating ? 'Flood height = reading (probe → ground) + probe depth' : 'Flood height = reference height − reading'}</p>
          {throughWater && <p className="hint">In water the JSN-SR04T can’t see the ground if it is closer than roughly 1 m, so shallow floods may read nothing.</p>}
        </section>
        <section className="visual"><div className="visual-top"><span className="eyebrow">LEVEL VIEW</span><span>{latest && validSettings ? (floating ? `Scale 0–${scale} cm` : `${fill.toFixed(1)}% of reference`) : 'No measurement'}</span></div><div className="tank-scene"><div className="probe" style={floating ? {visibility: 'hidden'} : undefined}><span/>SENSOR</div><div className="tank">{!floating && <div className="distance-line" style={{height: `${100-fill}%`}}><span>{format(latest?.distanceCm)} cm</span></div>}<div className="water" style={{height: `${fill}%`}}>{floating && latest && <div className="float-probe">▼ FLOATING SENSOR</div>}{depth != null && fill > (floating ? 22 : 12) && <span>{format(depth)} <small>cm</small></span>}</div>{!latest && <div className="tank-empty">Waiting for sensor...</div>}<div className="ticks">{[0,1,2,3,4].map(i => <i key={i}/>)}</div></div><div className="tank-base">{floating ? 'GROUND · FLOOD BOTTOM' : 'ZERO-DEPTH REFERENCE'}</div></div><p className="visual-note">{live ? `Following ${latest.node ?? 'sensor'} live` : 'Awaiting live measurements'}<span className={`dot ${live ? 'live' : ''}`}/></p></section>
      </div>

      {/* ---------- 4. Details ---------- */}
      <SystemCheck health={health}/>
      {(station || packets.length > 0) && <NodePanel station={station} packets={packets} now={now} connected={connected}/>}
      <section className="history"><div className="section-heading"><div><span className="eyebrow">RECENT MEASUREMENTS</span><h2>{packets.length ? 'Reading & packet log' : 'Reading log'}</h2></div><span>Latest 10</span></div>
        {packets.length ? <div className="table-scroll"><table><thead><tr><th>Time</th><th>Node · seq</th><th>Reading</th><th>Flood height</th><th>GPS</th><th>Signal</th></tr></thead><tbody>{packets.slice(-10).reverse().map(p => <tr key={`${p.timestamp}-${p.seq}`}><td>{time(p.timestamp)}</td><td>{p.node} · {p.seq}</td><td>{p.distanceCm == null ? 'No echo' : `${format(p.distanceCm)} cm`}</td><td>{p.distanceCm == null || !validSettings ? '—' : `${format(depthOf(p.distanceCm))} cm`}</td><td>{p.gps.fix ? `${p.gps.lat.toFixed(5)}, ${p.gps.lng.toFixed(5)}` : p.gps.chars ? `No fix · ${p.gps.satellites} sats` : 'No GPS data'}</td><td><span className="source">{p.source === 'usb' ? (p.lora.ackOk ? `USB · ACK ${p.rssi} dBm` : p.lora.ready ? 'USB · no ACK' : 'USB · LoRa off') : `${p.rssi} dBm · SNR ${p.snr.toFixed(1)}`}</span></td></tr>)}</tbody></table></div>
          : <div className="table-scroll"><table><thead><tr><th>Time</th><th>Reading</th><th>Flood height</th><th>Source</th></tr></thead><tbody>{readings.slice(-10).reverse().map((r,i) => <tr key={`${r.timestamp}-${i}`}><td>{time(r.timestamp)}</td><td>{format(r.distanceCm)} cm</td><td>{format(depthOf(r.distanceCm))} cm</td><td><span className="source">{r.source === 'lora' ? `LoRa · ${r.node}` : r.source === 'usb' ? `USB · ${r.node}` : 'USB Serial'}</span></td></tr>)}</tbody></table>{!readings.length && <div className="empty">No readings yet.<span>Connect the ground station to see real measurements here.</span></div>}</div>}
        <div className="history-footer">Kept in browser memory only; settings are remembered in this browser.<span>{invalid} rejected lines</span></div></section>
    </div>
    <footer><span>{nodeOnUsb ? `JSN-SR04T + GPS → Flood sensor ${lastPacket.node} → USB → Your browser` : station || viaLora ? `Flood sensor ${lastPacket?.node ?? ''} → LoRa 433 MHz → Ground station → USB → Your browser`.replace(/ {2,}/g, ' ') : 'Ultrasonic sensor → ESP32 → USB → Your browser'}</span><span>{info?.usbVendorId != null ? `USB VID ${info.usbVendorId.toString(16).padStart(4,'0')} · ` : ''}115200 baud · No cloud</span></footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
