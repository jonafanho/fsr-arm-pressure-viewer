/*
 * ESP32-WROOM-32E / NodeMCU-32 V1.3 (30-pin)
 * Eight FSR channels -> V3 144-byte frames -> Python acquisition service.
 *
 * Wiring, all eight channels on pins exposed by that board:
 *   F0..F3 ADC1: GPIO 32, 33, 34, 35
 *   F4..F7 ADC2: GPIO 25, 26, 27, 13
 *
 * None of these eight pins is a boot-strapping pin, so a pad that happens to
 * be pressed during power-up or flashing cannot change the boot mode or the
 * flash rail. GPIO 25, 26, 27 and 13 are ADC2, which only converts while Wi-Fi
 * and Bluetooth are off. This firmware never starts the radio: the board
 * streams over USB serial at 921600 baud, matching frontend/core.py.
 *
 * No OLED is fitted on this build; the browser UI is the display.
 */
#include <Arduino.h>

static const uint8_t FSR_COUNT = 8;
static const uint8_t FSR_PINS[FSR_COUNT] = {32, 33, 34, 35, 25, 26, 27, 13};
static const uint8_t OVERSAMPLE = 4;
static const uint32_t SAMPLE_PERIOD_US = 10000;  // 100 Hz
static const uint32_t SERIAL_BAUD = 921600;

#pragma pack(push, 1)
struct V3Frame {
  uint8_t magic[2];       // A5 5A
  uint8_t version;        // 3
  uint8_t flags;          // bit 0x04 = FSR-only frame; 0x09 = IMU unavailable
  uint16_t payload_length;// 134 (frame size - 10)
  uint32_t sample_id;
  uint32_t raw_time_us;
  uint32_t reset_count;
  float accel[3];
  float gyro[3];
  float mag[3];
  float linear[3];
  float quaternion[4];
  float heading_accuracy;
  uint8_t statuses[5];
  uint8_t fresh_mask;
  uint16_t ages_ms[5];
  uint8_t sequences[5];
  uint8_t diagnostic_code;
  uint16_t fsr[16];       // first 8 channels are used
  uint32_t crc32;         // CRC32/IEEE over bytes 2..139
};
#pragma pack(pop)

static_assert(sizeof(V3Frame) == 144, "V3 frame must be exactly 144 bytes");

// Standard CRC-32/ISO-HDLC, identical to Python's zlib.crc32.
static uint32_t crc32_ieee(const uint8_t *data, size_t length) {
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      const uint32_t mask = 0u - (crc & 1u);
      crc = (crc >> 1) ^ (0xEDB88320u & mask);
    }
  }
  return ~crc;
}

static uint16_t readAveraged(uint8_t pin) {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < OVERSAMPLE; ++i) {
    sum += analogRead(pin);
  }
  return static_cast<uint16_t>(sum / OVERSAMPLE);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(50);

  analogReadResolution(12);
  for (uint8_t i = 0; i < FSR_COUNT; ++i) {
    pinMode(FSR_PINS[i], INPUT);
    analogSetPinAttenuation(FSR_PINS[i], ADC_11db);
  }

  Serial.println(F("FSR8 V3 100Hz ready"));
}

void loop() {
  static uint32_t next_us = micros();
  static uint32_t sample_id = 0;

  const uint32_t now = micros();
  const int32_t wait = static_cast<int32_t>(next_us - now);
  if (wait > 0) {
    delayMicroseconds(wait > 2000 ? 1000 : static_cast<uint32_t>(wait));
    return;
  }

  next_us += SAMPLE_PERIOD_US;
  if (static_cast<int32_t>(now - next_us) > 100000) {
    next_us = now + SAMPLE_PERIOD_US;  // recover after a long stall
  }

  V3Frame frame = {};
  frame.magic[0] = 0xA5;
  frame.magic[1] = 0x5A;
  frame.version = 3;
  // Bit 0x04 tells the service this frame carries no IMU. When the BNO080 is
  // fitted, clear 0x04 and the 0x09 "IMU invalid" bits so the device page
  // reveals the calibration/attitude/kinematic panels. A future sEMG stream
  // should use a new frame version rather than overloading these bits.
  frame.flags = 0x0D;  // FSR-only (0x04) + IMU invalid (0x09)
  frame.payload_length = 134;
  frame.sample_id = sample_id++;
  frame.raw_time_us = micros();
  frame.reset_count = 1;
  // IMU reports are deliberately marked unavailable. The pressure map and FSR
  // waveform only need fsr[0..7]; the remaining bytes keep the V3 layout valid.
  frame.fresh_mask = 0;
  for (uint8_t i = 0; i < 5; ++i) {
    frame.statuses[i] = 0;
    frame.ages_ms[i] = 0xFFFF;
    frame.sequences[i] = 0;
  }
  frame.diagnostic_code = 0;

  for (uint8_t i = 0; i < FSR_COUNT; ++i) {
    const uint16_t value = readAveraged(FSR_PINS[i]);
    frame.fsr[i] = value;
  }
  for (uint8_t i = FSR_COUNT; i < 16; ++i) {
    frame.fsr[i] = 0;
  }

  frame.crc32 = crc32_ieee(
      reinterpret_cast<const uint8_t *>(&frame) + 2,
      sizeof(V3Frame) - 6);  // bytes 2..139 inclusive

  Serial.write(reinterpret_cast<const uint8_t *>(&frame), sizeof(V3Frame));
}
