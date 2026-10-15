import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CODIV_BASE_URL, LOCAL_OPENJEV_BASE_URL, parseHostPort } from "../config.js";
import { ENV_TEMPLATE, readEnvFile, upsertEnv } from "./env-file.js";
import { createPrompter, isInteractive, type Prompter } from "./prompt.js";

/** Every setting the editor knows about, with the same defaults the app uses when a key is absent. */
export const DEFAULT_SETTINGS: Record<string, string> = {
  NANOJEV_JEV_BACKEND: "typesafe",
  TYPESAFE_API_KEY: "",
  TYPESAFE_BASE_URL: "",
  JEV_MODEL: "jev-latest",
  OPENJEV_BASE_URL: LOCAL_OPENJEV_BASE_URL,
  OPENJEV_API_KEY: "",
  OPENJEV_MODEL: "openjev-latest",
  OPENJEV_HOSTED: "false",
  MC_ADDRESS: "",
  MC_HOST: "localhost",
  MC_PORT: "25565",
  MC_USERNAME: "NanoJev",
  MC_AUTH: "offline",
  MC_PASSWORD: "",
  MC_VERSION: "auto",
  MC_CONNECT_TIMEOUT_MS: "30000",
  MC_RECONNECT: "true",
  MC_RECONNECT_MAX_ATTEMPTS: "5",
  MC_RECONNECT_BASE_DELAY_MS: "2000",
  MC_RECONNECT_MAX_DELAY_MS: "60000",
  MC_TARGET: "",
  MC_TARGET_MODE: "",
  MC_TARGET_RANGE: "32",
  JEV_TIMEOUT_MS: "5000",
  JEV_MAX_RETRIES: "2",
  NANOJEV_ON_JEV_FAILURE: "halt",
  NANOJEV_LOG_LEVEL: "info",
  NANOJEV_LOOP_HZ: "20",
  NANOJEV_DECISION_MIN_INTERVAL_MS: "250",
  NANOJEV_DECISION_TIMEOUT_MS: "3000",
  NANOJEV_ATTACK_INTERVAL_MS: "625",
  NANOJEV_ATTACK_RANGE: "3",
  NANOJEV_STRAFE_RANGE: "6",
  NANOJEV_RETREAT_HEALTH_FRACTION: "0.5",
  NANOJEV_MATERIAL_DISTANCE_BUCKET: "1",
  NANOJEV_WTAP_ENABLED: "true",
  NANOJEV_WTAP_RELEASE_TICKS: "2",
  NANOJEV_HITSELECT_ENABLED: "true",
  NANOJEV_HITSELECT_TICKS: "2",
  NANOJEV_JUMP_RESET_ENABLED: "true",
};

/** Parses `KEY=value` lines from a dotenv file, ignoring comments and blanks. */
export function parseEnvText(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]!] = match[2]!.trim();
  }
  return values;
}

/** The editable settings, starting from defaults and overlaid with whatever the file holds. */
export function settingsFromContent(content: string | null): Record<string, string> {
  const settings = { ...DEFAULT_SETTINGS };
  if (content) Object.assign(settings, parseEnvText(content));
  return settings;
}

/** Applies a backend choice and the derived keys that follow from it. */
export function setBackend(settings: Record<string, string>, backend: string): Record<string, string> {
  const next: Record<string, string> = { ...settings, NANOJEV_JEV_BACKEND: backend };
  if (backend === "codiv") {
    next.OPENJEV_HOSTED = "true";
    if (!next.OPENJEV_BASE_URL || next.OPENJEV_BASE_URL === LOCAL_OPENJEV_BASE_URL) {
      next.OPENJEV_BASE_URL = CODIV_BASE_URL;
    }
  } else if (backend === "openjev") {
    next.OPENJEV_HOSTED = "false";
    if (!next.OPENJEV_BASE_URL) next.OPENJEV_BASE_URL = LOCAL_OPENJEV_BASE_URL;
  }
  return next;
}

export interface SettingsOptions {
  envPath?: string;
}

export async function runSettings(options: SettingsOptions = {}): Promise<number> {
  const envPath = resolve(options.envPath ?? ".env");

  if (!isInteractive()) {
    process.stderr.write("No interactive console detected. Edit .env directly, or run `nanojev settings` in a terminal.\n");
    return 1;
  }

  const content = readEnvFile(envPath) ?? ENV_TEMPLATE;
  const settings = settingsFromContent(content);
  const prompter = createPrompter();

  try {
    process.stdout.write(`\nNanoJev settings\nEditing ${envPath}\n`);
    await mainLoop(prompter, settings);
    writeFileSync(envPath, upsertEnv(content, settings), "utf8");
    process.stdout.write(`\nSaved ${envPath}. Restart the bot for changes to take effect.\n`);
    return 0;
  } finally {
    prompter.close();
  }
}

async function mainLoop(prompter: Prompter, settings: Record<string, string>): Promise<void> {
  for (;;) {
    const backend = settings.NANOJEV_JEV_BACKEND ?? "typesafe";
    const where = backend === "typesafe" ? `model ${settings.JEV_MODEL}` : `${settings.OPENJEV_MODEL} at ${settings.OPENJEV_BASE_URL}`;
    const server = settings.MC_ADDRESS || `${settings.MC_HOST}:${settings.MC_PORT}`;

    const choice = await prompter.choose(
      `\nCurrent: ${backend} (${where}), server ${server}, user ${settings.MC_USERNAME}`,
      [
        { label: "Basic settings (backend, keys, server, username)", value: "basic" as const },
        { label: "Advanced settings (timing, techniques, reconnect, logging)", value: "advanced" as const },
        { label: "Save and exit", value: "save" as const },
      ],
    );

    if (choice === "save") return;
    if (choice === "basic") await basicMenu(prompter, settings);
    else await advancedMenu(prompter, settings);
  }
}

async function basicMenu(prompter: Prompter, settings: Record<string, string>): Promise<void> {
  const choice = await prompter.choose("\nBasic settings", [
    { label: `Decision backend (now ${settings.NANOJEV_JEV_BACKEND})`, value: "backend" as const },
    { label: "API key for the current backend", value: "key" as const },
    { label: "Model (Jev / OpenJev model id)", value: "model" as const },
    { label: `Minecraft server address (now ${settings.MC_ADDRESS || `${settings.MC_HOST}:${settings.MC_PORT}`})`, value: "address" as const },
    { label: `Bot username (now ${settings.MC_USERNAME})`, value: "username" as const },
    { label: `Auth mode (now ${settings.MC_AUTH})`, value: "auth" as const },
    { label: `Target username (now ${settings.MC_TARGET || "(nearest player)"})`, value: "target" as const },
    { label: "Back", value: "back" as const },
  ]);

  switch (choice) {
    case "backend": {
      const current = settings.NANOJEV_JEV_BACKEND ?? "typesafe";
      const options = [
        { label: "TypeSafe Jev (hosted cloud)", value: "typesafe", detail: "Needs TYPESAFE_API_KEY." },
        { label: "Local OpenJev server", value: "openjev", detail: "Default http://127.0.0.1:8080." },
        { label: "Codiv (hosted OpenJev, api.codiv.ai)", value: "codiv", detail: "Needs OPENJEV_API_KEY (sk-codiv-...)." },
      ];
      options.sort((a, b) => (a.value === current ? -1 : b.value === current ? 1 : 0));
      const backend = await prompter.choose("Decision backend", options);
      Object.assign(settings, setBackend(settings, backend));
      return;
    }
    case "key": {
      const backend = settings.NANOJEV_JEV_BACKEND ?? "typesafe";
      if (backend === "typesafe") {
        settings.TYPESAFE_API_KEY = await prompter.ask("TypeSafe API key (blank keeps the current value)", settings.TYPESAFE_API_KEY);
      } else {
        settings.OPENJEV_API_KEY = await prompter.ask(
          backend === "codiv" ? "Codiv API key (sk-codiv-...)" : "OpenJev API key (blank for none)",
          settings.OPENJEV_API_KEY,
        );
      }
      return;
    }
    case "model": {
      const backend = settings.NANOJEV_JEV_BACKEND ?? "typesafe";
      if (backend === "typesafe") {
        settings.JEV_MODEL = await prompter.ask("Jev model", settings.JEV_MODEL || "jev-latest");
      } else {
        settings.OPENJEV_MODEL = await prompter.ask("OpenJev model id", settings.OPENJEV_MODEL || "openjev-latest");
      }
      return;
    }
    case "address": {
      const current = settings.MC_ADDRESS || `${settings.MC_HOST}:${settings.MC_PORT}`;
      const address = await prompter.ask("Minecraft address (host or host:port)", current);
      const parsed = parseHostPort(address);
      settings.MC_ADDRESS = address;
      if (parsed.host) settings.MC_HOST = parsed.host;
      if (parsed.port !== undefined) settings.MC_PORT = String(parsed.port);
      return;
    }
    case "username":
      settings.MC_USERNAME = await prompter.ask("Bot username", settings.MC_USERNAME);
      return;
    case "auth":
      settings.MC_AUTH = await askEnum(prompter, "Auth mode", ["offline", "microsoft"], settings.MC_AUTH);
      return;
    case "target":
      settings.MC_TARGET = await prompter.ask("Target username (blank targets the nearest player)", settings.MC_TARGET);
      return;
    default:
      return;
  }
}

async function advancedMenu(prompter: Prompter, settings: Record<string, string>): Promise<void> {
  const choice = await prompter.choose("\nAdvanced settings", [
    { label: "OpenJev endpoint (URL / hosted / model)", value: "openjev" as const },
    { label: "Target mode and range", value: "targeting" as const },
    { label: "Connection and reconnect", value: "connection" as const },
    { label: "Decision timing and failure policy", value: "decision" as const },
    { label: "Loop and attack tuning", value: "combat" as const },
    { label: "Techniques (W-tap, hitselect, jump reset)", value: "techniques" as const },
    { label: "Log level", value: "log" as const },
    { label: "Back", value: "back" as const },
  ]);

  switch (choice) {
    case "openjev":
      settings.OPENJEV_BASE_URL = await prompter.ask("OpenJev base URL", settings.OPENJEV_BASE_URL);
      settings.OPENJEV_HOSTED = await askBool(prompter, "Is OpenJev hosted (Codiv) rather than local?", settings.OPENJEV_HOSTED);
      settings.OPENJEV_MODEL = await prompter.ask("OpenJev model id", settings.OPENJEV_MODEL);
      return;
    case "targeting":
      settings.MC_TARGET_MODE = await askEnum(prompter, "Target mode (blank = automatic)", ["", "explicit", "nearest"], settings.MC_TARGET_MODE);
      settings.MC_TARGET_RANGE = await askNumber(prompter, "Target acquisition range, blocks", settings.MC_TARGET_RANGE);
      return;
    case "connection":
      settings.MC_VERSION = await prompter.ask("Minecraft version (auto or pinned)", settings.MC_VERSION);
      settings.MC_CONNECT_TIMEOUT_MS = await askNumber(prompter, "Connect timeout, ms", settings.MC_CONNECT_TIMEOUT_MS);
      settings.MC_RECONNECT = await askBool(prompter, "Reconnect on disconnect?", settings.MC_RECONNECT);
      settings.MC_RECONNECT_MAX_ATTEMPTS = await askNumber(prompter, "Max reconnect attempts", settings.MC_RECONNECT_MAX_ATTEMPTS);
      settings.MC_RECONNECT_BASE_DELAY_MS = await askNumber(prompter, "Reconnect base delay, ms", settings.MC_RECONNECT_BASE_DELAY_MS);
      return;
    case "decision":
      settings.NANOJEV_DECISION_MIN_INTERVAL_MS = await askNumber(prompter, "Min gap between decisions, ms", settings.NANOJEV_DECISION_MIN_INTERVAL_MS);
      settings.NANOJEV_DECISION_TIMEOUT_MS = await askNumber(prompter, "Decision timeout, ms", settings.NANOJEV_DECISION_TIMEOUT_MS);
      settings.JEV_TIMEOUT_MS = await askNumber(prompter, "Model request timeout, ms", settings.JEV_TIMEOUT_MS);
      settings.JEV_MAX_RETRIES = await askNumber(prompter, "Model max retries", settings.JEV_MAX_RETRIES);
      settings.NANOJEV_ON_JEV_FAILURE = await askEnum(prompter, "On model failure", ["halt", "hold"], settings.NANOJEV_ON_JEV_FAILURE);
      return;
    case "combat":
      settings.NANOJEV_LOOP_HZ = await askNumber(prompter, "Loop rate, Hz", settings.NANOJEV_LOOP_HZ);
      settings.NANOJEV_ATTACK_INTERVAL_MS = await askNumber(prompter, "Attack interval, ms (min 50)", settings.NANOJEV_ATTACK_INTERVAL_MS);
      settings.NANOJEV_ATTACK_RANGE = await askNumber(prompter, "Attack range, blocks (max 3)", settings.NANOJEV_ATTACK_RANGE);
      settings.NANOJEV_STRAFE_RANGE = await askNumber(prompter, "Strafe range, blocks", settings.NANOJEV_STRAFE_RANGE);
      return;
    case "techniques":
      settings.NANOJEV_WTAP_ENABLED = await askBool(prompter, "Offer W-tap?", settings.NANOJEV_WTAP_ENABLED);
      settings.NANOJEV_WTAP_RELEASE_TICKS = await askNumber(prompter, "W-tap release, ticks", settings.NANOJEV_WTAP_RELEASE_TICKS);
      settings.NANOJEV_HITSELECT_ENABLED = await askBool(prompter, "Offer hitselect (delayed crit)?", settings.NANOJEV_HITSELECT_ENABLED);
      settings.NANOJEV_HITSELECT_TICKS = await askNumber(prompter, "Hitselect hold, ticks (1-3)", settings.NANOJEV_HITSELECT_TICKS);
      settings.NANOJEV_JUMP_RESET_ENABLED = await askBool(prompter, "Offer jump reset?", settings.NANOJEV_JUMP_RESET_ENABLED);
      return;
    case "log":
      settings.NANOJEV_LOG_LEVEL = await askEnum(prompter, "Log level", ["debug", "info", "warn", "error"], settings.NANOJEV_LOG_LEVEL);
      return;
    default:
      return;
  }
}

async function askBool(prompter: Prompter, question: string, fallback: string | undefined): Promise<string> {
  return (await prompter.confirm(question, fallback !== "false")) ? "true" : "false";
}

async function askNumber(prompter: Prompter, question: string, fallback: string | undefined): Promise<string> {
  for (;;) {
    const answer = (await prompter.ask(question, fallback)).trim();
    if (Number.isFinite(Number(answer))) return answer;
    process.stdout.write("  Enter a number.\n");
  }
}

async function askEnum(prompter: Prompter, question: string, allowed: string[], fallback: string | undefined): Promise<string> {
  for (;;) {
    const answer = (await prompter.ask(`${question} (${allowed.filter(Boolean).join("/") || "blank"})`, fallback)).trim();
    if (allowed.includes(answer)) return answer;
    process.stdout.write(`  Choose one of: ${allowed.filter(Boolean).join(", ")}\n`);
  }
}
