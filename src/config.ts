import { z } from "zod";
import { VANILLA_ATTACK_INTERVAL_MIN_MS, VANILLA_ATTACK_REACH } from "./vanilla.js";

function boolFromEnv(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (value === undefined) return defaultValue;
      if (typeof value === "boolean") return value;
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off", ""].includes(normalized)) return false;
      throw new Error(`expected a boolean, received "${value}"`);
    });
}

function numberFromEnv(defaultValue: number, opts: { int?: boolean; min?: number; max?: number } = {}) {
  return z
    .union([z.number(), z.string()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return defaultValue;
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a number, received "${value}"` });
        return z.NEVER;
      }
      if (opts.int && !Number.isInteger(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected an integer, received "${value}"` });
        return z.NEVER;
      }
      if (opts.min !== undefined && parsed < opts.min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be >= ${opts.min}, received ${parsed}` });
        return z.NEVER;
      }
      if (opts.max !== undefined && parsed > opts.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be <= ${opts.max}, received ${parsed}` });
        return z.NEVER;
      }
      return parsed;
    });
}

function stringFromEnv(defaultValue: string) {
  return z
    .union([z.string(), z.undefined()])
    .transform((value) => (value === undefined || value.trim() === "" ? defaultValue : value.trim()));
}

function optionalString() {
  return z
    .union([z.string(), z.undefined()])
    .transform((value) => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed === "" ? undefined : trimmed;
    });
}

const targetModeSchema = z
  .union([z.enum(["explicit", "nearest"]), z.undefined(), z.literal("")])
  .transform((value) => value || undefined);

export interface ParsedAddress {
  host: string;
  port?: number;
}

/**
 * Parses a full server address: `host`, `host:port`, or `[ipv6]:port`.
 *
 * A bare IPv6 address (several colons, no brackets) is treated as a host with no port.
 */
export function parseHostPort(value: string): ParsedAddress {
  const trimmed = value.trim();
  if (trimmed === "") return { host: "" };

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      const host = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1);
      if (rest.startsWith(":")) {
        const port = Number(rest.slice(1));
        if (Number.isInteger(port) && port >= 1 && port <= 65535) return { host, port };
      }
      return { host };
    }
  }

  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host, portText] = trimmed.split(":");
    const port = Number(portText);
    if (host && Number.isInteger(port) && port >= 1 && port <= 65535) return { host, port };
  }

  return { host: trimmed };
}

export const JEV_BACKENDS = ["typesafe", "openjev", "codiv"] as const;
export type JevBackend = (typeof JEV_BACKENDS)[number];

export const CODIV_BASE_URL = "https://api.codiv.ai";
export const LOCAL_OPENJEV_BASE_URL = "http://127.0.0.1:8080";

export const configSchema = z
  .object({
    logLevel: z
      .union([z.enum(["debug", "info", "warn", "error"]), z.string()])
      .optional()
      .transform((value) => {
        const normalized = (value ?? "info").toLowerCase();
        if (!["debug", "info", "warn", "error"].includes(normalized)) {
          throw new Error(`NANOJEV_LOG_LEVEL must be one of debug|info|warn|error, received "${value}"`);
        }
        return normalized as "debug" | "info" | "warn" | "error";
      }),

    minecraft: z.object({
      address: optionalString(),
      host: stringFromEnv("localhost"),
      port: numberFromEnv(25565, { int: true, min: 1, max: 65535 }),
      username: stringFromEnv("NanoJev"),
      auth: z
        .union([z.enum(["offline", "microsoft"]), z.string()])
        .optional()
        .transform((value) => {
          const normalized = (value ?? "offline").toLowerCase();
          if (!["offline", "microsoft"].includes(normalized)) {
            throw new Error(`MC_AUTH must be offline or microsoft, received "${value}"`);
          }
          return normalized as "offline" | "microsoft";
        }),
      password: optionalString(),
      version: stringFromEnv("auto"),
      connectTimeoutMs: numberFromEnv(30_000, { int: true, min: 1_000 }),
      reconnect: z.object({
        enabled: boolFromEnv(true),
        maxAttempts: numberFromEnv(5, { int: true, min: 0 }),
        baseDelayMs: numberFromEnv(2_000, { int: true, min: 0 }),
        maxDelayMs: numberFromEnv(60_000, { int: true, min: 0 }),
      }),
    }),

    target: z.object({
      username: optionalString(),
      mode: targetModeSchema,
      range: numberFromEnv(32, { min: 1, max: 256 }),
    }),

    jev: z.object({
      backend: z
        .union([z.enum(JEV_BACKENDS), z.string()])
        .optional()
        .transform((value) => {
          const normalized = (value ?? "typesafe").toLowerCase();
          if (!JEV_BACKENDS.includes(normalized as JevBackend)) {
            throw new Error(`NANOJEV_JEV_BACKEND must be one of ${JEV_BACKENDS.join(", ")}, received "${value}"`);
          }
          return normalized as JevBackend;
        }),
      apiKey: optionalString(),
      baseUrl: optionalString(),
      model: stringFromEnv("jev-latest"),
      timeoutMs: numberFromEnv(5_000, { int: true, min: 100 }),
      maxRetries: numberFromEnv(2, { int: true, min: 0, max: 10 }),
      onFailure: z
        .union([z.enum(["halt", "hold"]), z.string()])
        .optional()
        .transform((value) => {
          const normalized = (value ?? "halt").toLowerCase();
          if (!["halt", "hold"].includes(normalized)) {
            throw new Error(`NANOJEV_ON_JEV_FAILURE must be halt or hold, received "${value}"`);
          }
          return normalized as "halt" | "hold";
        }),
    }),

    openjev: z.object({
      baseUrl: stringFromEnv("http://127.0.0.1:8080"),
      apiKey: optionalString(),
      model: stringFromEnv("openjev-latest"),
      hosted: boolFromEnv(false),
    }),

    combat: z.object({
      loopHz: numberFromEnv(20, { min: 1, max: 50 }),
      decisionMinIntervalMs: numberFromEnv(250, { int: true, min: 0 }),
      decisionTimeoutMs: numberFromEnv(3_000, { int: true, min: 100 }),
      attackIntervalMs: numberFromEnv(625, { int: true, min: VANILLA_ATTACK_INTERVAL_MIN_MS }),
      attackRange: numberFromEnv(VANILLA_ATTACK_REACH, { min: 0.5, max: VANILLA_ATTACK_REACH }),
      strafeRange: numberFromEnv(6, { min: 0.5, max: 16 }),
      retreatHealthFraction: numberFromEnv(0.5, { min: 0, max: 1 }),
      materialDistanceBucket: numberFromEnv(1, { min: 0.1, max: 16 }),
      wtapEnabled: boolFromEnv(true),
      wtapReleaseTicks: numberFromEnv(2, { int: true, min: 1, max: 10 }),
    }),
  });

export type Config = z.infer<typeof configSchema>;

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid NanoJev configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
  }
}

export function loadConfig(options: LoadOptions = {}): Config {
  const env = options.env ?? process.env;

  const raw = {
    logLevel: env.NANOJEV_LOG_LEVEL ?? env.LOG_LEVEL,
    minecraft: {
      address: env.MC_ADDRESS ?? env.MC_SERVER,
      host: env.MC_HOST,
      port: env.MC_PORT,
      username: env.MC_USERNAME,
      auth: env.MC_AUTH,
      password: env.MC_PASSWORD,
      version: env.MC_VERSION,
      connectTimeoutMs: env.MC_CONNECT_TIMEOUT_MS,
      reconnect: {
        enabled: env.MC_RECONNECT,
        maxAttempts: env.MC_RECONNECT_MAX_ATTEMPTS,
        baseDelayMs: env.MC_RECONNECT_BASE_DELAY_MS,
        maxDelayMs: env.MC_RECONNECT_MAX_DELAY_MS,
      },
    },
    target: {
      username: env.MC_TARGET,
      mode: env.MC_TARGET_MODE,
      range: env.MC_TARGET_RANGE,
    },
    jev: {
      backend: env.NANOJEV_JEV_BACKEND,
      apiKey: env.TYPESAFE_API_KEY,
      baseUrl: env.TYPESAFE_BASE_URL,
      model: env.JEV_MODEL,
      timeoutMs: env.JEV_TIMEOUT_MS,
      maxRetries: env.JEV_MAX_RETRIES,
      onFailure: env.NANOJEV_ON_JEV_FAILURE,
    },
    openjev: {
      baseUrl: env.OPENJEV_BASE_URL,
      apiKey: env.OPENJEV_API_KEY,
      model: env.OPENJEV_MODEL,
      hosted: env.OPENJEV_HOSTED,
    },
    combat: {
      loopHz: env.NANOJEV_LOOP_HZ,
      decisionMinIntervalMs: env.NANOJEV_DECISION_MIN_INTERVAL_MS,
      decisionTimeoutMs: env.NANOJEV_DECISION_TIMEOUT_MS,
      attackIntervalMs: env.NANOJEV_ATTACK_INTERVAL_MS,
      attackRange: env.NANOJEV_ATTACK_RANGE,
      strafeRange: env.NANOJEV_STRAFE_RANGE,
      retreatHealthFraction: env.NANOJEV_RETREAT_HEALTH_FRACTION,
      materialDistanceBucket: env.NANOJEV_MATERIAL_DISTANCE_BUCKET,
      wtapEnabled: env.NANOJEV_WTAP_ENABLED,
      wtapReleaseTicks: env.NANOJEV_WTAP_RELEASE_TICKS,
    },
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.map((segment) => String(segment)).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new ConfigError(issues);
  }

  const config = result.data;

  const addressSource = raw.minecraft.address ?? raw.minecraft.host;
  if (addressSource !== undefined && String(addressSource).trim() !== "") {
    const parsed = parseHostPort(String(addressSource));
    if (parsed.host) config.minecraft.host = parsed.host;
    if (parsed.port !== undefined) config.minecraft.port = parsed.port;
  }

  if (config.target.mode === undefined) {
    config.target.mode = config.target.username ? "explicit" : "nearest";
  }
  if (config.target.mode === "explicit" && !config.target.username) {
    throw new ConfigError(["target.mode is 'explicit' but MC_TARGET is not set"]);
  }

  if (config.jev.backend === "codiv") {
    config.openjev.hosted = true;
    if (!raw.openjev.baseUrl || String(raw.openjev.baseUrl).trim() === "") {
      config.openjev.baseUrl = CODIV_BASE_URL;
    }
  }

  return config;
}

export interface RunValidatedConfig {
  jevConfigured: boolean;
  warnings: string[];
}

export function getConfigStatus(config: Config): RunValidatedConfig {
  const warnings: string[] = [];

  if (config.jev.backend === "typesafe") {
    if (!config.jev.apiKey) {
      warnings.push(
        "TYPESAFE_API_KEY is not set: set it, or switch to the local OpenJev backend with NANOJEV_JEV_BACKEND=openjev, or to Codiv with NANOJEV_JEV_BACKEND=codiv.",
      );
    }
  } else if (config.jev.backend === "codiv") {
    if (!config.openjev.apiKey) {
      warnings.push("NANOJEV_JEV_BACKEND=codiv requires OPENJEV_API_KEY (an sk-codiv-... key from https://codiv.ai).");
    }
  } else {
    if (config.openjev.hosted && !config.openjev.apiKey) {
      warnings.push("OPENJEV_HOSTED=true but OPENJEV_API_KEY is not set (Codiv requires a key).");
    }
    if (!config.openjev.hosted && !config.openjev.apiKey) {
      warnings.push(
        `OpenJev backend uses ${config.openjev.baseUrl}; a local OpenJev server usually needs no API key.`,
      );
    }
  }

  if (config.minecraft.auth === "microsoft" && !config.minecraft.password) {
    warnings.push(
      "MC_AUTH=microsoft uses the Microsoft device-code flow; watch the console for the sign-in code. MC_PASSWORD is ignored.",
    );
  }

  return { jevConfigured: isJevConfigured(config), warnings };
}

export function isJevConfigured(config: Config): boolean {
  if (config.jev.backend === "typesafe") {
    return Boolean(config.jev.apiKey);
  }
  if (config.jev.backend === "codiv") {
    return Boolean(config.openjev.apiKey);
  }
  return config.openjev.hosted ? Boolean(config.openjev.apiKey) : true;
}

export function assertRunnable(config: Config): RunValidatedConfig {
  const status = getConfigStatus(config);
  if (!status.jevConfigured) {
    const messages: Record<JevBackend, string> = {
      typesafe:
        "TYPESAFE_API_KEY is required for the TypeSafe Jev backend (set it in .env, or run `nanojev setup`).",
      codiv: "OPENJEV_API_KEY (sk-codiv-...) is required for the Codiv backend (set it in .env, or run `nanojev setup`).",
      openjev: "OPENJEV_API_KEY is required for the hosted OpenJev backend (set it in .env, or run `nanojev setup`).",
    };
    throw new ConfigError([messages[config.jev.backend]]);
  }
  return status;
}

export function useOpenJev(config: Config): boolean {
  return config.jev.backend !== "typesafe";
}

export function isCodiv(config: Config): boolean {
  return config.jev.backend === "codiv";
}
