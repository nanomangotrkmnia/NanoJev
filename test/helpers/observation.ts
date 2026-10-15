import type { Observation, SelfState, TargetState } from "../../src/state.js";

export function makeSelf(overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: "NanoJev",
    position: { x: 0, y: 64, z: 0 },
    yawDeg: 0,
    pitchDeg: 0,
    velocity: { x: 0, y: 0, z: 0 },
    speed: 0,
    onGround: true,
    health: 20,
    food: 20,
    heldItem: "iron_sword",
    shieldAvailable: false,
    armor: [],
    inventory: { sword: true, axe: false, food: 0, blocks: 0, totalItems: 1 },
    attackReady: true,
    ...overrides,
  };
}

export function makeTarget(overrides: Partial<TargetState> = {}): TargetState {
  return {
    id: 42,
    username: "Steve",
    valid: true,
    alive: true,
    distance: 2,
    relativeYawDeg: 5,
    relativePitchDeg: 0,
    position: { x: 2, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true,
    health: 20,
    inRange: true,
    visible: true,
    ...overrides,
  };
}

export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  const target = overrides.target === undefined ? makeTarget() : overrides.target;
  return {
    tick: 1,
    sampledAtMs: 1000,
    self: overrides.self ?? makeSelf(),
    target,
    environment: overrides.environment ?? {
      dimension: "minecraft:overworld",
      movingInto: { north: true, south: true, east: true, west: true },
      openDirectionCount: 4,
      groundBelow: true,
      inWater: false,
      inLava: false,
      nearbyHostiles: 0,
      visibilityMethod: "raycast",
    },
    sources: overrides.sources ?? {
      targetHealth: "measured",
      visibility: "estimated",
      attackReady: "estimated",
    },
  };
}
