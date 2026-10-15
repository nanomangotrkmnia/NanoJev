import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CombatExecutor } from "../src/combat/executor.js";
import { createLogger } from "../src/logger.js";
import { createFakeBot, type FakeBot } from "./helpers/fakeBot.js";
import type { CombatActionId } from "../src/state.js";

const logger = createLogger({ level: "error", sink: () => {} });

function lastControlMap(fake: FakeBot): Record<string, boolean> {
  const batch = fake.calls.controls.slice(-7);
  const map: Record<string, boolean> = {};
  for (const entry of batch) map[entry.control] = entry.state;
  return map;
}

function makeExecutor(fake: FakeBot, env: Record<string, string> = {}): CombatExecutor {
  return new CombatExecutor(fake.bot, loadConfig({ env }), logger);
}

describe("CombatExecutor control mapping", () => {
  it("sets forward for approach and releases other controls", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    await makeExecutor(fake).applyAction("approach", fake.targetEntity(), true, true);
    const controls = lastControlMap(fake);
    expect(controls.forward).toBe(true);
    expect(controls.sprint).toBe(false);
    expect(controls.back).toBe(false);
  });

  it("sets forward and sprint for close_distance_sprinting", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [5, 0, 0] } });
    await makeExecutor(fake).applyAction("close_distance_sprinting", fake.targetEntity(), true, true);
    const controls = lastControlMap(fake);
    expect(controls.forward).toBe(true);
    expect(controls.sprint).toBe(true);
  });

  it("maps strafe and retreat to the right controls", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const executor = makeExecutor(fake);
    await executor.applyAction("strafe_left", fake.targetEntity(), true, true);
    expect(lastControlMap(fake).left).toBe(true);
    await executor.applyAction("strafe_right", fake.targetEntity(), true, true);
    expect(lastControlMap(fake).right).toBe(true);
    await executor.applyAction("retreat", fake.targetEntity(), true, true);
    expect(lastControlMap(fake).back).toBe(true);
  });

  it("releases every movement control for hold_position", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    await makeExecutor(fake).applyAction("hold_position", fake.targetEntity(), true, true);
    const controls = lastControlMap(fake);
    expect(Object.values(controls).every((value) => value === false)).toBe(true);
  });
});

describe("CombatExecutor attacking", () => {
  it("attacks a target in range", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const result = await makeExecutor(fake).applyAction("attack_target", fake.targetEntity(), true, true);
    expect(result.attacked).toBe(true);
    expect(fake.calls.attacks).toHaveLength(1);
  });

  it("does not attack while on cooldown", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const result = await makeExecutor(fake).applyAction("attack_target", fake.targetEntity(), true, false);
    expect(result.attacked).toBe(false);
    expect(fake.calls.attacks).toHaveLength(0);
  });

  it("does not attack a target out of range", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [10, 0, 0] } });
    const result = await makeExecutor(fake).applyAction("attack_target", fake.targetEntity(), true, true);
    expect(result.attacked).toBe(false);
    expect(fake.calls.attacks).toHaveLength(0);
  });

  it("jumps only when jump_attack starts while grounded", async () => {
    const fake = createFakeBot({ onGround: true, target: { username: "Steve", position: [2, 0, 0] } });
    const executor = makeExecutor(fake);
    await executor.applyAction("jump_attack", fake.targetEntity(), true, true);
    expect(lastControlMap(fake).jump).toBe(true);
    await executor.applyAction("jump_attack", fake.targetEntity(), false, false);
    expect(lastControlMap(fake).jump).toBe(false);
  });
});

describe("CombatExecutor W-tap (sprint reset)", () => {
  it("releases forward+sprint and lands one hit, then re-engages sprint", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const executor = makeExecutor(fake, { NANOJEV_WTAP_RELEASE_TICKS: "1" });

    // Phase 0: release movement/sprint, attack.
    await executor.applyAction("sprint_reset_attack", fake.targetEntity(), true, true);
    const released = lastControlMap(fake);
    expect(released.forward).toBe(false);
    expect(released.sprint).toBe(false);
    expect(fake.calls.attacks).toHaveLength(1);

    // Phase 1: re-engage a fresh sprint, no second hit.
    await executor.applyAction("sprint_reset_attack", fake.targetEntity(), false, false);
    const resumed = lastControlMap(fake);
    expect(resumed.forward).toBe(true);
    expect(resumed.sprint).toBe(true);
    expect(fake.calls.attacks).toHaveLength(1);
  });

  it("holds the release for the configured number of ticks", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const executor = makeExecutor(fake, { NANOJEV_WTAP_RELEASE_TICKS: "2" });

    await executor.applyAction("sprint_reset_attack", fake.targetEntity(), true, true);
    expect(lastControlMap(fake).forward).toBe(false);
    await executor.applyAction("sprint_reset_attack", fake.targetEntity(), false, false);
    // still in the release phase (2nd of 2 ticks)
    expect(lastControlMap(fake).forward).toBe(false);
    await executor.applyAction("sprint_reset_attack", fake.targetEntity(), false, false);
    // release finished; sprint re-engaged
    expect(lastControlMap(fake).forward).toBe(true);
    expect(lastControlMap(fake).sprint).toBe(true);
  });
});

describe("CombatExecutor shield", () => {
  it("equips and raises the shield when available", async () => {
    const fake = createFakeBot({ items: [{ name: "shield" }] });
    await makeExecutor(fake).applyAction("raise_shield", null, true, true);
    expect(fake.calls.equipped[0]?.destination).toBe("off-hand");
    expect(fake.calls.activated).toContain(true);
  });

  it("does nothing when no shield is available", async () => {
    const fake = createFakeBot({ items: [{ name: "iron_sword" }] });
    await makeExecutor(fake).applyAction("raise_shield", null, true, true);
    expect(fake.calls.equipped).toHaveLength(0);
    expect(fake.calls.activated).toHaveLength(0);
  });

  it("deactivates the shield when the action changes", async () => {
    const fake = createFakeBot({ items: [{ name: "shield" }] });
    const executor = makeExecutor(fake);
    await executor.applyAction("raise_shield", null, true, true);
    await executor.applyAction("hold_position", null, true, true);
    expect(fake.calls.deactivated).toBeGreaterThan(0);
  });
});

describe("CombatExecutor tracking", () => {
  it("looks toward the target using the Mineflayer yaw convention", async () => {
    const fake = createFakeBot({ position: [0, 0, 0], yaw: 0, target: { username: "Steve", position: [2, 0, 0] } });
    await makeExecutor(fake).trackTarget(fake.targetEntity()!);
    const look = fake.calls.looks.at(-1)!;
    expect(look.yaw).toBeCloseTo(-Math.PI / 2);
    expect(look.force).toBe(true);
  });
});

describe("CombatExecutor lifecycle", () => {
  it("releases all controls and the shield", async () => {
    const fake = createFakeBot({ items: [{ name: "shield" }] });
    const executor = makeExecutor(fake);
    await executor.applyAction("raise_shield", null, true, true);
    executor.release();
    expect(fake.calls.deactivated).toBeGreaterThan(0);
    const controls = lastControlMap(fake);
    expect(Object.values(controls).every((value) => value === false)).toBe(true);
  });

  it("supports every declared action id without throwing", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const executor = makeExecutor(fake);
    const actions: CombatActionId[] = [
      "approach",
      "close_distance_sprinting",
      "strafe_left",
      "strafe_right",
      "retreat",
      "hold_position",
      "track_target",
      "attack_target",
      "jump_attack",
      "sprint_reset_attack",
      "raise_shield",
      "reposition",
    ];
    for (const action of actions) {
      await expect(executor.applyAction(action, fake.targetEntity(), true, true)).resolves.toBeDefined();
    }
    executor.release();
  });
});
