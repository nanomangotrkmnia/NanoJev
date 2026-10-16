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

function makeEngine(
  fake: FakeBot,
  scripted: ScriptedProvider,
  overrides: Record<string, string> = {},
  clock: { now: number } = { now: 1_000 },
) {
  const config = buildConfig(overrides);
  const executor = new CombatExecutor(fake.bot, config, logger);
  const engine = new CombatEngine({
    bot: fake.bot,
    config,
    logger,
    provider: scripted.provider,
    selector: TargetSelector.fromConfig(config),
    executor,
    now: () => clock.now,
  });
  return { engine, config, executor, clock };
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

describe("CombatEngine per-tick reflexes", () => {
  it("acts before the first decision is in, instead of waiting seconds", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const gate = deferred<void>();
    const scripted = scriptedProvider(async () => {
      await gate.promise;
      return choiceAnswer("hold_position");
    });
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    expect(engine.snapshot().currentAction).toBeNull();
    expect(fake.calls.attacks).toHaveLength(1);

    gate.resolve();
    await engine.settle();
  });

  it("swings on cooldown even while following a movement action", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("strafe_left"));
    const { engine, clock } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    expect(engine.snapshot().currentAction).toBe("strafe_left");
    expect(fake.calls.attacks).toHaveLength(1);

    clock.now = 2_000; // past the 50ms attack interval
    await engine.tick();
    expect(fake.calls.attacks).toHaveLength(2);
  });

  it("does not swing again before the attack interval elapses", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("strafe_left"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    await engine.tick();
    expect(fake.calls.attacks).toHaveLength(1);
  });

  it("keeps moving even when the model picks a stationary action", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [5, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("hold_position"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    expect(engine.snapshot().currentAction).toBe("hold_position");

    await engine.tick();
    // The model said stand still; the movement reflex still closes the gap.
    expect(lastControlMap(fake).forward).toBe(true);
  });

  it("lets the model's own movement action win over the reflex", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [5, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("retreat"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    expect(engine.snapshot().currentAction).toBe("retreat");

    await engine.tick();
    const controls = lastControlMap(fake);
    expect(controls.back).toBe(true);
    expect(controls.forward).not.toBe(true);
  });

  it("jumps to climb when the target is on a block above", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 1, 0] } });
    const gate = deferred<void>();
    const scripted = scriptedProvider(async () => {
      await gate.promise;
      return choiceAnswer("hold_position");
    });
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    expect(lastControlMap(fake).jump).toBe(true);

    gate.resolve();
    await engine.settle();
  });

  it("does not jump when the target is at the same level", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [5, 0, 0] } });
    const gate = deferred<void>();
    const scripted = scriptedProvider(async () => {
      await gate.promise;
      return choiceAnswer("hold_position");
    });
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    expect(lastControlMap(fake).jump).not.toBe(true);

    gate.resolve();
    await engine.settle();
  });

  it("lets a timing technique hold the swing", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("hitselect"));
    const { engine, clock } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();
    expect(engine.snapshot().currentAction).toBe("hitselect");
    expect(fake.calls.attacks).toHaveLength(1);

    clock.now = 2_000;
    await engine.tick();
    // Hitselect deliberately holds the swing, so the reflex must not fire.
    expect(fake.calls.attacks).toHaveLength(1);
  });
});

describe("CombatEngine forced action (dev)", () => {
  it("runs the forced action instead of asking the model", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("hold_position"));
    const { engine } = makeEngine(fake, scripted);

    engine.forceAction("strafe_left");
    await engine.tick();
    await engine.settle();

    expect(engine.snapshot().currentAction).toBe("strafe_left");
    expect(engine.forced).toBe("strafe_left");
    expect(scripted.calls).toBe(0);
  });

  it("hands control back to the model when cleared", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("hold_position"));
    const { engine } = makeEngine(fake, scripted);

    engine.forceAction("strafe_left");
    engine.forceAction(null);
    await engine.tick();
    await engine.settle();

    expect(engine.forced).toBeNull();
    expect(engine.snapshot().currentAction).toBe("hold_position");
    expect(scripted.calls).toBe(1);
  });
});

describe("CombatEngine validation and staleness", () => {
  it("drops an action that was not offered instead of treating it as fatal", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
    const scripted = scriptedProvider(async () => choiceAnswer("teleport_away"));
    const { engine } = makeEngine(fake, scripted);

    await engine.tick();
    await engine.settle();

    // The pick is stale, not malformed: no action is adopted and nothing is recorded as ok.
    const metrics = engine.snapshot().metrics;
    expect(engine.snapshot().currentAction).toBeNull();
    expect(metrics.stale).toBeGreaterThanOrEqual(1);
    expect(metrics.ok).toBe(0);
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
