// Temporary GPS-only diagnostic for ESP32 DevKit V1.
// Install TinyGPSPlus by Mikal Hart. GPS TX -> GPIO16; common GND.
// GPS RX is unnecessary: this sketch sends no configuration to the GPS.
// Open Arduino Serial Monitor at 115200 baud. Disconnect dashboard first.
#include <TinyGPSPlus.h>

HardwareSerial gpsSerial(2);
const unsigned long BAUDS[] = {9600, 38400, 4800, 57600, 19200, 115200};
unsigned long foundBaud = 0;

void scanBaud(unsigned long baud) {
  gpsSerial.end();
  gpsSerial.setRxBufferSize(2048);
  gpsSerial.begin(baud, SERIAL_8N1, 16, 17);
  delay(150);
  while (gpsSerial.available()) gpsSerial.read();
  TinyGPSPlus parser;
  uint8_t sample[240];
  size_t sampleSize = 0;
  unsigned long bytes = 0;
  Serial.print("\nTesting GPS baud: "); Serial.println(baud);
  const unsigned long start = millis();
  while (millis() - start < 8000) {
    while (gpsSerial.available()) {
      const uint8_t c = gpsSerial.read();
      parser.encode(c);
      bytes++;
      if (sampleSize < sizeof(sample)) sample[sampleSize++] = c;
    }
    delay(1);
  }
  Serial.print("Bytes: "); Serial.print(bytes);
  Serial.print(" | Valid NMEA checksums: "); Serial.print(parser.passedChecksum());
  Serial.print(" | Failed checksums: "); Serial.println(parser.failedChecksum());
  Serial.println("First bytes as text (nonprintable = .):");
  for (size_t i = 0; i < sampleSize; i++) {
    const uint8_t c = sample[i];
    Serial.write(c == '\r' || c == '\n' || (c >= 32 && c <= 126) ? c : '.');
  }
  Serial.println("\nFirst bytes as HEX:");
  for (size_t i = 0; i < sampleSize; i++) {
    if (sample[i] < 16) Serial.print('0');
    Serial.print(sample[i], HEX); Serial.print(' ');
  }
  Serial.println();
  if (parser.passedChecksum() >= 2) foundBaud = baud;
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("GPS diagnostic: scanning UART2 RX GPIO16. No satellite fix required.");
  for (unsigned long baud : BAUDS) {
    scanBaud(baud);
    if (foundBaud) break;
  }
  if (foundBaud) {
    Serial.print("\nFOUND valid NMEA at "); Serial.print(foundBaud);
    Serial.println(" baud. Use this baud in your GPS/LoRa sketch. Raw GPS output follows:");
  } else {
    Serial.println("\nNo valid NMEA at tested rates. Send the text/HEX summaries for diagnosis.");
    Serial.println("Check TX pin label, common ground, jumper continuity and GPS power.");
    Serial.println("Binary output is also possible; this scan only confirms NMEA.");
    gpsSerial.end();
  }
}

void loop() {
  if (foundBaud) {
    while (gpsSerial.available()) Serial.write(gpsSerial.read());
  }
  delay(1);
}
