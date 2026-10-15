/**
 * Angle, coordinate, and vector helpers.
 *
 * Coordinate system (Minecraft / Mineflayer): right-handed, +X = east, +Y = up, +Z = south.
 *
 * Mineflayer entity rotation is stored in radians on `entity.yaw` and `entity.pitch`, in a
 * convention that is offset from the vanilla "notchian" yaw:
 *   - yaw = 0      faces north (-Z)
 *   - yaw = +PI/2  faces west  (-X)
 *   - yaw = -PI/2  faces east  (+X)
 *   - yaw = PI     faces south (+Z)
 *   - pitch = 0 is horizontal, positive pitch looks up, negative looks down, range [-PI/2, PI/2].
 *
 * To look at a point: `yaw = atan2(-dx, -dz)`, `pitch = atan2(dy, hypot(dx, dz))`, where
 * delta = target - botEye. This matches Mineflayer's own `bot.lookAt` (physics.js).
 */

export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Wrap an angle in radians to (-PI, PI]. */
export function normalizeRadians(angle: number): number {
  let value = angle % TWO_PI;
  if (value <= -Math.PI) value += TWO_PI;
  else if (value > Math.PI) value -= TWO_PI;
  return value;
}

/** Wrap an angle in degrees to [-180, 180). */
export function normalizeDegrees(angle: number): number {
  let value = angle % 360;
  if (value >= 180) value -= 360;
  else if (value < -180) value += 360;
  return value;
}

/** Smallest signed difference `a - b` in radians, wrapped to (-PI, PI]. */
export function angleDeltaRadians(a: number, b: number): number {
  return normalizeRadians(a - b);
}

/** Smallest signed difference `a - b` in degrees, wrapped to [-180, 180). */
export function angleDeltaDegrees(a: number, b: number): number {
  return normalizeDegrees(a - b);
}

export function vectorLength(v: Vec3Like): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function horizontalLength(v: Vec3Like): number {
  return Math.hypot(v.x, v.z);
}

export function subtract(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return vectorLength(subtract(a, b));
}

/** Yaw in Mineflayer's convention needed to face from `origin` toward `target`. */
export function yawTo(origin: Vec3Like, target: Vec3Like): number {
  return Math.atan2(-(target.x - origin.x), -(target.z - origin.z));
}

/** Pitch in Mineflayer's convention needed to face from `origin` toward `target`. */
export function pitchTo(origin: Vec3Like, target: Vec3Like): number {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  return Math.atan2(dy, Math.hypot(dx, dz));
}

/**
 * Bearing of `target` relative to the bot's current facing, in degrees.
 *
 * Positive means the target is to the bot's left (counter-clockwise), negative to the right,
 * and 0 means the bot is already facing the target.
 */
export function relativeYawDegrees(botYaw: number, origin: Vec3Like, target: Vec3Like): number {
  return normalizeDegrees(toDegrees(angleDeltaRadians(yawTo(origin, target), botYaw)));
}

/** Signed pitch difference in degrees between the bot's facing and where the target is. */
export function relativePitchDegrees(botPitch: number, origin: Vec3Like, target: Vec3Like): number {
  return normalizeDegrees(toDegrees(pitchTo(origin, target) - botPitch));
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
