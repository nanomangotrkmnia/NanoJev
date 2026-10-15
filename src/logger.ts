export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
  level: LogLevel;
}

const REDACTED_KEYS = new Set(["apikey", "api_key", "authorization", "password", "token", "secret", "mcauth"]);

function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      output[key] = "[redacted]";
    } else if (key.toLowerCase().includes("key") || key.toLowerCase().includes("password")) {
      output[key] = "[redacted]";
    } else {
      output[key] = value;
    }
  }
  return output;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  sink?: (line: string, level: LogLevel) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const scope = options.scope ?? "nanojev";
  const threshold = ORDER[level];
  const sink =
    options.sink ??
    ((line: string, logLevel: LogLevel) => {
      const isError = logLevel === "error";
      const stream = isError ? process.stderr : process.stdout;
      stream.write(line + "\n");
    });

  const emit = (logLevel: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[logLevel] < threshold) return;
    const timestamp = new Date().toISOString();
    const redacted = redact(fields);
    const suffix = redacted && Object.keys(redacted).length > 0 ? ` ${JSON.stringify(redacted)}` : "";
    sink(`${timestamp} ${logLevel.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`, logLevel);
  };

  return {
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childScope) => createLogger({ level, scope: `${scope}:${childScope}`, sink }),
  };
}

export function isDebugEnabled(logger: Logger): boolean {
  return ORDER[logger.level] <= ORDER.debug;
}
