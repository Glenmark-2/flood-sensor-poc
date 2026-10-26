// Sound-speed conversion for the JSN-SR04T.
// The flood sensor sends every distance "air-calibrated" (echo time × 343 m/s ÷ 2).
// The dashboard converts it to the medium the sound actually travelled through,
// so switching between a desk test (air) and the field (water) needs no reflash.

export const AIR_SPEED = 343;            // m/s at ~20 °C
export const DEFAULT_WATER_SPEED = 1480; // m/s, fresh water ~20 °C (≈1500 at 30 °C)
// Older flood_node.ino builds converted to water themselves (0.148 cm/µs) and said medium "water".
const OLD_FIRMWARE_WATER_FACTOR = 0.148 / 0.0343;

const scaleSamples = (s, k) => s && { ...s, minCm: s.minCm == null ? null : s.minCm * k, maxCm: s.maxCm == null ? null : s.maxCm * k };
const scaleItem = (item, k) => item.distanceCm == null && !item.samples ? item
  : { ...item, distanceCm: item.distanceCm == null ? null : item.distanceCm * k, samples: scaleSamples(item.samples, k) };

// Bring any packet/reading back to air-calibrated cm (undo an old firmware's own water conversion).
export function toAirCalibrated(item) {
  return item.medium === 'water' ? { ...scaleItem(item, 1 / OLD_FIRMWARE_WATER_FACTOR), medium: 'air' } : item;
}

// Multiply factor for the chosen medium.
export function speedFactor(medium, waterSpeed) {
  const v = Number(waterSpeed);
  return medium === 'water' ? (Number.isFinite(v) && v > 0 ? v : DEFAULT_WATER_SPEED) / AIR_SPEED : 1;
}

// Air-calibrated item -> distances in the chosen medium.
export const inMedium = (item, factor) => factor === 1 ? item : scaleItem(item, factor);
