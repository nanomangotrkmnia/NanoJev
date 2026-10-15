import { describe, expect, it } from "vitest";
import {
  angleDeltaDegrees,
  angleDeltaRadians,
  distance,
  normalizeDegrees,
  normalizeRadians,
  pitchTo,
  relativePitchDegrees,
  relativeYawDegrees,
  toDegrees,
  toRadians,
  yawTo,
} from "../src/minecraft/math.js";

describe("angle normalization", () => {
  it("wraps degrees into [-180, 180)", () => {
    expect(normalizeDegrees(0)).toBe(0);
    expect(normalizeDegrees(190)).toBe(-170);
    expect(normalizeDegrees(-190)).toBe(170);
    expect(normalizeDegrees(180)).toBe(-180);
    expect(normalizeDegrees(540)).toBe(-180);
  });

  it("wraps radians into (-PI, PI]", () => {
    expect(normalizeRadians(0)).toBe(0);
    expect(normalizeRadians(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(normalizeRadians(-Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeRadians(Math.PI * 0.5)).toBeCloseTo(Math.PI * 0.5);
  });

  it("computes shortest signed deltas", () => {
    expect(angleDeltaDegrees(10, 350)).toBe(20);
    expect(angleDeltaDegrees(350, 10)).toBe(-20);
    expect(angleDeltaRadians(toRadians(10), toRadians(350))).toBeCloseTo(toRadians(20));
  });

  it("round-trips degrees and radians", () => {
    expect(toDegrees(toRadians(42))).toBeCloseTo(42);
  });
});

describe("orientation toward a target (Mineflayer convention)", () => {
  const origin = { x: 0, y: 0, z: 0 };

  it("faces north at yaw 0", () => {
    // north is -Z
    expect(yawTo(origin, { x: 0, y: 0, z: -1 })).toBeCloseTo(0);
  });

  it("faces east at yaw -PI/2 and west at +PI/2", () => {
    expect(yawTo(origin, { x: 1, y: 0, z: 0 })).toBeCloseTo(-Math.PI / 2);
    expect(yawTo(origin, { x: -1, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2);
  });

  it("faces south at +/-PI", () => {
    expect(Math.abs(yawTo(origin, { x: 0, y: 0, z: 1 }))).toBeCloseTo(Math.PI);
  });

  it("pitches up for targets above and down for targets below", () => {
    expect(pitchTo(origin, { x: 0, y: 1, z: -1 })).toBeGreaterThan(0);
    expect(pitchTo(origin, { x: 0, y: -1, z: -1 })).toBeLessThan(0);
    expect(pitchTo(origin, { x: 0, y: 0, z: -1 })).toBeCloseTo(0);
  });

  it("reports relative yaw with positive meaning the target is to the left", () => {
    // facing north (0), target to the west => +90 (left)
    expect(relativeYawDegrees(0, origin, { x: -1, y: 0, z: 0 })).toBeCloseTo(90);
    // facing north, target to the east => -90 (right)
    expect(relativeYawDegrees(0, origin, { x: 1, y: 0, z: 0 })).toBeCloseTo(-90);
    // facing north, target north => 0
    expect(relativeYawDegrees(0, origin, { x: 0, y: 0, z: -1 })).toBeCloseTo(0);
  });

  it("reports relative pitch sign", () => {
    expect(relativePitchDegrees(0, origin, { x: 0, y: 1, z: -1 })).toBeGreaterThan(0);
  });
});

describe("distance", () => {
  it("measures euclidean distance", () => {
    expect(distance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBeCloseTo(5);
  });
});
