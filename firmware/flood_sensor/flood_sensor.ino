// AJ-SR04M in GPIO trigger/echo mode. Real measurements only.
constexpr uint8_t TRIG_PIN = 5;
constexpr uint8_t ECHO_PIN = 18;
constexpr unsigned long ECHO_TIMEOUT_US = 60000;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);
}

void loop() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(5);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(20);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (duration > 0) {
    const float distanceCm = duration * 0.0343f / 2.0f;
    Serial.print("{\"distanceCm\":");
    Serial.print(distanceCm, 1);
    Serial.println("}");
  } else {
    // No echo is not a zero-distance reading. Dashboard rejects this diagnostic.
    Serial.println("{\"error\":\"no_echo\"}");
  }
  delay(200);
}
