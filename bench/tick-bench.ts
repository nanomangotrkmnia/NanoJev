import { loadConfig } from "../src/config.js";
import { sampleObservation, type ObservationCache } from "../src/observation.js";
import { buildLegalActions, legalActionsSignature, observationSignature } from "../src/actions.js";
import { CombatExecutor } from "../src/combat/executor.js";
import { createLogger } from "../src/logger.js";
import { pitchTo, relativeYawDegrees, yawTo } from "../src/minecraft/math.js";
import { createFakeBot } from "../test/helpers/fakeBot.js";

/**
 * Tick-loop micro-benchmark. Run with `npm run bench`.
 *
 * Measures the per-tick CPU cost of the hot-path pieces so regressions are visible. It is a
 * development tool, not a correctness test, and it does not touch the network or any real server.
 */

const config = loadConfig({ env: {} });
const logger = createLogger({ level: "error", sink: () => {} });
const budgetUs = (1000 / config.combat.loopHz) * 1000;

interface Row {
  name: string;
  nsPerOp: number;
  note: string;
}

const rows: Row[] = [];

function addRow(name: string, nsPerOp: number, note: string): void {
  rows.push({ name, nsPerOp, note });
}

function benchSync(name: string, iterations: number, fn: () => void, note: string): void {
  for (let i = 0; i < Math.min(iterations, 5000); i++) fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsedMs = performance.now() - start;
  addRow(name, (elapsedMs * 1e6) / iterations, note);
}

async function benchAsync(name: string, iterations: number, fn: () => Promise<unknown>, note: string): Promise<void> {
  const warmup = Math.min(iterations, 500);
  for (let i = 0; i < warmup; i++) await fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsedMs = performance.now() - start;
  addRow(name, (elapsedMs * 1e6) / iterations, note);
}

async function main(): Promise<void> {
  const fake = createFakeBot({ target: { username: "Steve", position: [2, 0, 0] } });
  const target = fake.targetEntity();
  const cache: ObservationCache = {};
  const observation = await sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target }, cache);

  const executor = new CombatExecutor(fake.bot, config, logger);
  const origin = { x: 0, y: 64, z: 0 };
  const destination = { x: 3, y: 65, z: 4 };

  await benchAsync(
    "sampleObservation (cold cache)",
    20000,
    () => sampleObservation(fake.bot, config, { tick: 1, now: 1000, attackReady: true, target }),
    "runs when target/position changes",
  );
  await benchAsync(
    "sampleObservation (warm cache)",
    20000,
    () => sampleObservation(fake.bot, config, { tick: 1, now: 1010, attackReady: true, target }, cache),
    "typical tick",
  );
  benchSync("buildLegalActions", 200000, () => void buildLegalActions(observation, config), "runs when legality changes");
  benchSync("observationSignature", 1000000, () => void observationSignature(observation, config), "every tick");
  benchSync("legalActionsSignature", 1000000, () => void legalActionsSignature(observation, config), "every tick");
  await benchAsync(
    "executor.applyAction",
    200000,
    () => executor.applyAction("approach", target, false, false),
    "every tick while acting",
  );
  benchSync(
    "aim math (yaw+pitch+relative)",
    5000000,
    () => {
      yawTo(origin, destination);
      pitchTo(origin, destination);
      relativeYawDegrees(1.2, origin, destination);
    },
    "per target per tick",
  );

  printReport();
}

function printReport(): void {
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 20);
  console.log(`\nNanoJev tick-loop benchmark (${config.combat.loopHz} Hz, tick budget ${budgetUs.toFixed(0)} us)\n`);
  console.log(`${"piece".padEnd(nameWidth)}  ${"ns/op".padStart(10)}  ${"ops/s".padStart(11)}  ${"budget".padStart(7)}  note`);
  console.log(`${"-".repeat(nameWidth)}  ${"-".repeat(10)}  ${"-".repeat(11)}  ${"-".repeat(7)}  ${"-".repeat(28)}`);

  let totalUs = 0;
  for (const row of rows) {
    const opsPerSec = 1e9 / row.nsPerOp;
    const share = (row.nsPerOp / budgetUs) * 100;
    // Count the always-on pieces towards the per-tick total; conditional pieces listed separately.
    if (row.note === "every tick" || row.note === "every tick while acting" || row.note === "typical tick") {
      totalUs += row.nsPerOp / 1000;
    }
    console.log(
      `${row.name.padEnd(nameWidth)}  ${row.nsPerOp.toFixed(1).padStart(10)}  ${formatOps(opsPerSec).padStart(11)}  ${(share.toFixed(3) + "%").padStart(7)}  ${row.note}`,
    );
  }

  console.log(`\nSteady-state tick CPU (warm cache): ~${totalUs.toFixed(1)} us of ${budgetUs.toFixed(0)} us budget`);
  console.log(`That is ~${((totalUs / budgetUs) * 100).toFixed(3)}% of the tick budget; the rest is Mineflayer + network I/O.\n`);
}

function formatOps(opsPerSec: number): string {
  if (opsPerSec >= 1e6) return `${(opsPerSec / 1e6).toFixed(1)}M`;
  if (opsPerSec >= 1e3) return `${(opsPerSec / 1e3).toFixed(0)}k`;
  return opsPerSec.toFixed(0);
}

main().catch((error) => {
  console.error("benchmark failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
