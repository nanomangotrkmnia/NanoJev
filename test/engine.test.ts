import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CombatEngine } from "../src/combat/engine.js";
import { CombatExecutor } from "../src/combat/executor.js";
import { createLogger } from "../src/logger.js";
import { TargetSelector } from "../src/target.js";
import { JevError } from "../src/state.js";
import { createFakeBot, type FakeBot } from "./helpers/fakeBot.js";
import { choiceAnswer, deferred, scriptedProvider, type ScriptedProvider } from "./helpers/scriptedProvider.js";

const logger = createLogger({ level: "error", sink: () => {} });

function buildConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    env: {
      NANOJEV_DECISION_MIN_INTERVAL_MS: "0",
      NANOJEV_DECISION_TIMEOUT_MS: "150",
      NANOJEV_ATTACK_INTERVAL_MS: "50",
      MC_TARGET_MODE: "nearest",
      ...overrides,
    },
  });
}

function makeEngine(fake: FakeBot, scripted: ScriptedProvider, overrides: Record<string, string> = {}) {
  const config = buildConfig(overrides);
  const executor = new CombatExecutor(fake.bot, config, logger);
  const engine = new CombatEngine({
    bot: fake.bot,
    config,
    logger,
    provider: scripted.provider,
    selector: TargetSelector.fromConfig(config),
    executor,
    now: () => 1_000,
  });
  return { engine, config, executor };
}

function lastControlMap(fake: FakeBot): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const entry of fake.calls.controls.slice(-7)) map[entry.control] = entry.state;
  return map;
}

describe("CombatEngine decision cycle", () => {
  it("asks Jev and applies the selected legal action", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("attack_target"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();

    expect(scripted.calls).toBe(1);
    expect(engine.snapshot().currentAction).toBe("attack_target");

    await engine.tick();
    expect(fake.calls.attacks).toHaveLength(1);
  });

  it("only offers actions that are legal for the current state", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [5, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("approach"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();

    const offered = Object.keys(scripted.requests[0]!.choice.criteria);
    expect(offered).toContain("approach");
    expect(offered).toContain("close_distance_sprinting");
    expect(offered).not.toContain("attack_target");
  });

  it("records latency and throughput metrics for successful decisions", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("hold_position"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();

    const metrics = engine.snapshot().metrics;
    expect(metrics.ok).toBe(1);
    expect(metrics.medianLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.p95LatencyMs).not.toBeNull();
  });

  it("does not request a decision when there is no target", async () => {
    const fake = createFakeBot({});
    const scripted = scriptedProvider(async () => choiceAnswer("hold_position"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();

    expect(scripted.calls).toBe(0);
    expect(engine.snapshot().currentAction).toBeNull();
  });

  it("keeps the observation loop non-blocking while a decision is in flight", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const gate = deferred<void>();
    const scripted = scriptedProvider(async () => {
      await gate.promise;
      return choiceAnswer("hold_position");
    });
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    expect(scripted.calls).toBe(1);
    expect(engine.snapshot().decisionInFlight).toBe(true);

    gate.resolve();
    await engine.settle();
    expect(engine.snapshot().currentAction).toBe("hold_position");
  });
});

describe("CombatEngine validation and staleness", () => {
  it("rejects an action that was not offered and releases controls", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("teleport_away"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();

    expect(engine.snapshot().currentAction).toBeNull();
    expect(engine.snapshot().metrics.failures).toBeGreaterThanOrEqual(1);
    expect(Object.values(lastControlMap(fake)).every((value) => value === false)).toBe(true);
  });

  it("discards a decision whose target disappeared while it was in flight", async () => {
    const fake = createFakeBot({ target: { id: 7, username: "Steve", position: [2, 0, 0] } });
    const gate = deferred<void>();
    const scripted = scriptedProvider(async () => {
      await gate.promise;
      return choiceAnswer("attack_target");
    });
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    fake.setTarget({ id: 9, username: "Alex", position: [2, 0, 0] });
    await engine.tick();

    gate.resolve();
    await engine.settle();

    expect(engine.snapshot().metrics.stale).toBeGreaterThanOrEqual(1);
    expect(engine.snapshot().currentAction).toBeNull();
  });
});

describe("CombatEngine failure handling", () => {
  it("times out a slow decision and does not act", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(
      (_request, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new JevError("timeout", "aborted")));
        }),
    );
    const { engine } = makeEngine(fake, scripted, { NANOJEV_DECISION_TIMEOUT_MS: "120" });

    await engine.tick();
    await engine.settle();

    expect(engine.snapshot().metrics.timeouts).toBeGreaterThanOrEqual(1);
    expect(engine.snapshot().currentAction).toBeNull();
  });

  it("halts and backs off during a Jev outage by default", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => {
      throw new JevError("unavailable", "service down");
    });
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    expect(scripted.calls).toBe(1);
    expect(engine.snapshot().currentAction).toBeNull();

    await engine.tick();
    await engine.settle();
    expect(scripted.calls).toBe(1);
  });

  it("keeps the previous action during an outage when onFailure=hold", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    let mode: "ok" | "fail" = "ok";
    const scripted = scriptedProvider(async () => {
      if (mode === "fail") throw new JevError("unavailable", "service down");
      return choiceAnswer("attack_target");
    });
    const { engine } = makeEngine(fake, scripted, { NANOJEV_ON_JEV_FAILURE: "hold" });

    await engine.tick();
    await engine.settle();
    expect(engine.snapshot().currentAction).toBe("attack_target");

    mode = "fail";
    fake.setTarget({ username: "Steve", position: [2.6, 0, 0] });
    await engine.tick();
    await engine.settle();

    expect(engine.snapshot().currentAction).toBe("attack_target");
  });
});

describe("CombatEngine target loss", () => {
  it("releases controls and clears the action when the target is lost", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("attack_target"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    await engine.tick();
    expect(engine.snapshot().currentAction).toBe("attack_target");

    fake.setTarget(null);
    await engine.tick();

    expect(engine.snapshot().currentAction).toBeNull();
    expect(Object.values(lastControlMap(fake)).every((value) => value === false)).toBe(true);
  });

  it("resets decision state after a respawn", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("attack_target"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    engine.reset("respawn");
    expect(engine.snapshot().currentAction).toBeNull();
  });
});
