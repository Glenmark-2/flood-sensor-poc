import React from 'react';

// Health check views. The logic lives in diagnose.js; main.jsx runs it once and passes the result.
// state: 'ok' (green) · 'warn' (amber) · 'fail' (red) · 'idle' (grey, unknown yet)

const SHORT = {
  'Plugged into this laptop': 'On USB', 'Plugged in & running ground_station.ino': 'Running',
  'Answering the flood sensor': 'Answering', 'LoRa radio (Ra-02)': 'Radio', 'Receiving the flood sensor': 'Receiving',
  'Other LoRa packets': 'Other packets', 'Packet loss': 'Loss', 'Running & sending': 'Sending',
  'JSN-SR04T (water depth)': 'JSN-SR04T', 'GPS module (NEO-6M)': 'GPS data', 'GPS position fix': 'GPS fix',
};
const word = state => state === 'ok' ? 'working' : state === 'warn' ? 'warning' : state === 'fail' ? 'problem' : 'unknown';

// Compact card next to the flood height: verdict + one chip per part.
export function HealthCard({ health }) {
  const { gs, fs, verdict } = health;
  const chips = rows => rows.map(r => <li key={r.label} className={`chip ${r.state}`} title={`${r.label}: ${r.detail}`}><i aria-hidden="true"/>{SHORT[r.label] ?? r.label}<span className="sr-only"> {word(r.state)}</span></li>);
  return <section className="health-card" aria-label="System health">
    <div className="eyebrow">SYSTEM HEALTH</div>
    <p className={`verdict ${verdict.state}`}><i aria-hidden="true"/>{verdict.text}</p>
    <div className="chip-group"><h3>Ground station</h3><ul>{chips(gs)}</ul></div>
    <div className="chip-group"><h3>Flood sensor</h3><ul>{chips(fs)}</ul></div>
    <a className="details-link" href="#system-check">What to check ↓</a>
  </section>;
}

function Row({ label, state, detail }) {
  return <li className={`check ${state}`}><i aria-hidden="true"/><div><strong>{label}</strong><span>{detail}</span></div><em className="sr-only">{word(state)}</em></li>;
}

// Full per-part explanations, lower on the page.
export default function SystemCheck({ health }) {
  const { gs, fs, verdict, viaUsb } = health;
  return <section className="system-check" id="system-check" aria-label="System check details">
    <div className="section-heading"><div><span className="eyebrow">SYSTEM CHECK · DETAILS</span><h2>What each part is doing</h2></div><span>{viaUsb ? 'Bench test · flood sensor on USB' : 'Field setup · ground station on USB'}</span></div>
    <p className={`verdict ${verdict.state}`}><i aria-hidden="true"/>{verdict.text}</p>
    <div className="check-grid">
      <div><h3>Ground station <small>ESP32 + Ra-02 on the laptop</small></h3><ul>{gs.map(r => <Row key={r.label} {...r}/>)}</ul></div>
      <div><h3>Flood sensor <small>ESP32 + Ra-02 + JSN + GPS in the field</small></h3><ul>{fs.map(r => <Row key={r.label} {...r}/>)}</ul></div>
    </div>
  </section>;
}
