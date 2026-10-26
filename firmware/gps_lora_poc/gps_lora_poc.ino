// ESP32 DevKit V1 + NEO-6M + RA-02. Install TinyGPSPlus and LoRa.
// Attach a suitable antenna before powering/transmitting. RA-02 uses 3.3 V.
#include <SPI.h>
#include <LoRa.h>
#include <TinyGPSPlus.h>

// Flash the second board with TRANSMIT = false to prove radio reception.
constexpr bool TRANSMIT = true;
constexpr long FREQUENCY = 433000000; // Match both radios and local permitted band.
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);
bool radioReady = false;
unsigned long txCount = 0, rxCount = 0, lastReport = 0, lastSend = 0;
unsigned long lastGpsByte = 0;
int lastRssi = 0;
String lastPacket;

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600, SERIAL_8N1, 16, 17);
  SPI.begin(18, 19, 23, 5);
  LoRa.setPins(5, 2, 4);
  radioReady = LoRa.begin(FREQUENCY) == 1;
  if (radioReady) {
    LoRa.setTxPower(2);
    LoRa.setSpreadingFactor(7);
    LoRa.setSignalBandwidth(125000);
    LoRa.setCodingRate4(5);
    LoRa.setSyncWord(0x12);
    LoRa.enableCrc();
  }
}

void loop() {
  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
    lastGpsByte = millis();
  }
  const unsigned long now = millis();
  if (radioReady) {
    if (LoRa.parsePacket()) {
      lastPacket = "";
      while (LoRa.available()) {
        char c = (char)LoRa.read();
        // Printable packet preview, safe for JSON without another library.
        lastPacket += (c >= 32 && c <= 126 && c != '"' && c != '\\') ? c : '?';
      }
      lastRssi = LoRa.packetRssi();
      rxCount++;
    }
    if (TRANSMIT && now - lastSend >= 5000) {
      lastSend = now;
      if (LoRa.beginPacket()) {
        LoRa.print("ESP32 POC #");
        LoRa.print(txCount + 1);
        if (LoRa.endPacket() == 1) txCount++;
      }
    }
  }
  if (now - lastReport >= 1000) {
    lastReport = now;
    const bool fix = gps.location.isValid() && gps.location.age() < 3000 &&
                     gps.charsProcessed() > 0 && now - lastGpsByte < 3000;
    Serial.print("{\"type\":\"hardware\",\"gps\":{\"chars\":");
    Serial.print(gps.charsProcessed());
    Serial.print(",\"sentences\":"); Serial.print(gps.passedChecksum());
    Serial.print(",\"satellites\":");
    Serial.print(gps.satellites.isValid() && gps.satellites.age() < 3000 ? gps.satellites.value() : 0);
    Serial.print(",\"fix\":"); Serial.print(fix ? "true" : "false");
    Serial.print(",\"lat\":");
    if (fix) Serial.print(gps.location.lat(), 6); else Serial.print("null");
    Serial.print(",\"lng\":");
    if (fix) Serial.print(gps.location.lng(), 6); else Serial.print("null");
    Serial.print("},\"lora\":{\"ready\":"); Serial.print(radioReady ? "true" : "false");
    Serial.print(",\"frequencyMHz\":"); Serial.print(FREQUENCY / 1000000.0, 3);
    Serial.print(",\"tx\":"); Serial.print(txCount);
    Serial.print(",\"rx\":"); Serial.print(rxCount);
    Serial.print(",\"rssi\":");
    if (rxCount) Serial.print(lastRssi); else Serial.print("null");
    Serial.print(",\"lastPacket\":\""); Serial.print(lastPacket);
    Serial.println("\"}}");
  }
}
