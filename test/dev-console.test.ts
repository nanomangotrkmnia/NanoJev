import { describe, expect, it, vi } from "vitest";
import { parseDevCommand, runDevCommand, type DevConsoleContext } from "../src/cli/dev-console.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger({ level: "error", sink: () => {} });

function makeContext() {
  const engine = {
    forceAction: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    forced: null,
    snapshot: () => ({ running: true, currentAction: "approach", decisionInFlight: false, target: null, metrics: {} }),
  };
  const shutdown = vi.fn();
  const ctx: DevConsoleContext = {
    getEngine: () => engine as never,
    logger,
    shutdown,
  };
  return { ctx, engine, shutdown };
}

describe("parseDevCommand", () => {
  it("returns null for a blank line", () => {
    expect(parseDevCommand("   ")).toBeNull();
  });

  it("lowercases the command and keeps the argument", () => {
    expect(parseDevCommand("FORCE attack_target")).toEqual({ command: "force", argument: "attack_target" });
    expect(parseDevCommand("help")).toEqual({ command: "help", argument: undefined });
  });
});

describe("runDevCommand", () => {
  it("forces a known action through the engine", () => {
    const { ctx, engine } = makeContext();
    runDevCommand(parseDevCommand("force strafe_left")!, ctx);
    expect(engine.forceAction).toHaveBeenCalledWith("strafe_left");
  });

  it("rejects an unknown action", () => {
    const { ctx, engine } = makeContext();
    runDevCommand(parseDevCommand("force teleport")!, ctx);
    expect(engine.forceAction).not.toHaveBeenCalled();
  });

  it("clears the forced action with auto", () => {
    const { ctx, engine } = makeContext();
    runDevCommand(parseDevCommand("auto")!, ctx);
    expect(engine.forceAction).toHaveBeenCalledWith(null);
  });

  it("stops and starts the loop", () => {
    const { ctx, engine } = makeContext();
    runDevCommand(parseDevCommand("stop")!, ctx);
    runDevCommand(parseDevCommand("start")!, ctx);
    expect(engine.stop).toHaveBeenCalledWith("dev-console");
    expect(engine.start).toHaveBeenCalled();
  });

  it("shuts the bot down on quit", () => {
    const { ctx, shutdown } = makeContext();
    runDevCommand(parseDevCommand("quit")!, ctx);
    expect(shutdown).toHaveBeenCalledWith("dev-console");
  });

  it("handles force when there is no active fight", () => {
    expect(() =>
      runDevCommand(parseDevCommand("force approach")!, { getEngine: () => null, logger, shutdown: vi.fn() }),
    ).not.toThrow();
  });
});
