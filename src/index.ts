import "dotenv/config";
import mineflayer from "mineflayer";
import { assertRunnable, loadConfig, type Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { MinecraftConnection } from "./minecraft/connection.js";
import { createJevProvider, describeProvider } from "./jev/factory.js";
import { TargetSelector } from "./target.js";
import { CombatExecutor } from "./combat/executor.js";
import { CombatEngine } from "./combat/engine.js";
import { runSetup } from "./cli/setup.js";
import { printModelCatalog, runCodivInfo, runOpenJev } from "./cli/openjev-run.js";

const HELP = `NanoJev - autonomous Minecraft PvP bot driven by Jev / OpenJev decisions

Usage:
  nanojev                 Connect the bot and start the combat loop (default)
  nanojev run             Same as the default
  nanojev setup           Interactive first-run configuration (writes .env)
  nanojev models          List OpenJev models with hardware and ease-of-run
  nanojev openjev         Start the local OpenJev decision server (add --execute to run)
  nanojev codiv           Show how to use Codiv's hosted OpenJev (api.codiv.ai) and check reachability
  nanojev help            Show this help
`;

const { latestSupportedVersion, oldestSupportedVersion, testedVersions } = mineflayer;

function supportedVersionNote(version: string): string {
  if (version === "auto") return `auto-detect (Mineflayer supports ${oldestSupportedVersion}-${latestSupportedVersion})`;
  return testedVersions.includes(version)
    ? `${version} (tested by Mineflayer)`
    : `${version} (not in Mineflayer's tested list)`;
}

function printStartupReport(config: Config, logger: Logger, providerDescription: string): void {
  logger.info("NanoJev starting", {
    server: `${config.minecraft.host}:${config.minecraft.port}`,
    username: config.minecraft.username,
    auth: config.minecraft.auth,
    version: supportedVersionNote(config.minecraft.version),
    targetMode: config.target.mode,
    target: config.target.username ?? "(nearest eligible player)",
    targetRange: config.target.range,
    loopHz: config.combat.loopHz,
    decisionIntervalMs: config.combat.decisionMinIntervalMs,
    attackIntervalMs: config.combat.attackIntervalMs,
    onJevFailure: config.jev.onFailure,
    decisionBackend: config.jev.backend,
    decisionProvider: providerDescription,
  });
}

export async function runBot(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });

  try {
    assertRunnable(config);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const provider = createJevProvider(config);
  printStartupReport(config, logger, provider.describe());

  let currentEngine: CombatEngine | null = null;
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { reason });
    clearInterval(metricsTimer);
    currentEngine?.stop(reason);
    currentEngine = null;
    connection.stop(reason);
    logger.info("shutdown complete");
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 100).unref();
  };

  const connection = new MinecraftConnection({
    config,
    logger: logger.child("mc"),
    events: {
      onSpawn: (bot) => {
        logger.info("connection established", { username: config.minecraft.username });
        currentEngine?.stop("replaced");
        const executor = new CombatExecutor(bot, config, logger.child("exec"));
        currentEngine = new CombatEngine({
          bot,
          config,
          logger: logger.child("combat"),
          provider,
          selector: TargetSelector.fromConfig(config),
          executor,
        });
        currentEngine.start();
      },
      onRespawn: () => currentEngine?.reset("respawn"),
      onWorldChange: () => currentEngine?.reset("world-change"),
      onDeath: () => currentEngine?.reset("death"),
      onDisconnect: (reason) => {
        currentEngine?.stop(`disconnect: ${reason}`);
        currentEngine = null;
      },
      onAuthenticationFailure: (reason) => {
        logger.error("authentication failure; shutting down", { reason });
        shutdown("auth-failure", 1);
      },
      onFatal: (reason) => {
        logger.error("cannot continue", { reason });
        if (reason.toLowerCase().includes("kicked")) {
          logger.error(
            `The server refused the bot (${config.minecraft.username}). Ask the server operator to allow it ` +
              `(e.g. "whitelist add ${config.minecraft.username}"), or set MC_USERNAME to an account that is allowed. ` +
              `For online-mode servers use MC_AUTH=microsoft.`,
          );
        } else {
          logger.error(
            `Check MC_ADDRESS/MC_HOST and MC_PORT (for example MC_ADDRESS=${config.minecraft.host}:${config.minecraft.port}) and make sure the server is online, then restart.`,
          );
        }
        shutdown(`fatal: ${reason}`, 1);
      },
      onError: (error) => logger.error("connection error", { error: error.message }),
    },
  });

  const metricsTimer = setInterval(() => {
    const snapshot = currentEngine?.snapshot();
    if (snapshot && snapshot.metrics.decisions > 0) {
      logger.info("decision metrics", {
        decisions: snapshot.metrics.decisions,
        ok: snapshot.metrics.ok,
        failures: snapshot.metrics.failures,
        timeouts: snapshot.metrics.timeouts,
        stale: snapshot.metrics.stale,
        medianLatencyMs: snapshot.metrics.medianLatencyMs,
        p95LatencyMs: snapshot.metrics.p95LatencyMs,
        throughputPerSec: Number(snapshot.metrics.throughputPerSec.toFixed(3)),
        currentAction: snapshot.currentAction,
      });
    }
  }, 30_000);
  if (typeof metricsTimer.unref === "function") metricsTimer.unref();

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error: error.message, stack: error.stack });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  connection.start();
}

async function dispatch(argv: string[]): Promise<number> {
  const command = argv[0];
  switch (command) {
    case undefined:
    case "run":
      await runBot();
      return 0;
    case "setup":
      return runSetup({ force: argv.includes("--force") });
    case "models":
      printModelCatalog();
      return 0;
    case "openjev":
      return runOpenJev({ argv });
    case "codiv":
      return runCodivInfo();
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await dispatch(argv);
  if (code !== 0) process.exitCode = code;
  // The run command starts long-lived work; keep the process alive naturally.
  if (argv.length > 0 && argv[0] !== "run") return;
}

export { describeProvider };

main().catch((error) => {
  console.error("NanoJev failed to start:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
