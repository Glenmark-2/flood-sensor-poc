import React from 'react';
import { quality } from './NodePanel';

// One row of the key live values under the flood-height card.
function Tile({ label, value, unit, detail, state }) {
  return <div className={`tile ${state}`}><span className="tile-label"><i/>{label}</span>
    <strong>{value}{unit && <small> {unit}</small>}</strong><span className="tile-detail" title={detail}>{detail}</span></div>;
}

export default function SummaryStrip({ latest, live, packets, station, stationLive, age }) {
  const last = packets.at(-1);
  const gps = last?.gps;
  const received = station ? station.rx - station.unknown : null;
  const loss = station && received + station.lost > 0 ? station.lost / (received + station.lost) * 100 : null;
  const f = v => v == null ? '—' : v.toFixed(1);
  const noEcho = last && last.distanceCm == null && (!latest || last.timestamp >= latest.timestamp);
  const s = (noEcho ? last : latest)?.samples;
  return <section className="summary" aria-label="Key readings">
    <Tile label="Sensor reading" value={noEcho ? 'No echo' : f(latest?.distanceCm)} unit={noEcho ? '' : 'cm'} state={noEcho ? 'fail' : !latest ? 'idle' : live ? 'ok' : 'stale'}
      detail={noEcho ? `No echo${s ? ` in ${s.pings} pings` : ''}` : s ? `Median of ${s.valid}/${s.pings} pings · ${f(s.minCm)}–${f(s.maxCm)}` : 'JSN-SR04T'}/>
    <Tile label="GPS" value={!gps ? '—' : gps.fix ? 'Fix' : gps.chars === 0 ? 'No data' : 'No fix'} state={!gps ? 'idle' : gps.fix ? 'ok' : gps.chars === 0 ? 'fail' : 'warn'}
      detail={!gps ? 'Waiting for flood sensor' : gps.fix ? `${gps.satellites} sats · ${gps.lat.toFixed(4)}, ${gps.lng.toFixed(4)}` : gps.chars === 0 ? 'Module sends nothing' : `${gps.satellites} satellites in view`}/>
    {last?.source === 'usb' ? <>
      <Tile label="Signal" value={last.rssi ?? (last.lora.ready ? 'No ACK' : 'LoRa off')} unit={last.rssi != null ? 'dBm' : ''} state={last.rssi != null ? 'ok' : 'fail'}
        detail={last.rssi != null ? `ACK from station · SNR ${last.snr.toFixed(1)} dB` : last.lora.ready ? 'Ground station not answering' : 'Ra-02 did not start'}/>
      <Tile label="Packets" value={`${last.lora.acked}/${last.lora.sent}`} state={!last.lora.ready ? 'fail' : last.lora.acked > 0 ? 'ok' : 'warn'} detail="ACKed / sent by flood sensor"/>
    </> : <>
      <Tile label="Signal" value={last ? last.rssi : '—'} unit={last ? 'dBm' : ''} state={!last ? 'idle' : last.rssi > -105 ? 'ok' : 'warn'}
        detail={last ? `${quality(last.rssi)} · SNR ${last.snr.toFixed(1)} dB` : 'LoRa 433 MHz'}/>
      <Tile label="Packets" value={received ?? '—'} state={!station ? 'idle' : !stationLive ? 'stale' : !station.ready ? 'fail' : station.lost > 0 ? 'warn' : 'ok'}
        detail={!station ? 'Ground station not connected' : !station.ready ? 'Radio did not start' : `${station.lost} lost${loss != null ? ` (${loss.toFixed(0)}%)` : ''}`}/>
    </>}
    <Tile label="Last update" value={age == null ? '—' : age < 1 ? 'Now' : `${Math.floor(age)} s`} state={age == null ? 'idle' : live ? 'ok' : 'stale'}
      detail={last ? `${last.node} · reading #${last.seq}` : 'Sensor sends every ~10 s'}/>
  </section>;
}
