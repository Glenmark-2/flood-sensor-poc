# Flood Sensor — local USB monitor

Reads either a USB-connected sensor ESP32 or a **LoRa ground station** that relays readings from the flood node (see *LoRa flood node + ground station*).

React + Vite, browser Web Serial, no backend, cloud, database, or generated telemetry. Before receiving a valid JSON line, measurements show `—` and “Waiting for sensor...”. The last received reading remains labeled as historical when disconnected or when no valid reading has arrived for three seconds. The chart adds points only on actual valid serial input; up to 120 readings remain in memory and the table shows the latest 10.

## Run

1. In this folder, run `npm install`, then `npm run dev`.
2. Open **http://localhost:5173** in desktop Chrome or Edge (use the URL printed by Vite if 5173 is occupied). Web Serial needs localhost or HTTPS. A phone browser is not the USB monitoring station.
3. Plug in your ESP32 with a data-capable USB cable.
4. Ensure its firmware emits readings at **115200 baud**. Both JSON (`{"distanceCm":65.2}`) and your verified firmware's exact text format (`Distance: 60.69 cm`) are supported, one reading per line. These are format examples, not dashboard data. No firmware upload is needed if your existing sketch uses that text format at 115200 baud.
5. **Close Arduino Serial Monitor, Serial Plotter, and other serial applications.** Click **Connect Sensor**, then choose the ESP32's USB serial device / correct COM port in the browser picker. You can identify the COM port in Arduino's Tools → Port or Windows Device Manager → Ports. The browser does not expose the Windows COM name to this page; the dashboard labels the selected device ESP32 and shows its USB vendor ID if available. Selection alone does not verify the board model.
6. Set **Reference height** to the measured probe-to-zero-depth distance. Move the target nearer/farther, then raise/lower water: distance, calculated depth, history, and tank should follow the physical changes.
7. Click **Disconnect** before reopening Serial Monitor or uploading firmware.

## LoRa flood node + ground station (current setup)

**Measuring method: floating depth sounder.** The node floats on the flood with the JSN-SR04T probe just under the surface, pointing **down**; the pulse travels through the water, bounces off the ground and returns. The node always sends **air-calibrated** distances; the dashboard's settings choose **Floating · Water** (field: × speed of sound in water ÷ 343, default 1480 m/s) or **Floating · Air** (desk test, no conversion), so no re-upload is needed to switch. Flood height = converted reading + *probe depth below surface*. Limits: in water the JSN-SR04T's blind zone is roughly 0.9–1.5 m; murky water, debris, soft mud and tilting reduce reliability. Tether the float. **Fixed above the water** mode (reference height − air gap) is also available.

**Dashboard layout:** top = flood height (with rising/falling trend) and System health (verdict + one chip per part); then key readings, the trend chart, measurement settings + level view, and finally the detailed system check, radio/location panel and packet log.

Two boards, pins from `Flood_Sensor_Wiring_Guide.pdf`: LoRa SCK 18, MISO 19, MOSI 23, NSS 5, **RST 14, DIO0 26**, 3.3 V. (Older sketches below use RST 2 / DIO0 4 — move those two jumpers.) Install **LoRa** by Sandeep Mistry and **TinyGPSPlus** by Mikal Hart; board **ESP32 Dev Module**.

1. **Sensor board** — upload `firmware/flood_node/flood_node.ino`. Wiring: JSN-SR04T TRIG 32 / ECHO 33 / 5 V, GPS TX → 16, RX → 17, VCC 5 V. It pings the JSN-SR04T 4×/s continuously and every ~10 s sends the window's median as `FS01,seq,distance,fix,lat,lng,sats,gpsChars,validPings,pings,minCm,maxCm,w|a` over LoRa, then waits for an ACK. It also prints the reading as one JSON line on its own USB (`"source":"usb"`), so you can connect the dashboard **directly to this board** to test the JSN-SR04T and GPS without a ground station.
2. **Ground station** — second ESP32 + Ra-02, LoRa wiring only. Upload `firmware/ground_station/ground_station.ino`. It ACKs each packet and prints one JSON line per reading (`{"type":"node",...}`) plus a heartbeat every 2 s (`{"type":"station",...}`).
3. Close Serial Monitor, double-click `start-dashboard.bat` (or `npm run dev`), **Connect Sensor**, and pick either the **node**'s port (direct sensor test) or the **ground station**'s port (readings over LoRa). The **Dashboard** tab shows everything at once: summary tiles (depth, distance, GPS, signal, packets, last update), water level, radio link & GPS location, and a combined reading/packet history.

**System check** (top of the Dashboard) lights each part of both boards green / amber / red and states which board the problem is on. Bench trick: if the ground station hears nothing, plug the flood sensor in instead; it reports whether its own radio works and whether anything ACKs it.

A LoRa reading counts as live for 25 s (node sends every 10 s). No-echo readings are listed in the history but never become water-level points. Antennas on both radios before powering up; both sketches must keep the same SF9 / 125 kHz / sync word 0x34 settings.

## ESP32 firmware

The existing physically verified measurement code is the best starting point: keep its measurement procedure, set `Serial.begin(115200)`, and print its real distance as the JSON line above. Alternatively open `firmware/flood_sensor/flood_sensor.ino` in Arduino IDE, choose **ESP32 Dev Module** and the correct port, and upload. This supplied sketch uses GPIO5 TRIG / GPIO18 ECHO, a 20 µs trigger, pulse-width ranging, a bounded echo timeout, and a 200 ms pause. It has not been flashed or verified on your hardware by this build.

Keep your verified wiring and sensor operating mode. AJ-SR04M variants have a near-field blind zone (commonly around 20 cm); keep the water surface outside it. If changing the supply to 5 V, check Echo voltage and use appropriate level conversion before connecting it to the ESP32 input. References: [AJ-SR04M manual](https://altronics.cl/uploads/manual-aj-sr04m.pdf), [Espressif component notes](https://components.espressif.com/components/cyrilb1531/aj_sr04m/versions/0.3.0/readme).

No-echo diagnostics and malformed, nonnumeric, nonfinite, or nonpositive distances are rejected; they never become chart points. Check the rejected-line notice if your original firmware uses human-readable output. Opening the serial port may reset the ESP32, so allow a few seconds for boot. If disconnected, check the cable and reconnect. For a busy port, close other serial tools. If the picker was cancelled, click Connect Sensor again.

Water depth is **reference height − distance**, without numeric clamping. A negative result flags calibration/placement; only the tank drawing is limited to 0–100%. Changing reference height recalculates retained readings. There are no flood thresholds or alerts. Reading rate uses actual arrivals over the last five seconds. Readings reset on refresh (the reference height is remembered in this browser); a new connection clears old history.

## Checks

`npm test` checks parser, fragmented serial input, and serial connection cleanup using isolated test inputs; no test data is included in the dashboard. `npm run build` creates the production frontend in `dist`. `npm run preview` serves that build locally.

Physical acceptance still requires the board: compare several real readings to a measuring tool, move the target, change water level, unplug USB to verify loss handling, reconnect, and confirm disconnect frees the port for Arduino. [Web Serial lifecycle documentation](https://developer.chrome.com/docs/capabilities/serial).

## GPS + LoRa proof of concept

If GPS bytes increase but valid NMEA remains zero, temporarily upload `firmware/gps_diagnostic/gps_diagnostic.ino` to the GPS board. Disconnect the dashboard and open Arduino Serial Monitor at **115200**; press reset to capture the scan. With TinyGPSPlus installed, this GPS-only sketch tests 9600, 38400, 4800, 57600, 19200 and 115200 baud for eight seconds each, prints checksum counts and text/hex samples, and keeps streaming at the first rate with at least two valid NMEA checksums. It does not configure the GPS or operate LoRa. If a rate is found, change the first argument of `gpsSerial.begin(...)` in the GPS/LoRa sketch to that rate, restore your receiver setting, and upload that sketch again. If none is found, inspect the samples for corrupt or binary output and check wiring and power; no match alone does not establish a faulty module. This diagnostic has not been compiled or physically tested here.

For a standalone second transmitter without GPS, upload `firmware/lora_transmitter/lora_transmitter.ino` to the second ESP32 + RA-02. It uses the same wiring and radio settings and sends `HELLO from transmitter #...` every five seconds. Its Serial Monitor shows local transmission status at 115200 baud (plain text, not dashboard telemetry). Set `TRANSMIT = false` in the GPS/LoRa sketch on the receiving board, upload it, then connect that receiver to the dashboard's **GPS & LoRa test** tab. Confirm its RX count increases and its payload matches the transmitter. Attach antennas to both radios before transmission.

Open `firmware/gps_lora_poc/gps_lora_poc.ino` in Arduino IDE. Install **TinyGPSPlus by Mikal Hart** and **LoRa by Sandeep Mistry** through Library Manager. Select **ESP32 Dev Module** and your port, then upload.

Uses your exact pins: GPS TX → 16, RX → 17; LoRa SCK → 18, MISO → 19, MOSI → 23, NSS → 5, RST → 2, DIO0 → 4. Common ground, RA-02 at 3.3 V, and a suitable antenna attached before transmission. Check the GPS breakout's VCC specification; an onboard regulator can affect the required input voltage. Disconnect old ultrasonic connections on GPIO5/18 because they conflict with LoRa. This sketch tests GPS and LoRa only.

1. Close Serial Monitor after upload. Run `npm run dev`, open the dashboard in desktop Chrome/Edge, select **GPS & LoRa test**, then **Connect Sensor**. USB telemetry arrives once per second at 115200 baud.
2. GPS runs at 9600 baud. Increasing bytes indicate UART traffic; increasing valid NMEA sentences indicate decodable GPS output. Test outdoors with a clear view of the sky and allow several minutes for the first fix. Coordinates appear only for a recent fix. No bytes: check power, crossed TX/RX wiring, and baud. Bytes without valid sentences: check baud and signal quality.
3. LoRa reports initialization and sends `ESP32 POC #...` every five seconds. Defaults: 433 MHz, SF7, 125 kHz bandwidth, coding rate 4/5, sync word 0x12, CRC enabled, TX power 2 dBm. Set a locally permitted frequency supported by your radio/antenna before transmitting; this default is not regulatory approval.
4. For an over-the-air test, flash a **second ESP32 + RA-02** with the same sketch and `TRANSMIT = false`. Match all radio settings. Connect the receiver to this dashboard or its Serial Monitor. Its RX count should increase and show the sender's payload and RSSI. TX count alone does not prove reception. Nonprintable payload bytes, quotes and backslashes are replaced by `?` in the preview.

The tab uses actual telemetry only. Status becomes historical after three seconds without telemetry or on disconnect. GPS traffic indicators stop when the counters stop increasing. Packet totals represent the firmware boot session. No physical board test or firmware compilation has been performed here.

References: [LoRa API](https://github.com/sandeepmistry/arduino-LoRa/blob/master/API.md), [TinyGPSPlus example](https://github.com/mikalhart/TinyGPSPlus/blob/master/examples/FullExample/FullExample.ino), [NEO-6 specifications](https://www.u-blox.com/en/product/neo-6-series?legacy=Current).
