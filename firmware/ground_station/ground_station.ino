/*
  ================================================================
  ground_station.ino  —  LoRa ground station for the dashboard
  ================================================================
  Hardware : second ESP32 DevKit V1 + SX1278 Ra-02 (433 MHz), USB to PC.
               Ra-02 3.3V -> 3V3   GND -> GND
               SCK -> 18   MISO -> 19   MOSI -> 23
               NSS -> 5    RST  -> 14   DIO0 -> 26
             (same LoRa pins as the node; no GPS / JSN needed here)

  What it does:
    - Receives packets from flood_node.ino.
    - Replies  ACK,<node>,<seq>,<rssi>  so the node knows it was heard.
    - Prints ONE JSON object per line over USB at 115200 baud, which the
      dashboard (npm run dev -> Connect Sensor) reads:

      every received reading:
        {"type":"node","node":"FS01","seq":12,"distanceCm":35.8,"medium":"air",
         "samples":{"valid":38,"pings":40,"minCm":34.7,"maxCm":37.4},
         "gps":{"fix":true,"lat":14.651234,"lng":121.049876,"satellites":7,"chars":48211},
         "rssi":-62,"snr":9.5,"lost":0}
        (distanceCm is null when the sensor got no echo)

      every 2 s (heartbeat):
        {"type":"station","ready":true,"frequencyMHz":433.000,"sf":9,
         "bandwidthKHz":125,"rx":12,"lost":0,"acks":12,"unknown":0,
         "lastUnknown":"","uptimeS":130,"rstPin":14}
        (ready:false + rstPin:-1 = Ra-02 not found: check its wiring/3.3 V)

  Close Arduino Serial Monitor before connecting the dashboard.

  Library : "LoRa" by Sandeep Mistry
  Board   : "ESP32 Dev Module" (or "DOIT ESP32 DEVKIT V1")
  ================================================================
*/

#include <SPI.h>
#include <LoRa.h>

// ---------------- Pins ----------------
#define LORA_SCK    18
#define LORA_MISO   19
#define LORA_MOSI   23
#define LORA_NSS     5
#define LORA_RST    14
#define LORA_DIO0   26
#define LED_PIN      2

// ------- Radio settings (MUST match flood_node.ino) -------
#define LORA_FREQ      433E6
#define LORA_SF        9
#define LORA_BW        125E3
#define LORA_CR        5
#define LORA_SYNCWORD  0x34
#define LORA_TX_POWER  17

#define HEARTBEAT_MS   2000UL
#define MAX_NODES      8

bool     radioReady = false;
uint32_t rxCount = 0, lostCount = 0, ackCount = 0, unknownCount = 0;
uint32_t lastBeat = 0, lastInitTry = 0;
char     lastUnknown[64] = "";

struct NodeState { char id[9]; uint32_t lastSeq; uint32_t lost; };
NodeState nodes[MAX_NODES];
int nodeCount = 0;

NodeState *findNode(const char *id) {
  for (int i = 0; i < nodeCount; i++)
    if (strcmp(nodes[i].id, id) == 0) return &nodes[i];
  if (nodeCount == MAX_NODES) return nullptr;
  NodeState *n = &nodes[nodeCount++];
  strncpy(n->id, id, 8); n->id[8] = 0;
  n->lastSeq = 0; n->lost = 0;
  return n;
}

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

bool initRadio() {
  loraRstPin = -1;
  for (int i = 0; i < 2 && loraRstPin < 0; i++) {
    SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
    LoRa.setPins(LORA_NSS, RST_OPTIONS[i], DIO0_OPTIONS[i]);
    if (LoRa.begin(LORA_FREQ)) loraRstPin = RST_OPTIONS[i];
  }
  if (loraRstPin < 0) return false;
  ledAllowed = (loraRstPin != LED_PIN);
  if (ledAllowed) pinMode(LED_PIN, OUTPUT);
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setCodingRate4(LORA_CR);
  LoRa.setSyncWord(LORA_SYNCWORD);
  LoRa.setTxPower(LORA_TX_POWER);
  LoRa.enableCrc();
  return true;
}

void printHeartbeat() {
  Serial.printf("{\"type\":\"station\",\"ready\":%s,\"frequencyMHz\":%.3f,\"sf\":%d,"
                "\"bandwidthKHz\":%d,\"rx\":%lu,\"lost\":%lu,\"acks\":%lu,\"unknown\":%lu,"
                "\"lastUnknown\":\"%s\",\"uptimeS\":%lu,\"rstPin\":%d}\n",
                radioReady ? "true" : "false", LORA_FREQ / 1e6, LORA_SF, (int)(LORA_BW / 1000),
                (unsigned long)rxCount, (unsigned long)lostCount, (unsigned long)ackCount,
                (unsigned long)unknownCount, lastUnknown, (unsigned long)(millis() / 1000), loraRstPin);
}

// Keep a JSON-safe preview of packets that are not flood-node readings.
void rememberUnknown(const char *msg) {
  unknownCount++;
  size_t j = 0;
  for (size_t i = 0; msg[i] && j < sizeof(lastUnknown) - 1; i++) {
    char c = msg[i];
    lastUnknown[j++] = (c >= 32 && c <= 126 && c != '"' && c != '\\') ? c : '?';
  }
  lastUnknown[j] = 0;
}

bool validId(const char *s) {
  size_t n = strlen(s);
  if (n == 0 || n > 8) return false;
  for (size_t i = 0; i < n; i++) if (!isalnum((unsigned char)s[i])) return false;
  return true;
}

// Parses "node,seq,dist,fix,lat,lng,sats,chars[,valid,pings,min,max,medium]".
// The last 5 fields (sample summary + w/a medium) come from the current
// flood_node.ino; older nodes send only the first 8. Returns false if malformed.
bool handleReading(char *msg, int rssi, float snr) {
  char *f[13]; int n = 0;
  char *save = nullptr;
  for (char *t = strtok_r(msg, ",", &save); t && n < 13; t = strtok_r(nullptr, ",", &save)) f[n++] = t;
  if ((n != 8 && n != 13) || strtok_r(nullptr, ",", &save)) return false;
  if (!validId(f[0])) return false;

  char *end;
  unsigned long seq = strtoul(f[1], &end, 10);   if (*end || seq == 0) return false;
  float dist  = strtof(f[2], &end);              if (*end) return false;
  long  fix   = strtol(f[3], &end, 10);          if (*end || (fix != 0 && fix != 1)) return false;
  double lat  = strtod(f[4], &end);              if (*end || fabs(lat) > 90) return false;
  double lng  = strtod(f[5], &end);              if (*end || fabs(lng) > 180) return false;
  long  sats  = strtol(f[6], &end, 10);          if (*end || sats < 0) return false;
  unsigned long chars = strtoul(f[7], &end, 10); if (*end) return false;
  long valid = -1, pings = -1; float minD = -1, maxD = -1; char medium = 0;
  if (n == 13) {
    valid = strtol(f[8], &end, 10);  if (*end || valid < 0) return false;
    pings = strtol(f[9], &end, 10);  if (*end || pings < valid) return false;
    minD  = strtof(f[10], &end);     if (*end) return false;
    maxD  = strtof(f[11], &end);     if (*end) return false;
    if (strcmp(f[12], "w") && strcmp(f[12], "a")) return false;
    medium = f[12][0];
  }

  NodeState *node = findNode(f[0]);
  if (node) {
    if (node->lastSeq && seq > node->lastSeq + 1) {
      uint32_t gap = seq - node->lastSeq - 1;
      node->lost += gap; lostCount += gap;
    }
    node->lastSeq = seq;                 // a lower seq means the node rebooted
  }

  // ACK first so the node is not left waiting while we print
  delay(50);
  LoRa.beginPacket();
  LoRa.printf("ACK,%s,%lu,%d", f[0], seq, rssi);
  if (LoRa.endPacket()) ackCount++;

  char distStr[16], latStr[16], lngStr[16];
  if (dist > 0) snprintf(distStr, sizeof(distStr), "%.1f", dist); else strcpy(distStr, "null");
  if (fix)  { snprintf(latStr, sizeof(latStr), "%.6f", lat); snprintf(lngStr, sizeof(lngStr), "%.6f", lng); }
  else      { strcpy(latStr, "null"); strcpy(lngStr, "null"); }

  // Optional extras from the current node: medium + sample summary of the 10 s window
  char extra[128] = "";
  if (n == 13) {
    char minStr[16], maxStr[16];
    if (valid > 0) { snprintf(minStr, sizeof(minStr), "%.1f", minD); snprintf(maxStr, sizeof(maxStr), "%.1f", maxD); }
    else           { strcpy(minStr, "null"); strcpy(maxStr, "null"); }
    snprintf(extra, sizeof(extra), "\"medium\":\"%s\",\"samples\":{\"valid\":%ld,\"pings\":%ld,\"minCm\":%s,\"maxCm\":%s},",
             medium == 'w' ? "water" : "air", valid, pings, minStr, maxStr);
  }

  Serial.printf("{\"type\":\"node\",\"node\":\"%s\",\"seq\":%lu,\"distanceCm\":%s,%s"
                "\"gps\":{\"fix\":%s,\"lat\":%s,\"lng\":%s,\"satellites\":%ld,\"chars\":%lu},"
                "\"rssi\":%d,\"snr\":%.1f,\"lost\":%lu}\n",
                f[0], seq, distStr, extra, fix ? "true" : "false", latStr, lngStr, sats, chars,
                rssi, snr, (unsigned long)(node ? node->lost : 0));
  return true;
}

void setup() {
  Serial.begin(115200);
  radioReady = initRadio();          // also sets up the LED if GPIO2 is free
  lastInitTry = millis();
  printHeartbeat();
}

void loop() {
  uint32_t now = millis();

  if (!radioReady && now - lastInitTry > 5000) {   // keep retrying, dashboard shows ready:false
    radioReady = initRadio();
    lastInitTry = now;
  }

  if (radioReady) {
    int size = LoRa.parsePacket();
    if (size) {
      char msg[128]; int i = 0;
      while (LoRa.available()) {
        char c = (char)LoRa.read();
        if (i < (int)sizeof(msg) - 1) msg[i++] = c;
      }
      msg[i] = 0;
      int rssi = LoRa.packetRssi();
      float snr = LoRa.packetSnr();
      rxCount++;
      led(true);

      char copy[128];
      strcpy(copy, msg);
      if (strncmp(msg, "ACK,", 4) == 0 || !handleReading(copy, rssi, snr)) rememberUnknown(msg);

      led(false);
    }
  }

  if (now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    printHeartbeat();
  }
}
