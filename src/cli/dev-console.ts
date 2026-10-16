import { createInterface } from "node:readline";
import type { CombatEngine } from "../combat/engine.js";
import type { Logger } from "../logger.js";
import { COMBAT_ACTION_IDS, type CombatActionId } from "../state.js";

/**
 * The development console: an interactive command loop on stdin that exists only in
 * `NANOJEV_MODE=development`. It is the home for the hands-on test tooling — forcing a single
 * action, pausing the loop, and dumping state — so the production path stays untouched.
 */
export interface DevConsoleContext {
  getEngine(): CombatEngine | null;
  logger: Logger;
  shutdown(reason: string): void;
}

export interface ParsedDevCommand {
  command: string;
  argument?: string;
}

export const DEV_COMMANDS = [
  "help",
  "status",
  "metrics",
  "force <action>",
  "auto",
  "stop",
  "start",
  "quit",
] as const;

export function parseDevCommand(line: string): ParsedDevCommand | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const [command, ...rest] = trimmed.split(/\s+/);
  return { command: command!.toLowerCase(), argument: rest.length > 0 ? rest.join(" ").toLowerCase() : undefined };
}

export function isCombatActionId(value: string | undefined): value is CombatActionId {
  return value !== undefined && (COMBAT_ACTION_IDS as readonly string[]).includes(value);
}

export function runDevCommand(cmd: ParsedDevCommand, ctx: DevConsoleContext): void {
  const engine = ctx.getEngine();
  switch (cmd.command) {
    case "help":
    case "?":
      ctx.logger.info("dev console commands", { commands: DEV_COMMANDS.join(", ") });
      break;

    case "status": {
      const snapshot = engine?.snapshot();
      ctx.logger.info("dev status", {
        running: snapshot?.running ?? false,
        action: snapshot?.currentAction ?? null,
        forced: engine?.forced ?? null,
        decisionInFlight: snapshot?.decisionInFlight ?? false,
        target: snapshot?.target?.username ?? null,
        distance: snapshot?.target?.distance ?? null,
        targetHealth: snapshot?.target?.health ?? null,
      });
      break;
    }

    case "metrics":
      ctx.logger.info("dev metrics", { metrics: engine?.snapshot().metrics ?? null });
      break;

    case "force":
      if (!isCombatActionId(cmd.argument)) {
        ctx.logger.warn("force needs one of the known actions", {
          actions: COMBAT_ACTION_IDS.join(", "),
        });
        break;
      }
      if (!engine) {
        ctx.logger.warn("force ignored: no active fight (spawn first, with a target)");
        break;
      }
      engine.forceAction(cmd.argument);
      ctx.logger.info("forced action", { action: cmd.argument });
      break;

    case "auto":
      engine?.forceAction(null);
      ctx.logger.info("cleared forced action; the model is in control again");
      break;

    case "stop":
    case "pause":
      engine?.stop("dev-console");
      ctx.logger.info("combat loop stopped (dev)");
      break;

    case "start":
    case "resume":
      engine?.start();
      ctx.logger.info("combat loop started (dev)");
      break;

    case "quit":
    case "exit":
      ctx.shutdown("dev-console");
      break;

    default:
      ctx.logger.warn(`unknown dev command "${cmd.command}"; type "help"`);
  }
}

export function startDevConsole(ctx: DevConsoleContext): void {
  ctx.logger.info(`development mode: dev console enabled (type "help")`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "nanojev> " });
  rl.prompt();
  rl.on("line", (line) => {
    const cmd = parseDevCommand(line);
    if (cmd) runDevCommand(cmd, ctx);
    rl.prompt();
  });
  rl.on("close", () => {
    /* stdin ended; leave the bot running */
  });
}
