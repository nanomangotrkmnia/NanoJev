import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { MinecraftConnection, type ConnectionEvents } from "../src/minecraft/connection.js";

const logger = createLogger({ level: "error", sink: () => {} });

interface RawWrite {
  name: string;
  params: Record<string, unknown>;
}

interface FakeEmitter {
  bot: Bot;
  writes: RawWrite[];
  clientState: string | undefined;
  emit(event: string, ...args: unknown[]): void;
}

function fakeBotFactory(): FakeEmitter {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const writes: RawWrite[] = [];
  const rawClient = {
    state: undefined as string | undefined,
    write(name: string, params: Record<string, unknown>) {
      writes.push({ name, params });
      return undefined;
    },
  };
  const client = { _client: rawClient };
  const bot = {
    ...client,
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
      return bot;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        bot.off(event, wrapped);
        listener(...args);
      };
      (listeners[event] ??= []).push(wrapped);
      return bot;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== listener);
      return bot;
    },
    quit() {
      return undefined;
    },
  };
  return {
    bot: bot as unknown as Bot,
    writes,
    get clientState() {
      return rawClient.state;
    },
    set clientState(value) {
      rawClient.state = value;
    },
    emit(event, ...args) {
      for (const listener of [...(listeners[event] ?? [])]) listener(...args);
    },
  };
}

function makeConnection(events: ConnectionEvents, env: Record<string, string> = {}) {
  const config = loadConfig({ env: { MC_RECONNECT_MAX_ATTEMPTS: "0", ...env } });
  const emitter = fakeBotFactory();
  const connection = new MinecraftConnection({
    config,
    logger,
    events,
    createBotImpl: () => emitter.bot,
  });
  connection.start();
  return { connection, emitter };
}

describe("MinecraftConnection lifecycle", () => {
  it("reports a spawn and marks the connection connected", () => {
    let spawned = false;
    const { connection, emitter } = makeConnection({ onSpawn: () => (spawned = true) });
    emitter.emit("spawn");
    expect(spawned).toBe(true);
    expect(connection.connected).toBe(true);
    connection.stop();
  });
});

describe("MinecraftConnection resource pack handshake", () => {
  const UUID = "50cc5728-af04-38a7-933c-c14948d8102c";

  it("answers a required configuration-phase pack with the ASCII uuid", () => {
    const { connection, emitter } = makeConnection({});
    emitter.clientState = "configuration";
    emitter.emit("resourcePack", "https://example.com/pack.zip", UUID);

    expect(emitter.writes).toEqual([
      { name: "resource_pack_receive", params: { uuid: UUID, result: 3 } },
      { name: "resource_pack_receive", params: { uuid: UUID, result: 0 } },
    ]);
    connection.stop();
  });

  it("serializes a uuid-1345-style object to its ASCII form", () => {
    const { connection, emitter } = makeConnection({});
    emitter.clientState = "configuration";
    emitter.emit("resourcePack", "https://example.com/pack.zip", { toString: () => UUID });

    expect(emitter.writes.map((write) => write.params.uuid)).toEqual([UUID, UUID]);
    connection.stop();
  });

  it("does not write a pack response outside the configuration phase", () => {
    const { connection, emitter } = makeConnection({});
    emitter.clientState = "play";
    emitter.emit("resourcePack", "https://example.com/pack.zip", UUID);
    expect(emitter.writes).toHaveLength(0);
    connection.stop();
  });
});

describe("MinecraftConnection kick classification", () => {
  it("treats a whitelist kick as fatal, not an auth failure", () => {
    let fatal = "";
    let auth = "";
    const { connection, emitter } = makeConnection({
      onFatal: (reason) => (fatal = reason),
      onAuthenticationFailure: (reason) => (auth = reason),
    });
    emitter.emit("kicked", "You are not whitelisted on this server!", false);
    expect(fatal).toContain("whitelist");
    expect(auth).toBe("");
    connection.stop();
  });

  it("treats an authentication kick as an auth failure", () => {
    let fatal = "";
    let auth = "";
    const { connection, emitter } = makeConnection({
      onFatal: (reason) => (fatal = reason),
      onAuthenticationFailure: (reason) => (auth = reason),
    });
    emitter.emit("kicked", "Failed to verify username! Not authenticated.", false);
    expect(auth).not.toBe("");
    expect(fatal).toBe("");
    connection.stop();
  });

  it("does not treat a generic pre-login kick as auth or fatal", () => {
    let fatal = "";
    let auth = "";
    const { connection, emitter } = makeConnection({
      onFatal: (reason) => (fatal = reason),
      onAuthenticationFailure: (reason) => (auth = reason),
    });
    emitter.emit("kicked", "Server is full", false);
    expect(fatal).toBe("");
    expect(auth).toBe("");
    connection.stop();
  });

  it("classifies an auth error event", () => {
    let auth = "";
    const { connection, emitter } = makeConnection({ onAuthenticationFailure: (reason) => (auth = reason) });
    emitter.emit("error", new Error("Invalid credentials. Failed to authenticate"));
    expect(auth).not.toBe("");
    connection.stop();
  });
});

describe("MinecraftConnection reconnect policy", () => {
  it("is fatal when disconnected and reconnect is disabled", () => {
    let fatal = "";
    const { connection, emitter } = makeConnection({ onFatal: (reason) => (fatal = reason) }, { MC_RECONNECT: "false" });
    emitter.emit("end", "socketClosed");
    expect(fatal).toContain("reconnect is disabled");
    connection.stop();
  });

  it("does not retry after an auth failure", () => {
    let fatal = "";
    const { connection, emitter } = makeConnection({ onFatal: (reason) => (fatal = reason) });
    emitter.emit("kicked", "authentication failed", false);
    emitter.emit("end", "kicked");
    expect(fatal).toContain("authentication failed");
    connection.stop();
  });
});
