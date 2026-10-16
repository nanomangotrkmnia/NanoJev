import { describe, expect, it } from "vitest";
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

class Vec3 {
  x: number;
  y: number;
  z: number;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  clone() {
    return new Vec3(this.x, this.y, this.z);
  }
  distanceTo(other: { x: number; y: number; z: number }) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }
  set(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  toString() {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
}

type Listener = (...args: any[]) => void;

function fakeClient() {
  const listeners: Record<string, Listener[]> = {};
  return {
    on(event: string, listener: Listener) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    prependListener(event: string, listener: Listener) {
      (listeners[event] ??= []).unshift(listener);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners[event] ?? [])]) listener(...args);
    },
    order(event: string) {
      return listeners[event] ?? [];
    },
  };
}

function fakeBot(version: string, entityId: number) {
  const client = fakeClient();
  const entity = { id: 1, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0 };
  const other = { position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0) };
  const bot = {
    version,
    _client: client,
    entity,
    entities: { 1: entity, [entityId]: other },
  } as unknown as Bot;
  return { bot, client, entity, other };
}

describe("installKnockbackCompat entity velocity", () => {
  it("applies the server's velocity verbatim on 1.21.9+", () => {
    const { bot, client, other } = fakeBot("1.21.11", 42);
    installKnockbackCompat(bot);
    client.emit("entity_velocity", { entityId: 42, velocity: { x: -0.394, y: 0.361, z: -0.067 } });
    expect(other.velocity.toString()).toBe("(-0.394, 0.361, -0.067)");
  });

  it("ignores the packet on versions that still use the fixed-point encoding", () => {
    const { bot, client, other } = fakeBot("1.21.8", 42);
    installKnockbackCompat(bot);
    client.emit("entity_velocity", { entityId: 42, velocity: { x: -0.394, y: 0.361, z: -0.067 } });
    expect(other.velocity.toString()).toBe("(0, 0, 0)");
  });
});

describe("installKnockbackCompat position syncs", () => {
  // Mimics Mineflayer's own `position` handler: it moves to the packet target, zeroes velocity and
  // overwrites the rotation.
  function mineflayerPositionHandler(entity: { position: Vec3; velocity: Vec3; yaw: number; pitch: number }) {
    return (packet: { x: number; y: number; z: number; yaw?: number; pitch?: number }) => {
      entity.position.set(packet.x, packet.y, packet.z);
      entity.velocity.set(0, 0, 0);
      entity.yaw = packet.yaw ?? 0;
      entity.pitch = packet.pitch ?? 0;
    };
  }

  it("keeps momentum and aim across a no-op position packet that stays put", () => {
    const { bot, client, entity } = fakeBot("1.21.11", 1);
    entity.position.set(5, 64, 5);
    entity.velocity.set(-0.394, 0.361, -0.067);
    entity.yaw = 1.234;
    entity.pitch = -0.4;
    client.on("position", mineflayerPositionHandler(entity));
    installKnockbackCompat(bot);

    client.emit("position", { x: 5, y: 64, z: 5, yaw: 0, pitch: 0 });
    expect(entity.velocity.toString()).toBe("(-0.394, 0.361, -0.067)");
    expect(entity.yaw).toBeCloseTo(1.234);
    expect(entity.pitch).toBeCloseTo(-0.4);
  });

  it("does not keep momentum or aim when the packet actually moves the entity", () => {
    const { bot, client, entity } = fakeBot("1.21.11", 1);
    entity.position.set(5, 64, 5);
    entity.velocity.set(-0.394, 0.361, -0.067);
    entity.yaw = 1.234;
    client.on("position", mineflayerPositionHandler(entity));
    installKnockbackCompat(bot);

    client.emit("position", { x: 25, y: 64, z: 5, yaw: 9, pitch: 0 });
    expect(entity.velocity.toString()).toBe("(0, 0, 0)");
    expect(entity.yaw).toBe(9);
  });

  it("captures the pre-handler state before Mineflayer's handler runs", () => {
    const { bot, client, entity } = fakeBot("1.21.11", 1);
    const handler = mineflayerPositionHandler(entity);
    client.on("position", handler);
    installKnockbackCompat(bot);
    // The capture listener must be prepended, ahead of Mineflayer's.
    expect(client.order("position")[0]).not.toBe(handler);
    expect(client.order("position")).toHaveLength(3);
  });

  it("keeps momentum across a small rubber-band correction just after a knockback", () => {
    const { bot, client, entity } = fakeBot("1.21.11", 42);
    client.on("position", mineflayerPositionHandler(entity));
    installKnockbackCompat(bot);

    // The server knocks the bot up...
    client.emit("entity_velocity", { entityId: 1, velocity: { x: 0, y: 0.36, z: 0 } });
    expect(entity.velocity.y).toBeCloseTo(0.36);

    // ...the bot moves, then the server corrects it back to where it started (a small discrepancy).
    entity.position.set(0.3, 0, 0);
    client.emit("position", { x: 0, y: 0, z: 0 });
    expect(entity.velocity.y).toBeCloseTo(0.36);
  });

  it("accepts a large teleport correction during a knockback", () => {
    const { bot, client, entity } = fakeBot("1.21.11", 42);
    client.on("position", mineflayerPositionHandler(entity));
    installKnockbackCompat(bot);

    client.emit("entity_velocity", { entityId: 1, velocity: { x: 0, y: 0.36, z: 0 } });
    entity.position.set(0.3, 0, 0);
    client.emit("position", { x: 40, y: 0, z: 0 });
    expect(entity.velocity.y).toBe(0);
    expect(entity.position.x).toBe(40);
  });

  it("attaches on login when the bot exposes an event emitter", () => {
    const { bot, client } = fakeBot("1.21.11", 1);
    const loginListeners: Array<() => void> = [];
    (bot as unknown as { once(event: string, listener: () => void): void }).once = (event, listener) => {
      if (event === "login") loginListeners.push(listener);
    };
    installKnockbackCompat(bot);
    expect(client.order("entity_velocity")).toHaveLength(0);
    loginListeners.forEach((listener) => listener());
    expect(client.order("entity_velocity")).toHaveLength(1);
  });
});
