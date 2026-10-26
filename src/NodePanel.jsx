import React from 'react';

import { NODE_STALE_MS, STATION_STALE_MS, quality } from './diagnose.js';
export { NODE_STALE_MS, STATION_STALE_MS, quality };

const fixed = (value, digits = 1) => value == null ? '—' : value.toFixed(digits);
const time = stamp => new Date(stamp).toLocaleTimeString();
const ago = ms => ms < 1000 ? 'just now' : ms < 60000 ? `${Math.floor(ms / 1000)}s ago` : `${Math.floor(ms / 60000)}m ago`;

function RssiChart({ packets }) {
  if (packets.length < 2) return null;
  const start = packets[0].timestamp;
  const span = Math.max(1, packets.at(-1).timestamp - start);
  const lo = Math.min(-120, ...packets.map(p => p.rssi));
  const hi = Math.max(-30, ...packets.map(p => p.rssi));
  const points = packets.map(p => `${8 + (p.timestamp - start) / span * 284},${62 - (p.rssi - lo) / (hi - lo) * 54}`).join(' ');
  return <div className="rssi-chart"><span>RSSI · last {packets.length} packets · scale {lo} to {hi} dBm</span>
    <svg viewBox="0 0 300 70" preserveAspectRatio="none" role="img" aria-label="Received signal strength over time"><path d="M8 62 H292 M8 35 H292 M8 8 H292" stroke="#e3e9e9" fill="none" vectorEffect="non-scaling-stroke"/><polyline points={points} fill="none" stroke="#198b88" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>
    <div><span>{time(packets[0].timestamp)}</span><span>{time(packets.at(-1).timestamp)}</span></div></div>;
}

export default function NodePanel({ station, packets, now, connected }) {
  const stationLive = connected && station && now - station.timestamp < STATION_STALE_MS;
  const last = packets.at(-1);
  const lastAge = last ? now - last.timestamp : null;
  const nodeLive = connected && last && lastAge < NODE_STALE_MS;
  const received = station ? station.rx - station.unknown : null;
  const loss = station && received + station.lost > 0 ? station.lost / (received + station.lost) * 100 : null;
  const gps = last?.gps;

  const usb = last?.source === 'usb' ? last.lora : null;
  const stationText = usb ? (!usb.ready ? 'Node’s Ra-02 failed to start · check RST → 14, DIO0 → 26, 3.3 V'
      : usb.acked === 0 ? `Node on USB · ${usb.sent} packets sent, no ACK from a ground station yet`
      : usb.ackOk ? 'Node on USB · ground station is answering' : `Node on USB · last packet not ACKed (${usb.acked}/${usb.sent} total)`)
    : !station ? 'Waiting for ground station…'
    : !stationLive ? 'Ground station offline or stale'
    : !station.ready ? 'Radio init failed · check Ra-02 wiring and 3.3 V'
    : !last ? 'Listening · no node packet yet'
    : nodeLive ? 'Receiving node packets'
    : `No packet for ${Math.floor(lastAge / 1000)}s · node off, out of range or settings differ`;
  const gpsText = !last ? 'Waiting for first packet…'
    : gps.chars === 0 ? 'Node reports no GPS serial data · check GPS TX → GPIO16 and power'
    : !gps.fix ? `GPS data received · waiting for fix (${gps.satellites} satellites)`
    : 'Position fix acquired';

  return <section className="hardware-view node-view">
    <div className="section-heading"><div><span className="eyebrow">LORA 433 MHZ · {usb ? 'NODE ON USB' : 'GROUND STATION'}</span><h2>Radio link & location</h2></div><span>{usb ? (nodeLive ? 'Live · node connected directly by USB' : 'Last received status · not live') : !station ? 'Upload firmware/ground_station and connect it' : stationLive ? 'Live via ground station USB' : 'Last received status · not live'}</span></div>
    <div className="hardware-grid">
      <article><span className="eyebrow">RADIO LINK</span><h2>{usb ? 'LoRa from the node’s side' : 'Ground station'}</h2>
        <p className={`hardware-status ${usb ? (usb.ackOk ? '' : 'warn') : stationLive && station.ready && (nodeLive || !last) ? '' : 'warn'}`}>{stationText}</p>
        <dl>
          {usb ? <>
            <dt>Node Ra-02</dt><dd>{usb.ready ? `Ready · 433 MHz · SF9${usb.rstPin != null ? ` · RST GPIO${usb.rstPin}` : ''}` : 'Init failed'}</dd>
            <dt>Packets sent</dt><dd>{usb.sent}</dd>
            <dt>ACKs received</dt><dd>{usb.acked}{usb.sent ? ` (${(usb.acked / usb.sent * 100).toFixed(0)}%)` : ''}</dd>
            <dt>Station heard node at</dt><dd>{usb.stationRssi != null ? `${usb.stationRssi} dBm` : '—'}</dd>
            <dt>Node heard ACK at</dt><dd>{last.rssi != null ? `${last.rssi} dBm · ${quality(last.rssi)}` : '—'}</dd>
            <dt>ACK SNR</dt><dd>{last.snr != null ? `${fixed(last.snr)} dB` : '—'}</dd>
          </> : <>
          <dt>Radio</dt><dd>{station ? `${fixed(station.frequencyMHz, 0)} MHz · SF${station.sf} · ${station.bandwidthKHz} kHz` : '—'}</dd>
          {station?.rstPin != null && <><dt>Ra-02 found</dt><dd>{station.rstPin >= 0 ? `Yes · RST on GPIO${station.rstPin}` : 'No · check wiring'}</dd></>}
          <dt>Packets received</dt><dd>{received ?? '—'}</dd>
          <dt>Packets lost</dt><dd>{station ? `${station.lost}${loss != null ? ` (${loss.toFixed(0)}%)` : ''}` : '—'}</dd>
          <dt>ACKs sent</dt><dd>{station?.acks ?? '—'}</dd>
          <dt>Last RSSI</dt><dd>{last ? `${last.rssi} dBm · ${quality(last.rssi)}` : '—'}</dd>
          <dt>Last SNR</dt><dd>{last ? `${fixed(last.snr)} dB` : '—'}</dd>
          </>}
          <dt>Last packet</dt><dd>{last ? ago(lastAge) : '—'}</dd>
          {station?.unknown > 0 && <><dt>Other packets</dt><dd className="packet">{station.unknown} · {station.lastUnknown || '—'}</dd></>}
        </dl>
        <RssiChart packets={packets.filter(p => p.rssi != null).slice(-30)}/>
      </article>
      <article><span className="eyebrow">NODE {last?.node ?? '—'} · NEO-6M</span><h2>Location & sensor</h2>
        <p className={`hardware-status ${gps?.fix ? '' : 'warn'}`}>{gpsText}</p>
        <dl>
          <dt>Sequence</dt><dd>{last?.seq ?? '—'}</dd>
          <dt>Sensor reading (median)</dt><dd>{!last ? '—' : last.distanceCm == null ? 'No echo' : `${fixed(last.distanceCm)} cm`}</dd>
          {last?.samples && <><dt>Pings with echo · last window</dt><dd>{last.samples.valid} / {last.samples.pings}{last.samples.minCm != null ? ` · ${fixed(last.samples.minCm)}–${fixed(last.samples.maxCm)} cm` : ''}</dd></>}
          <dt>Satellites</dt><dd>{gps?.satellites ?? '—'}</dd>
          <dt>Latitude</dt><dd>{gps?.fix ? gps.lat.toFixed(6) : '—'}</dd>
          <dt>Longitude</dt><dd>{gps?.fix ? gps.lng.toFixed(6) : '—'}</dd>
          <dt>GPS bytes (node)</dt><dd>{gps?.chars ?? '—'}</dd>
        </dl>
        {gps?.fix && <a className="map-link" href={`https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lng}#map=17/${gps.lat}/${gps.lng}`} target="_blank" rel="noreferrer">Open location in OpenStreetMap ↗</a>}
        <p className="subtle">The first GPS fix needs open sky and can take several minutes. Indoors the node usually reports satellites 0 and no fix.</p>
      </article>
    </div>
    <p className="hardware-help">Upload firmware/flood_node to the sensor board and firmware/ground_station to the receiver board, both with RST → GPIO14 and DIO0 → GPIO26. Connect either board here: the <strong>node</strong> to test its sensors directly, or the <strong>ground station</strong> to receive over LoRa. Antennas on both radios before powering up.</p>
  </section>;
}
