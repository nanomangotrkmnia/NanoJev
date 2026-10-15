import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TargetSelector } from "../src/target.js";
import { createFakeBot } from "./helpers/fakeBot.js";

describe("TargetSelector", () => {
  it("selects an explicitly configured username", () => {
    const config = loadConfig({ env: { MC_TARGET: "Steve" } });
    const fake = createFakeBot({ position: [0, 64, 0], target: { username: "Steve", position: [3, 64, 0] } });
    const selector = TargetSelector.fromConfig(config);

    const target = selector.select(fake.bot);
    expect(target?.username).toBe("Steve");
  });

  it("returns null when the configured target is absent", () => {
    const config = loadConfig({ env: { MC_TARGET: "Alex" } });
    const fake = createFakeBot({ position: [0, 64, 0], target: { username: "Steve", position: [3, 64, 0] } });
    expect(TargetSelector.fromConfig(config).select(fake.bot)).toBeNull();
  });

  it("does not treat other players as hostile when a target is configured", () => {
    const config = loadConfig({ env: { MC_TARGET: "Steve" } });
    const fake = createFakeBot({ position: [0, 64, 0], target: { username: "Steve", position: [10, 64, 0] } });
    fake.addEntity({ id: 77, username: "Alex", position: [1, 64, 0] });

    const selector = TargetSelector.fromConfig(config);
    expect(selector.select(fake.bot)?.username).toBe("Steve");
  });

  it("selects the nearest eligible player in nearest mode", () => {
    const config = loadConfig({ env: { MC_TARGET_MODE: "nearest" } });
    const fake = createFakeBot({ position: [0, 64, 0], target: { id: 10, username: "Far", position: [8, 64, 0] } });
    fake.addEntity({ id: 2, username: "Near", position: [2, 64, 0] });

    const selector = TargetSelector.fromConfig(config);
    expect(selector.select(fake.bot)?.username).toBe("Near");
  });

  it("excludes the bot itself, dead entities and out-of-range players", () => {
    const config = loadConfig({ env: { MC_TARGET_MODE: "nearest", MC_TARGET_RANGE: "5" } });
    const fake = createFakeBot({ username: "NanoJev", position: [0, 64, 0] });
    fake.addEntity({ id: 2, username: "Dead", position: [1, 64, 0], health: 0 });
    fake.addEntity({ id: 3, username: "TooFar", position: [20, 64, 0] });

    const selector = TargetSelector.fromConfig(config);
    expect(selector.select(fake.bot)).toBeNull();
  });

  it("keeps the current target stable while it stays valid", () => {
    const config = loadConfig({ env: { MC_TARGET_MODE: "nearest" } });
    const fake = createFakeBot({ position: [0, 64, 0], target: { id: 10, username: "First", position: [2, 64, 0] } });
    const selector = TargetSelector.fromConfig(config);

    const first = selector.select(fake.bot);
    expect(first?.username).toBe("First");

    fake.addEntity({ id: 2, username: "Closer", position: [1, 64, 0] });
    const second = selector.select(fake.bot);
    expect(second?.username).toBe("First");
  });

  it("reacquires a target after the current one disappears", () => {
    const config = loadConfig({ env: { MC_TARGET_MODE: "nearest" } });
    const fake = createFakeBot({ position: [0, 64, 0], target: { id: 10, username: "First", position: [2, 64, 0] } });
    const selector = TargetSelector.fromConfig(config);
    expect(selector.select(fake.bot)?.username).toBe("First");

    fake.removeEntity(10);
    fake.addEntity({ id: 2, username: "Second", position: [3, 64, 0] });
    expect(selector.select(fake.bot)?.username).toBe("Second");
  });
});


