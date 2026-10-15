import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sampleObservation } from "../src/observation.js";
import { createFakeBot } from "./helpers/fakeBot.js";

const config = loadConfig({ env: {} });

describe("sampleObservation", () => {
  it("captures self state from real bot fields", async () => {
    const fake = createFakeBot({
      username: "NanoJev",
      position: [1.5, 64, -2.25],
      yaw: Math.PI / 2,
      health: 14,
      food: 18,
      heldItem: { name: "diamond_sword" },
      items: [
        { name: "shield" },
        { name: "diamond_sword" },
        { name: "golden_apple" },
        { name: "cobblestone" },
      ],
      blocks: ["cobblestone"],
      equipment: [{ name: "diamond_helmet" }, { name: "shield" }],
    });

    const obs = await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target: null });

    expect(obs.self.username).toBe("NanoJev");
    expect(obs.self.position).toEqual({ x: 1.5, y: 64, z: -2.25 });
    expect(obs.self.health).toBe(14);
    expect(obs.self.food).toBe(18);
    expect(obs.self.heldItem).toBe("diamond_sword");
    expect(obs.self.yawDeg).toBeCloseTo(90);
    expect(obs.self.shieldAvailable).toBe(true);
    expect(obs.self.armor).toContain("diamond_helmet");
    expect(obs.self.inventory).toMatchObject({ sword: true, food: 1, blocks: 1 });
    expect(obs.self.attackReady).toBe(true);
    expect(obs.sources.attackReady).toBe("estimated");
  });

  it("captures target geometry with the documented angle convention", async () => {
    const fake = createFakeBot({
      position: [0, 64, 0],
      yaw: 0,
      target: { username: "Steve", position: [3, 64, 0], health: 20, onGround: false },
    });

    const obs = await sampleObservation(fake.bot, config, {
      tick: 1,
      now: 1000,
      attackReady: false,
      target: fake.targetEntity(),
    });

    expect(obs.target).not.toBeNull();
    expect(obs.target!.username).toBe("Steve");
    expect(obs.target!.distance).toBeCloseTo(3);
    expect(obs.target!.relativeYawDeg).toBeCloseTo(-90);
    expect(obs.target!.onGround).toBe(false);
    expect(obs.target!.health).toBe(20);
    expect(obs.target!.inRange).toBe(true);
    expect(obs.target!.alive).toBe(true);
    expect(obs.sources.targetHealth).toBe("measured");
  });

  it("marks target health as unavailable when the entity exposes none", async () => {
    const fake = createFakeBot({
      target: { username: "Steve", position: [2, 64, 0] },
    });
    const obs = await sampleObservation(fake.bot, config, {
      tick: 1,
      now: 1000,
      attackReady: false,
      target: fake.targetEntity(),
    });
    expect(obs.target!.health).toBeNull();
    expect(obs.sources.targetHealth).toBe("unavailable");
  });

  it("detects clear line of sight via raycast", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [3, 64, 0] } });
    const obs = await sampleObservation(fake.bot, config, {
      tick: 1,
      now: 1000,
      attackReady: false,
      target: fake.targetEntity(),
    });
    expect(obs.target!.visible).toBe(true);
    expect(obs.environment.visibilityMethod).toBe("raycast");
    expect(obs.sources.visibility).toBe("estimated");
  });

  it("detects occlusion from a nearby block intersection", async () => {
    const fake = createFakeBot({
      target: { username: "Steve", position: [3, 64, 0] },
      raycastOccluder: [1, 64, 0],
    });
    const obs = await sampleObservation(fake.bot, config, {
      tick: 1,
      now: 1000,
      attackReady: false,
      target: fake.targetEntity(),
    });
    expect(obs.target!.visible).toBe(false);
  });

  it("reports unavailable line of sight when no world is present", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [3, 64, 0] }, hasWorld: false });
    const obs = await sampleObservation(fake.bot, config, {
      tick: 1,
      now: 1000,
      attackReady: false,
      target: fake.targetEntity(),
    });
    expect(obs.target!.visible).toBeNull();
    expect(obs.environment.visibilityMethod).toBe("unavailable");
  });

  it("maps open movement directions from surrounding geometry", async () => {
    const fake = createFakeBot({
      position: [0, 64, 0],
      solidAt: (x, y, z) => (x === 1 && z === 0 && (y === 64 || y === 65) ? true : false),
    });
    const obs = await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: false, target: null });
    expect(obs.environment.movingInto.east).toBe(false);
    expect(obs.environment.movingInto.west).toBe(true);
    expect(obs.environment.openDirectionCount).toBe(3);
  });

  it("has no target and empty target state when none is selected", async () => {
    const fake = createFakeBot({});
    const obs = await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: false, target: null });
    expect(obs.target).toBeNull();
  });
});
