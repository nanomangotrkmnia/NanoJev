import mineflayer from "mineflayer";
import type { Bot, BotOptions } from "mineflayer";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotLike } from "./bot.js";

const { createBot } = mineflayer;

export interface ConnectionEvents {
  onSpawn?: (bot: BotLike) => void;
  onRespawn?: (bot: BotLike) => void;
  onDeath?: () => void;
  onWorldChange?: (bot: BotLike) => void;
  onKicked?: (reason: string, loggedIn: boolean) => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
  onAuthenticationFailure?: (reason: string) => void;
  onFatal?: (reason: string) => void;
}

export type BotFactory = (options: BotOptions) => Bot;

export interface MinecraftConnectionOptions {
  config: Config;
  logger: Logger;
  events?: ConnectionEvents;
  createBotImpl?: BotFactory;
}

const AUTH_FAILURE_PATTERNS = [
  "authentication",
  "authenticate",
  "invalid credentials",
  "failed to verify username",
  "not authenticated",
  "invalid session",
  "unauthorized",
];

const FATAL_KICK_PATTERNS = [
  "whitelist",
  "banned",
  "you are not allowed",
  "not allowed on this server",
  "blacklist",
  "you do not have permission",
];

function looksLikeAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function looksLikeFatalKick(message: string): boolean {
  const lower = message.toLowerCase();
  return FATAL_KICK_PATTERNS.some((pattern) => lower.includes(pattern));
}

export class MinecraftConnection {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly events: ConnectionEvents;
  private readonly createBotImpl: BotFactory;

  private raw: Bot | null = null;
  private botLike: BotLike | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopping = false;
  private spawned = false;
  private authFailed = false;

  constructor(options: MinecraftConnectionOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.events = options.events ?? {};
    this.createBotImpl = options.createBotImpl ?? createBot;
  }

  get bot(): BotLike | null {
    return this.botLike;
  }

  get connected(): boolean {
    return this.spawned && this.raw !== null;
  }

  start(): void {
    this.stopping = false;
    this.authFailed = false;
    this.attempts = 0;
    this.connect();
  }

  private buildOptions(): BotOptions {
    const mc = this.config.minecraft;
    const options = {
      host: mc.host,
      port: mc.port,
      username: mc.username,
      auth: mc.auth,
      password: mc.auth === "microsoft" ? undefined : mc.password,
      version: mc.version === "auto" ? false : mc.version,
      hideErrors: true,
      logErrors: false,
      onMsaCode: (data: { user_code?: string; verification_uri?: string; message?: string }) => {
        this.logger.info("Microsoft sign-in required", {
          code: data.user_code ?? "?",
          url: data.verification_uri ?? "https://microsoft.com/link",
        });
      },
    } as unknown as BotOptions;
    return options;
  }

  private connect(): void {
    if (this.stopping) return;
    this.spawned = false;
    this.logger.info("connecting to Minecraft server", {
      host: this.config.minecraft.host,
      port: this.config.minecraft.port,
      username: this.config.minecraft.username,
      auth: this.config.minecraft.auth,
      version: this.config.minecraft.version,
    });

    let bot: Bot;
    try {
      bot = this.createBotImpl(this.buildOptions());
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error("failed to create bot", { error: err.message });
      this.events.onError?.(err);
      this.scheduleReconnect();
      return;
    }

    this.raw = bot;
    this.botLike = bot as unknown as BotLike;
    this.wire(bot);
  }

  private wire(bot: Bot): void {
    this.connectTimer = setTimeout(() => this.onConnectTimeout(), this.config.minecraft.connectTimeoutMs);
    if (typeof this.connectTimer.unref === "function") this.connectTimer.unref();

    bot.once("spawn", () => {
      this.clearConnectTimer();
      this.spawned = true;
      this.attempts = 0;
      this.logger.info("bot spawned", { username: this.config.minecraft.username });
      this.events.onSpawn?.(bot as unknown as BotLike);
    });

    bot.on("respawn", () => {
      this.logger.info("bot respawned");
      this.events.onRespawn?.(bot as unknown as BotLike);
    });

    bot.on("death", () => {
      this.logger.info("bot died");
      this.events.onDeath?.();
    });

    bot.on("game", () => {
      this.events.onWorldChange?.(bot as unknown as BotLike);
    });

    bot.on("kicked", (reason, loggedIn) => {
      const text = typeof reason === "string" ? reason : JSON.stringify(reason);
      this.logger.warn("bot kicked", { reason: text, loggedIn });
      this.events.onKicked?.(text, Boolean(loggedIn));

      if (looksLikeAuthFailure(text)) {
        this.authFailed = true;
        this.events.onAuthenticationFailure?.(text);
        return;
      }
      if (looksLikeFatalKick(text)) {
        // e.g. whitelist / ban: retrying will not help
        this.events.onFatal?.(`kicked: ${text}`);
      }
      // Other kicks (server full, restarting, etc.) fall through to a reconnect.
    });

    bot.on("error", (error: Error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (looksLikeAuthFailure(message)) {
        this.authFailed = true;
        this.events.onAuthenticationFailure?.(message);
      }
      this.logger.error("bot error", { error: message });
      this.events.onError?.(error instanceof Error ? error : new Error(message));
    });

    bot.once("end", (reason: string) => {
      this.onEnd(reason);
    });
  }

  private onConnectTimeout(): void {
    if (this.spawned || this.stopping) return;
    this.logger.error("connection timed out", { timeoutMs: this.config.minecraft.connectTimeoutMs });
    this.events.onError?.(new Error(`connection timed out after ${this.config.minecraft.connectTimeoutMs}ms`));
    try {
      this.raw?.quit("connect timeout");
    } catch {
      /* best effort */
    }
  }

  private onEnd(reason: string): void {
    this.clearConnectTimer();
    const wasSpawned = this.spawned;
    this.spawned = false;
    this.raw = null;
    this.botLike = null;

    if (this.stopping) {
      this.logger.info("connection closed", { reason, expected: true });
      return;
    }

    this.logger.warn("disconnected", { reason, wasSpawned });
    this.events.onDisconnect?.(reason);

    if (this.authFailed) {
      this.logger.error("authentication failed; not retrying. Fix credentials and restart NanoJev.");
      this.events.onFatal?.("authentication failed");
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.authFailed) return;
    if (!this.config.minecraft.reconnect.enabled) {
      this.logger.warn("reconnect disabled; stopping");
      this.events.onFatal?.("disconnected and reconnect is disabled");
      return;
    }
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.config.minecraft.reconnect;
    if (this.attempts >= maxAttempts) {
      this.logger.error("reconnect attempts exhausted", { attempts: this.attempts, maxAttempts });
      this.events.onFatal?.(`could not connect to ${this.config.minecraft.host}:${this.config.minecraft.port} after ${this.attempts} attempt(s)`);
      return;
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** this.attempts);
    this.attempts += 1;
    this.logger.info("reconnecting", { attempt: this.attempts, maxAttempts, delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  stop(reason = "shutdown"): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectTimer();
    if (this.raw) {
      this.logger.info("closing connection", { reason });
      try {
        this.raw.quit(reason);
      } catch (error) {
        this.logger.warn("error during quit", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.raw = null;
    this.botLike = null;
    this.spawned = false;
  }
}
