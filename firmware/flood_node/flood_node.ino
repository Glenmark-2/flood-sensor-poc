/*
  ================================================================
  flood_node.ino  —  Flood sensor NODE (sends readings over LoRa)
  ================================================================
  Hardware : ESP32 DevKit V1 + SX1278 Ra-02 (433 MHz) + NEO-6M V2 GPS
             + JSN-SR04T. Breadboard test: powered from the ESP32 USB.
  Pin map  : Flood_Sensor_Wiring_Guide.pdf (Rev 1)
               LoRa  SCK 18, MISO 19, MOSI 23, NSS 5, RST 14, DIO0 26, 3.3V
               GPS   TX -> GPIO16, RX -> GPIO17, VCC 5V (VIN)
               JSN   TRIG 32, ECHO 33, 5V (VIN)
             NOTE: older sketches in this folder used RST = 2, DIO0 = 4.
             This sketch uses the guide's pins (14 / 26).

  FLOATING DEPTH SOUNDER: the node floats on the flood with the JSN probe
  just under the surface, pointing DOWN. The sound travels through the
  water, bounces off the ground and comes back, so the reading IS the
  water depth below the probe (flood height = reading + probe depth,
  added in the dashboard). Sound is ~4.3x faster in water than in air;
  the dashboard applies that conversion (Settings -> Water / Air).
  Limit: in water the JSN-SR04T's blind zone is roughly 0.9-1.5 m, so
  floods shallower than that may read nothing or a wrong value.

  Every SEND_INTERVAL_MS the node:
    1. Reports the median of all JSN-SR04T pings taken during the last
       10 s (it pings 4x per second continuously), plus min / max.
    2. Adds the latest GPS position (if it has a fix).
    3. Sends one LoRa packet to the ground station.
    4. Waits for the ground station's ACK (proves two-way LoRa).
  Flood height is shown in the dashboard (Floating mode: reading + probe depth).

  LoRa packet (CSV, one line):
    node,seq,distance_cm,gps_fix,lat,lng,satellites,gps_chars,
    valid_pings,pings,min_cm,max_cm,units(a = air-calibrated)
    e.g.  FS01,12,35.8,1,14.651234,121.049876,7,48211,38,40,34.7,37.4,a
    distance_cm = air-calibrated cm, probe face -> target (-1 = no echo);
                  the dashboard converts it for water.

  The node keeps working even if the GPS, JSN or LoRa is unplugged or
  broken, so each part can be tested on its own.

  USB OUTPUT (115200 baud): one JSON line per reading, so you can plug
  THIS board straight into the dashboard and see the JSN + GPS readings
  without a ground station:
    {"type":"node","source":"usb","medium":"air","node":"FS01","seq":5,"distanceCm":54.3,
     "gps":{"fix":false,"lat":null,"lng":null,"satellites":3,"chars":9120},
     "samples":{"valid":38,"pings":40,"minCm":52.1,"maxCm":57.9},
     "rssi":null,"snr":null,"lost":0,
     "lora":{"ready":true,"rstPin":14,"sent":5,"acked":0,"ackOk":false,"stationRssi":null}}
    rssi/snr = how strongly this node heard the ground station's ACK
    (null when no ACK came back).

  Libraries : "LoRa" by Sandeep Mistry, "TinyGPSPlus" by Mikal Hart
  Board     : "ESP32 Dev Module" (or "DOIT ESP32 DEVKIT V1")
  Serial Monitor : 115200 baud (shows the same JSON lines)
  ================================================================
*/

#include <SPI.h>
#include <LoRa.h>
#include <TinyGPSPlus.h>

// ---------------- Pins (wiring guide) ----------------
#define LORA_SCK    18
#define LORA_MISO   19
#define LORA_MOSI   23
#define LORA_NSS     5
#define LORA_RST    14
#define LORA_DIO0   26

#define GPS_RX      16      // ESP32 RX2  <- GPS TX
#define GPS_TX      17      // ESP32 TX2  -> GPS RX
#define GPS_BAUD  9600

#define JSN_TRIG    32
#define JSN_ECHO    33

#define LED_PIN      2      // on-board blue LED

// ------- Radio settings (MUST match ground_station.ino) -------
#define LORA_FREQ      433E6
#define LORA_SF        9        // spreading factor 7..12
#define LORA_BW        125E3
#define LORA_CR        5        // coding rate 4/5
#define LORA_SYNCWORD  0x34
#define LORA_TX_POWER  17       // dBm (2..20). Use 2 for bench tests < 1 m apart.

// ---------------- Distance units ----------------
// Distances are always sent AIR-CALIBRATED (echo time x 343 m/s / 2).
// The dashboard converts them for water (Settings -> "Sound travels through"),
// so switching between a desk test in air and the field needs NO re-upload.
#define SOUND_CM_PER_US  0.0343f   // ~343 m/s, air at ~20 °C
#define MEDIUM_NAME      "air"     // = units of distanceCm, not where the probe is

// ---------------- App settings ----------------
#define NODE_ID            "FS01"    // letters/digits only, max 8 characters
#define SEND_INTERVAL_MS   10000UL   // dashboard expects ~10 s between readings
#define ACK_TIMEOUT_MS     2000UL
#define SAMPLE_INTERVAL_MS 250UL     // JSN ping 4x per second, all the time
#define MAX_SAMPLES        64        // > SEND_INTERVAL_MS / SAMPLE_INTERVAL_MS
#define JSN_TIMEOUT_US     40000UL   // ~30 m in water / ~6.8 m in air

TinyGPSPlus gps;

uint32_t seq = 0, sentCount = 0, ackCount = 0, lastSend = 0, lastSample = 0;
float    samples[MAX_SAMPLES];
int      sampleCount = 0, pingCount = 0;
bool loraReady = false;

void feedGPS() {
  while (Serial2.available()) gps.encode(Serial2.read());
}

// ---------------- JSN-SR04T ----------------
float readDistanceOnce() {
  digitalWrite(JSN_TRIG, LOW);  delayMicroseconds(5);
  digitalWrite(JSN_TRIG, HIGH); delayMicroseconds(20);
  digitalWrite(JSN_TRIG, LOW);
  unsigned long us = pulseIn(JSN_ECHO, HIGH, JSN_TIMEOUT_US);
  return us ? us * SOUND_CM_PER_US / 2.0f : -1;   // round trip -> one way
}

// Continuous sampling: ping every SAMPLE_INTERVAL_MS for the whole report
// window, then report the MEDIAN (ignores waves, splashes and odd echoes)
// together with the min/max seen, so a bobbing float doesn't give one
// unlucky snapshot every 10 s.
void sampleIfDue() {
  if (millis() - lastSample < SAMPLE_INTERVAL_MS) return;
  lastSample = millis();
  pingCount++;
  float d = readDistanceOnce();
  if (d > 0 && sampleCount < MAX_SAMPLES) samples[sampleCount++] = d;
}

void closeWindow(float &median, float &minD, float &maxD, int &valid, int &pings) {
  int n = sampleCount;
  for (int i = 1; i < n; i++) {         // insertion sort
    float k = samples[i]; int j = i - 1;
    while (j >= 0 && samples[j] > k) { samples[j + 1] = samples[j]; j--; }
    samples[j + 1] = k;
  }
  if (n == 0)          { median = minD = maxD = -1; }
  else {
    median = (n % 2) ? samples[n / 2] : (samples[n / 2 - 1] + samples[n / 2]) / 2.0f;
    minD = samples[0];
    maxD = samples[n - 1];
  }
  valid = n;
  pings = pingCount;
  sampleCount = 0;                      // start the next window
  pingCount = 0;
}

// ---------------- LoRa ----------------
// The Ra-02's RST / DIO0 may be wired either way; both are tried at start-up:
//   wiring guide:     RST -> GPIO14, DIO0 -> GPIO26
//   older sketches:   RST -> GPIO2,  DIO0 -> GPIO4
// (DIO0 is not actually needed: packets are polled.) NSS 5, SCK 18, MISO 19,
// MOSI 23 and 3.3 V must be as in the guide. GPIO2 is also the on-board LED,
// so the LED is only used when RST is NOT on GPIO2.
const int RST_OPTIONS[2]  = {LORA_RST, 2};
const int DIO0_OPTIONS[2] = {LORA_DIO0, 4};
int  loraRstPin = -1;          // which RST pin worked (-1 = radio not found)
bool ledAllowed = false;
void led(bool on) { if (ledAllowed) digitalWrite(LED_PIN, on ? HIGH : LOW); }

bool setupLoRa() {
  loraRstPin = -1;
  for (int i = 0; i < 2 && loraRstPin < 0; i++) {
    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
    LoRa.setPins(LORA_NSS, RST_OPTIONS[i], DIO0_OPTIONS[i]);
    if (LoRa.begin(LORA_FREQ)) loraRstPin = RST_OPTIONS[i];
  }
  ledAllowed = (loraRstPin != LED_PIN);
  if (ledAllowed) pinMode(LED_PIN, OUTPUT);
  if (loraRstPin < 0) return false;          // dashboard shows lora.ready = false
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setCodingRate4(LORA_CR);
  LoRa.setSyncWord(LORA_SYNCWORD);
  LoRa.setTxPower(LORA_TX_POWER);
  LoRa.enableCrc();
  return true;
}

// Ground station replies:  ACK,<node>,<seq>,<rssi_at_station>
bool waitForAck(uint32_t expectSeq, int &stationRssi, int &ackRssi, float &ackSnr) {
  String prefix = String("ACK,") + NODE_ID + "," + String((unsigned long)expectSeq) + ",";
  uint32_t start = millis();
  while (millis() - start < ACK_TIMEOUT_MS) {
    feedGPS();
    sampleIfDue();                      // keep measuring while waiting
    if (LoRa.parsePacket()) {
      String msg;
      while (LoRa.available()) msg += (char)LoRa.read();
      if (msg.startsWith(prefix)) {
        stationRssi = msg.substring(prefix.length()).toInt();
        ackRssi = LoRa.packetRssi();
        ackSnr = LoRa.packetSnr();
        return true;
      }
    }
  }
  return false;
}

void setup() {
  Serial.begin(115200);

  pinMode(JSN_TRIG, OUTPUT);
  pinMode(JSN_ECHO, INPUT);
  digitalWrite(JSN_TRIG, LOW);

  Serial2.setRxBufferSize(1024);
  Serial2.begin(GPS_BAUD, SERIAL_8N1, GPS_RX, GPS_TX);

  loraReady = setupLoRa();
  lastSend = millis() - SEND_INTERVAL_MS + 2000;   // first report after ~2 s of samples
}

void loop() {
  feedGPS();
  sampleIfDue();

  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();
  seq++;

  // ---- 1. sensors ----
  float dist, minD, maxD;
  int   valid, pings;
  closeWindow(dist, minD, maxD, valid, pings);
  bool   fix   = gps.location.isValid() && gps.location.age() < 5000;
  int    sats  = gps.satellites.isValid() ? (int)gps.satellites.value() : 0;
  double lat   = fix ? gps.location.lat() : 0.0;
  double lng   = fix ? gps.location.lng() : 0.0;
  unsigned long chars = gps.charsProcessed();

  // ---- 2. LoRa send + wait for ACK ----
  bool acked = false;
  int stationRssi = 0, ackRssi = 0;
  float ackSnr = 0;
  if (loraReady) {
    char pkt[128];
    snprintf(pkt, sizeof(pkt), "%s,%lu,%.1f,%d,%.6f,%.6f,%d,%lu,%d,%d,%.1f,%.1f,%c",
             NODE_ID, (unsigned long)seq, dist, fix ? 1 : 0, lat, lng, sats, chars,
             valid, pings, minD, maxD, 'a');   // 'a' = air-calibrated units
    led(true);
    LoRa.beginPacket();
    LoRa.print(pkt);
    LoRa.endPacket();
    led(false);
    sentCount++;

    acked = waitForAck(seq, stationRssi, ackRssi, ackSnr);
    if (acked) {
      ackCount++;
      for (int i = 0; i < 2; i++) {      // double blink = ACK received
        led(true); delay(60); led(false); delay(80);
      }
    }
  }

  // ---- 3. one JSON line over USB for the dashboard ----
  char distStr[16], minStr[16], maxStr[16], latStr[16], lngStr[16], rssiStr[12], snrStr[12], stRssiStr[12];
  if (dist > 0) {
    snprintf(distStr, sizeof(distStr), "%.1f", dist);
    snprintf(minStr, sizeof(minStr), "%.1f", minD);
    snprintf(maxStr, sizeof(maxStr), "%.1f", maxD);
  } else { strcpy(distStr, "null"); strcpy(minStr, "null"); strcpy(maxStr, "null"); }
  if (fix) { snprintf(latStr, sizeof(latStr), "%.6f", lat); snprintf(lngStr, sizeof(lngStr), "%.6f", lng); }
  else     { strcpy(latStr, "null"); strcpy(lngStr, "null"); }
  if (acked) {
    snprintf(rssiStr, sizeof(rssiStr), "%d", ackRssi);
    snprintf(snrStr, sizeof(snrStr), "%.1f", ackSnr);
    snprintf(stRssiStr, sizeof(stRssiStr), "%d", stationRssi);
  } else { strcpy(rssiStr, "null"); strcpy(snrStr, "null"); strcpy(stRssiStr, "null"); }

  Serial.printf("{\"type\":\"node\",\"source\":\"usb\",\"medium\":\"" MEDIUM_NAME "\",\"node\":\"%s\",\"seq\":%lu,\"distanceCm\":%s,"
                "\"gps\":{\"fix\":%s,\"lat\":%s,\"lng\":%s,\"satellites\":%d,\"chars\":%lu},"
                "\"samples\":{\"valid\":%d,\"pings\":%d,\"minCm\":%s,\"maxCm\":%s},"
                "\"rssi\":%s,\"snr\":%s,\"lost\":0,"
                "\"lora\":{\"ready\":%s,\"rstPin\":%d,\"sent\":%lu,\"acked\":%lu,\"ackOk\":%s,\"stationRssi\":%s}}\n",
                NODE_ID, (unsigned long)seq, distStr,
                fix ? "true" : "false", latStr, lngStr, sats, chars,
                valid, pings, minStr, maxStr,
                rssiStr, snrStr,
                loraReady ? "true" : "false", loraRstPin, (unsigned long)sentCount, (unsigned long)ackCount,
                acked ? "true" : "false", stRssiStr);
}
