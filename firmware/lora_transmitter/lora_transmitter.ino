// Standalone ESP32 DevKit V1 + RA-02 transmitter. No GPS required.
// Install "LoRa" by Sandeep Mistry. Attach antenna before transmitting.
// RA-02 VCC = 3.3 V; common GND.
// SCK=18, MISO=19, MOSI=23, NSS=5, RST=2, DIO0=4.
#include <SPI.h>
#include <LoRa.h>

constexpr long FREQUENCY = 433000000; // Match receiver and locally permitted band.
unsigned long packetCount = 0;

void setup() {
  Serial.begin(115200);
  SPI.begin(18, 19, 23, 5);
  LoRa.setPins(5, 2, 4);
  if (!LoRa.begin(FREQUENCY)) {
    Serial.println("LoRa initialization failed. Check wiring and 3.3 V power.");
    while (true) delay(1000);
  }
  LoRa.setTxPower(2);
  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125000);
  LoRa.setCodingRate4(5);
  LoRa.setSyncWord(0x12);
  LoRa.enableCrc();
  Serial.println("LoRa transmitter ready.");
}

void loop() {
  if (LoRa.beginPacket()) {
    LoRa.print("HELLO from transmitter #");
    LoRa.print(packetCount + 1);
    if (LoRa.endPacket() == 1) {
      packetCount++;
      Serial.print("Sent packet #");
      Serial.println(packetCount);
    } else {
      Serial.println("Transmission failed.");
    }
  } else {
    Serial.println("Radio busy; retrying in 5 seconds.");
  }
  delay(5000);
}
