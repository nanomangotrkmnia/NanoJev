import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildLegalActions, observationSignature } from "../src/actions.js";
import { makeObservation, makeSelf, makeTarget } from "./helpers/observation.js";

const config = loadConfig({ env: {} });

function ids(obs: ReturnType<typeof makeObservation>): string[] {
  return buildLegalActions(obs, config).map((action) => action.id);
}

describe("buildLegalActions", () => {
  it("only offers hold_position when there is no target", () => {
    expect(ids(makeObservation({ target: null }))).toEqual(["hold_position"]);
  });

  it("only offers hold_position when the target is invalid, dead, or out of range", () => {
    expect(ids(makeObservation({ target: makeTarget({ valid: false }) }))).toEqual(["hold_position"]);
    expect(ids(makeObservation({ target: makeTarget({ alive: false, health: 0 }) }))).toEqual(["hold_position"]);
    expect(ids(makeObservation({ target: makeTarget({ inRange: false, distance: 40 }) }))).toEqual(["hold_position"]);
    expect(ids(makeObservation({ target: makeTarget({ visible: false }) }))).toEqual(["hold_position"]);
  });

  it("offers approach actions but not attacks when out of melee range", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 10 }) }));
    expect(result).toContain("approach");
    expect(result).toContain("close_distance_sprinting");
    expect(result).not.toContain("attack_target");
    expect(result).not.toContain("jump_attack");
    expect(result).toEqual(expect.arrayContaining(["track_target", "hold_position"]));
  });

  it("offers attacks when in range and off cooldown", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 2 }), self: makeSelf({ attackReady: true }) }));
    expect(result).toContain("attack_target");
    expect(result).toContain("jump_attack");
  });

  it("lets the model choose between a normal attack and a W-tap", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 2 }), self: makeSelf({ attackReady: true }) }));
    expect(result).toContain("attack_target");
    expect(result).toContain("sprint_reset_attack");
  });

  it("does not offer a W-tap when it is disabled", () => {
    const disabled = loadConfig({ env: { NANOJEV_WTAP_ENABLED: "false" } });
    const result = buildLegalActions(makeObservation({ target: makeTarget({ distance: 2 }) }), disabled).map((a) => a.id);
    expect(result).not.toContain("sprint_reset_attack");
    expect(result).toContain("attack_target");
  });

  it("does not offer a W-tap outside melee range", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 10 }) }));
    expect(result).not.toContain("sprint_reset_attack");
  });

  it("offers hitselect and jump reset when grounded and in melee range", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 2 }), self: makeSelf({ attackReady: true, onGround: true }) }));
    expect(result).toContain("hitselect");
    expect(result).toContain("jump_reset");
  });

  it("withholds jump-based techniques while airborne", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 2 }), self: makeSelf({ attackReady: true, onGround: false }) }));
    expect(result).not.toContain("hitselect");
    expect(result).not.toContain("jump_reset");
  });

  it("honors the technique toggles", () => {
    const disabled = loadConfig({ env: { NANOJEV_HITSELECT_ENABLED: "false", NANOJEV_JUMP_RESET_ENABLED: "false" } });
    const result = buildLegalActions(makeObservation({ target: makeTarget({ distance: 2 }) }), disabled).map((a) => a.id);
    expect(result).not.toContain("hitselect");
    expect(result).not.toContain("jump_reset");
    expect(result).toContain("attack_target");
  });

  it("withholds attack actions while the attack is on cooldown", () => {
    const result = ids(makeObservation({ target: makeTarget({ distance: 2 }), self: makeSelf({ attackReady: false }) }));
    expect(result).not.toContain("attack_target");
    expect(result).not.toContain("jump_attack");
  });

  it("withholds jump_attack when the bot is airborne", () => {
    const result = ids(
      makeObservation({ target: makeTarget({ distance: 2 }), self: makeSelf({ attackReady: true, onGround: false }) }),
    );
    expect(result).toContain("attack_target");
    expect(result).not.toContain("jump_attack");
  });

  it("offers raise_shield only when a shield is available", () => {
    const withoutShield = ids(makeObservation({ self: makeSelf({ shieldAvailable: false }) }));
    const withShield = ids(makeObservation({ self: makeSelf({ shieldAvailable: true }) }));
    expect(withoutShield).not.toContain("raise_shield");
    expect(withShield).toContain("raise_shield");
  });

  it("does not offer movement through solid obstacles (no open directions)", () => {
    const obs = makeObservation({
      target: makeTarget({ distance: 2 }),
      environment: {
        dimension: "minecraft:overworld",
        movingInto: { north: false, south: false, east: false, west: false },
        openDirectionCount: 0,
        groundBelow: true,
        inWater: false,
        inLava: false,
        nearbyHostiles: 0,
        visibilityMethod: "raycast",
      },
    });
    const result = ids(obs);
    expect(result).not.toContain("approach");
    expect(result).not.toContain("strafe_left");
    expect(result).not.toContain("reposition");
    expect(result).not.toContain("sprint_reset_attack");
    expect(result).toContain("attack_target");
    expect(result).toContain("hold_position");
  });

  it("offers retreat when health is low even beyond strafe range", () => {
    const obs = makeObservation({ target: makeTarget({ distance: 12 }), self: makeSelf({ health: 4 }) });
    expect(ids(obs)).toContain("retreat");
  });

  it("gives every offered action a non-empty description", () => {
    const actions = buildLegalActions(makeObservation({ self: makeSelf({ shieldAvailable: true }) }), config);
    expect(actions.length).toBeGreaterThan(3);
    for (const action of actions) {
      expect(action.description.length).toBeGreaterThan(10);
    }
  });
});

describe("observationSignature", () => {
  it("is stable for the same material state and changes when distance buckets change", () => {
    const near = makeObservation({ target: makeTarget({ distance: 2.1 }) });
    const near2 = makeObservation({ target: makeTarget({ distance: 2.4 }) });
    const far = makeObservation({ target: makeTarget({ distance: 9 }) });

    expect(observationSignature(near, config)).toBe(observationSignature(near2, config));
    expect(observationSignature(near, config)).not.toBe(observationSignature(far, config));
  });

  it("returns a no-target signature without a target", () => {
    expect(observationSignature(makeObservation({ target: null }), config)).toBe("no-target");
  });
});
