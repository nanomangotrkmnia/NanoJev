import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { installKnockbackCompat, usesLpVec3Velocity } from "../src/minecraft/knockback.js";

describe("usesLpVec3Velocity", () => {
  it("recognises the quantized velocity encoding used from 1.21.9", () => {
    expect(usesLpVec3Velocity("1.21.8")).toBe(false);
    expect(usesLpVec3Velocity("1.21.9")).toBe(true);
    expect(usesLpVec3Velocity("1.21.11")).toBe(true);
    expect(usesLpVec3Velocity("26.1")).toBe(true);
  });

  it("treats older and unknown versions as the fixed-point encoding", () => {
    expect(usesLpVec3Velocity("1.20.1")).toBe(false);
    expect(usesLpVec3Velocity("1.8.9")).toBe(false);
    expect(usesLpVec3Velocity("auto")).toBe(false);
  });
});

interface FakeVelocity {
  value: { x: number; y: number; z: number };
  set(x: number, y: number, z: number): void;
}

function fakeBot(version: string, entityId: number): { bot: Bot; velocity: FakeVelocity; emit: (packet: unknown) => void } {
  const listeners: Array<(packet: unknown) => void> = [];
  const velocity: FakeVelocity = {
    value: { x: 0, y: 0, z: 0 },
    set(x, y, z) {
      this.value = { x, y, z };
    },
  };
  const client = {
    on(event: string, listener: (packet: unknown) => void) {
      if (event === "entity_velocity") listeners.push(listener);
      return client;
    },
  };
  const bot = {
    version,
    _client: client,
    entities: { [entityId]: { velocity } },
  } as unknown as Bot;
  return { bot, velocity, emit: (packet) => listeners.forEach((listener) => listener(packet)) };
}

describe("installKnockbackCompat", () => {
  it("attaches only after login, so it runs after Mineflayer's own handler", () => {
    const listeners: Array<(packet: unknown) => void> = [];
    const loginListeners: Array<() => void> = [];
    const velocity = { value: { x: 0, y: 0, z: 0 }, set(x: number, y: number, z: number) { this.value = { x, y, z }; } };
    const bot = {
      version: "1.21.11",
      once(event: string, listener: () => void) {
        if (event === "login") loginListeners.push(listener);
        return bot;
      },
      _client: { on: (_event: string, listener: (packet: unknown) => void) => void listeners.push(listener) },
      entities: { 7: { velocity } },
    } as unknown as Bot;

    installKnockbackCompat(bot);
    expect(listeners).toHaveLength(0);

    loginListeners.forEach((listener) => listener());
    expect(listeners).toHaveLength(1);
    listeners[0]!({ entityId: 7, velocity: { x: -0.4, y: 0.36, z: -0.07 } });
    expect(velocity.value).toEqual({ x: -0.4, y: 0.36, z: -0.07 });
  });

  it("applies the server's velocity verbatim on 1.21.9+", () => {
    const { bot, velocity, emit } = fakeBot("1.21.11", 42);
    installKnockbackCompat(bot);
    emit({ entityId: 42, velocity: { x: -0.394, y: 0.361, z: -0.067 } });
    expect(velocity.value).toEqual({ x: -0.394, y: 0.361, z: -0.067 });
  });

  it("ignores the packet on versions that still use the fixed-point encoding", () => {
    const { bot, velocity, emit } = fakeBot("1.21.8", 42);
    installKnockbackCompat(bot);
    emit({ entityId: 42, velocity: { x: -0.394, y: 0.361, z: -0.067 } });
    expect(velocity.value).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("ignores packets for unknown entities and malformed payloads", () => {
    const { bot, velocity, emit } = fakeBot("1.21.11", 42);
    const set = vi.spyOn(velocity, "set");
    installKnockbackCompat(bot);
    emit({ entityId: 99, velocity: { x: 1, y: 1, z: 1 } });
    emit({ entityId: 42 });
    emit(null);
    expect(set).not.toHaveBeenCalled();
  });
});
