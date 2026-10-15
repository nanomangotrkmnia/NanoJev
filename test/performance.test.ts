import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sampleObservation, type ObservationCache } from "../src/observation.js";
import { CombatEngine } from "../src/combat/engine.js";
import { CombatExecutor } from "../src/combat/executor.js";
import { TargetSelector } from "../src/target.js";
import { createLogger } from "../src/logger.js";
import { createFakeBot } from "./helpers/fakeBot.js";
import { choiceAnswer, scriptedProvider } from "./helpers/scriptedProvider.js";

const config = loadConfig({ env: {} });
const logger = createLogger({ level: "error", sink: () => {} });

describe("observation caching", () => {
  it("does not re-run visibility raycasts while nothing changes", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const cache: ObservationCache = {};
    const target = fake.targetEntity();

    await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target }, cache);
    expect(fake.calls.raycasts).toBe(1);

    await sampleObservation(fake.bot, config, { tick: 2, now: 1010, attackReady: true, target }, cache);
    await sampleObservation(fake.bot, config, { tick: 3, now: 1020, attackReady: true, target }, cache);
    expect(fake.calls.raycasts).toBe(1);
  });

  it("recomputes visibility when the target moves", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const cache: ObservationCache = {};
    const target = fake.targetEntity()!;

    await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target }, cache);
    expect(fake.calls.raycasts).toBe(1);

    target.position.x = 8;
    await sampleObservation(fake.bot, config, { tick: 2, now: 1010, attackReady: true, target }, cache);
    expect(fake.calls.raycasts).toBe(2);
  });

  it("recomputes visibility when the bot moves to a new block", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const cache: ObservationCache = {};
    const target = fake.targetEntity();

    await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target }, cache);
    expect(fake.calls.raycasts).toBe(1);

    fake.setPosition([5, 0, 0]);
    await sampleObservation(fake.bot, config, { tick: 2, now: 1030, attackReady: true, target }, cache);
    expect(fake.calls.raycasts).toBe(2);
  });

  it("caches block scans for the current cell and refreshes after the TTL", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const cache: ObservationCache = {};
    const target = fake.targetEntity();

    await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target }, cache);
    const afterFirst = fake.calls.blockAt;
    expect(afterFirst).toBeGreaterThan(0);

    await sampleObservation(fake.bot, config, { tick: 2, now: 1100, attackReady: true, target }, cache);
    expect(fake.calls.blockAt).toBe(afterFirst);

    await sampleObservation(fake.bot, config, { tick: 3, now: 1600, attackReady: true, target }, cache);
    expect(fake.calls.blockAt).toBeGreaterThan(afterFirst);
  });

  it("without a cache, every sample recomputes (default behavior is unchanged)", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const target = fake.targetEntity();
    await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target });
    await sampleObservation(fake.bot, config, { tick: 2, now: 1010, attackReady: true, target });
    expect(fake.calls.raycasts).toBe(2);
  });
});

describe("combat engine tick cost", () => {
  function makeEngine(fake: ReturnType<typeof createFakeBot>) {
    return new CombatEngine({
      bot: fake.bot,
      config,
      logger,
      provider: scriptedProvider(async () => choiceAnswer("hold_position")).provider,
      selector: TargetSelector.fromConfig(config),
      executor: new CombatExecutor(fake.bot, config, logger),
      now: () => 1000,
    });
  }

  it("reuses cached observation work across ticks with no change", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const engine = makeEngine(fake);

    await engine.tick();
    const raycasts = fake.calls.raycasts;
    const blocks = fake.calls.blockAt;

    await engine.tick();
    await engine.tick();
    expect(fake.calls.raycasts).toBe(raycasts);
    expect(fake.calls.blockAt).toBe(blocks);
  });

  it("forces recomputation when the bot moves", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const engine = makeEngine(fake);

    await engine.tick();
    const raycasts = fake.calls.raycasts;

    fake.setPosition([9, 0, 0]);
    await engine.tick();
    expect(fake.calls.raycasts).toBeGreaterThan(raycasts);
  });

  it("resets the observation cache on respawn", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const engine = makeEngine(fake);

    await engine.tick();
    expect(fake.calls.raycasts).toBe(1);

    engine.reset("respawn");
    await engine.tick();
    expect(fake.calls.raycasts).toBe(2);
  });
});

describe("target selection throttling", () => {
  it("throttles repeated empty scans, then reacquires", () => {
    const selector = TargetSelector.fromConfig(loadConfig({ env: { MC_TARGET_MODE: "nearest" } }));
    const fake = createFakeBot({});

    expect(selector.select(fake.bot, 1000)).toBeNull();
    fake.addEntity({ id: 2, username: "Late", position: [2, 0, 0] });
    // Within the throttle window: no scan, still null.
    expect(selector.select(fake.bot, 1100)).toBeNull();
    // After the window: the new target is found.
    expect(selector.select(fake.bot, 1300)?.username).toBe("Late");
  });

  it("keeps a valid current target without rescanning", () => {
    const selector = TargetSelector.fromConfig(loadConfig({ env: { MC_TARGET_MODE: "nearest" } }));
    const fake = createFakeBot({ target: { id: 5, username: "Steve", position: [2, 0, 0] } });
    expect(selector.select(fake.bot, 1000)?.username).toBe("Steve");
    fake.addEntity({ id: 6, username: "Closer", position: [1, 0, 0] });
    expect(selector.select(fake.bot, 1000)?.username).toBe("Steve");
  });
});
