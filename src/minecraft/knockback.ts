import type { Bot } from "mineflayer";

interface Velocity {
  set(x: number, y: number, z: number): unknown;
}

interface EntityWithVelocity {
  velocity?: Velocity;
}

interface EntityVelocityPacket {
  entityId?: number;
  velocity?: { x: number; y: number; z: number };
}

interface RawClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * True when the server encodes entity velocity with the quantized `lpVec3` type.
 *
 * Minecraft 1.21.9 replaced the 1/8000 fixed-point velocity that older versions used.
 */
export function usesLpVec3Velocity(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? "0");
  if (major !== 1) return major > 1;
  if (minor !== 21) return minor > 21;
  return patch >= 9;
}

/**
 * Restores knockback on Minecraft 1.21.9+.
 *
 * From 1.21.9 the `entity_velocity` packet uses the quantized `lpVec3` type, whose values are
 * already in blocks per tick. Mineflayer still passes them through `fromNotchVelocity` (÷ 8000),
 * so a server knockback of, say, -0.39 blocks/tick becomes ~-0.00005 and the physics tick discards
 * it as negligible: the bot slides nowhere and appears immune to knockback.
 *
 * This only reads the packet the server already sent and writes the velocity it contains onto the
 * entity, exactly as a stock client applies it. It sends nothing and never invents motion.
 */
export function installKnockbackCompat(bot: Bot): void {
  const client = (bot as unknown as { _client?: RawClient })._client;
  if (!client || typeof client.on !== "function") return;

  const onPacket = (raw: unknown): void => {
    const version = (bot as unknown as { version?: string }).version ?? "";
    if (!usesLpVec3Velocity(version)) return;

    const packet = raw as EntityVelocityPacket;
    if (typeof packet?.entityId !== "number" || !packet.velocity) return;

    const entities = (bot as unknown as { entities?: Record<number, EntityWithVelocity> }).entities;
    const velocity = entities?.[packet.entityId]?.velocity;
    if (!velocity || typeof velocity.set !== "function") return;

    velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
  };

  // Mineflayer injects its plugins (and their packet handlers) on a later tick, so a handler
  // registered now would run before Mineflayer's own and be overwritten by it. Attach on `login`,
  // by which point Mineflayer's handlers are installed, so ours runs last and wins.
  const attach = (): void => {
    client.on("entity_velocity", onPacket);
  };
  const botWithEvents = bot as unknown as { once(event: string, listener: () => void): unknown };
  if (typeof botWithEvents.once === "function") botWithEvents.once("login", attach);
  else attach();
}
