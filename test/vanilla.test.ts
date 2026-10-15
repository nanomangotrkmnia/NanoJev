import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.js";
import { CombatExecutor } from "../src/combat/executor.js";
import { createLogger } from "../src/logger.js";
import { VANILLA_ATTACK_INTERVAL_MIN_MS, VANILLA_ATTACK_REACH, withinVanillaReach } from "../src/vanilla.js";
import { createFakeBot } from "./helpers/fakeBot.js";

const logger = createLogger({ level: "error", sink: () => {} });

describe("vanilla reach limits", () => {
  it("exposes a vanilla melee reach of 3 blocks", () => {
    expect(VANILLA_ATTACK_REACH).toBe(3);
    expect(withinVanillaReach(2.9)).toBe(true);
    expect(withinVanillaReach(3)).toBe(true);
    expect(withinVanillaReach(3.1)).toBe(false);
  });

  it("rejects a configured attack range beyond vanilla reach", () => {
    expect(() => loadConfig({ env: { NANOJEV_ATTACK_RANGE: "5" } })).toThrow(ConfigError);
    expect(loadConfig({ env: { NANOJEV_ATTACK_RANGE: "3" } }).combat.attackRange).toBe(3);
  });

  it("rejects an attack interval faster than one server tick", () => {
    expect(() => loadConfig({ env: { NANOJEV_ATTACK_INTERVAL_MS: "10" } })).toThrow(ConfigError);
    expect(loadConfig({ env: { NANOJEV_ATTACK_INTERVAL_MS: String(VANILLA_ATTACK_INTERVAL_MIN_MS) } }).combat.attackIntervalMs).toBe(
      VANILLA_ATTACK_INTERVAL_MIN_MS,
    );
  });
});

describe("executor never hits beyond vanilla reach", () => {
  it("attacks a target exactly at reach", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [3, 0, 0] } });
    const executor = new CombatExecutor(fake.bot, loadConfig({ env: {} }), logger);
    const result = await executor.applyAction("attack_target", fake.targetEntity(), true, true);
    expect(result.attacked).toBe(true);
    expect(fake.calls.attacks).toHaveLength(1);
  });

  it("does not attack just beyond reach (no +0.5 slack)", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [3.5, 0, 0] } });
    const executor = new CombatExecutor(fake.bot, loadConfig({ env: {} }), logger);
    const result = await executor.applyAction("attack_target", fake.targetEntity(), true, true);
    expect(result.attacked).toBe(false);
    expect(fake.calls.attacks).toHaveLength(0);
  });

  it("clamps reach even if a bad range is injected past validation", async () => {
    const fake = createFakeBot({ target: { username: "Steve", position: [4, 0, 0] } });
    const config = loadConfig({ env: {} });
    config.combat.attackRange = 6;
    const executor = new CombatExecutor(fake.bot, config, logger);
    const result = await executor.applyAction("attack_target", fake.targetEntity(), true, true);
    expect(result.attacked).toBe(false);
    expect(fake.calls.attacks).toHaveLength(0);
  });
});

describe("no cheat-only client APIs are used", () => {
  // These APIs would let the bot do things a stock client cannot (teleporting, custom
  // physics / speed, or client-side reach). NanoJev must only use ordinary client inputs.
  const banned = ["physicsEnabled", "sendPacket", "writePacket", "bot.physics", ".teleport(", "setPosition("];
  const files = [
    "src/combat/executor.ts",
    "src/combat/engine.ts",
    "src/observation.ts",
    "src/target.ts",
    "src/actions.ts",
    "src/minecraft/connection.ts",
    "src/minecraft/bot.ts",
  ];

  it.each(files)("%s uses no cheat-only APIs", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const token of banned) {
      expect(source.includes(token), `${file} must not reference "${token}"`).toBe(false);
    }
  });

  it("touches the raw client only to answer a required resource pack", () => {
    // The raw client is otherwise off-limits. The single hand-written packet NanoJev may
    // send is the resource-pack response a stock client sends when a server requires a
    // pack during the configuration phase (without it the login stalls until the timeout).
    for (const file of ["src/minecraft/connection.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const packetWrites = [...source.matchAll(/\.write\(\s*["'`]([\w_]+)["'`]/g)].map((match) => match[1]);
      for (const name of packetWrites) {
        expect(name, `${file} may only hand-write the resource-pack handshake packet`).toBe("resource_pack_receive");
      }
    }
  });
});
