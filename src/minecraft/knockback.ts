import type { Bot } from "mineflayer";

interface Vec3Like {
  x: number;
  y: number;
  z: number;
  clone(): Vec3Like;
  distanceTo(other: Vec3Like): number;
  set(x: number, y: number, z: number): unknown;
}

interface EntityWithVelocity {
  position?: Vec3Like;
  velocity?: Vec3Like;
}

interface EntityVelocityPacket {
  entityId?: number;
  velocity?: { x: number; y: number; z: number };
}

interface RawClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  prependListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

const NO_OP_POSITION_EPSILON = 1e-3;

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
 * Two Mineflayer behaviours rob the bot of knockback on these versions:
 *
 * 1. The `entity_velocity` packet now uses the quantized `lpVec3` type, whose values are already
 *    in blocks per tick. Mineflayer still passes them through `fromNotchVelocity` (÷ 8000), so a
 *    knockback of, say, -0.39 becomes ~-0.00005 and the physics tick discards it as negligible.
 * 2. Servers (and anti-cheat plugins) that re-send the player's current position every tick make
 *    Mineflayer treat each packet as a teleport and zero the velocity, so a knockback applied this
 *    tick is wiped before the next physics tick. When such a packet does not actually move the
 *    entity it is a no-op sync, and the momentum should survive it.
 *
 * This only reads packets the server already sent and keeps the velocity they carry, exactly as a
 * stock client would. It sends nothing and never invents motion.
 */
export function installKnockbackCompat(bot: Bot): void {
  const client = (bot as unknown as { _client?: RawClient })._client;
  if (!client || typeof client.on !== "function") return;

  const entity = (): EntityWithVelocity | undefined =>
    (bot as unknown as { entity?: EntityWithVelocity }).entity;

  const onVelocityPacket = (raw: unknown): void => {
    const version = (bot as unknown as { version?: string }).version ?? "";
    if (!usesLpVec3Velocity(version)) return;

    const packet = raw as EntityVelocityPacket;
    if (typeof packet?.entityId !== "number" || !packet.velocity) return;

    const entities = (bot as unknown as { entities?: Record<number, EntityWithVelocity> }).entities;
    const velocity = entities?.[packet.entityId]?.velocity;
    if (!velocity || typeof velocity.set !== "function") return;

    velocity.set(packet.velocity.x, packet.velocity.y, packet.velocity.z);
  };

  // Mineflayer's `position` handler runs on the same event and zeroes velocity. Capture the
  // pre-handler state with a prepended listener, then restore it when the packet was a no-op.
  let prePosition: Vec3Like | null = null;
  let preVelocity: Vec3Like | null = null;
  const capturePosition = (): void => {
    const e = entity();
    if (!e?.position || !e?.velocity) return;
    prePosition = e.position.clone();
    preVelocity = e.velocity.clone();
  };
  const restoreVelocity = (): void => {
    const e = entity();
    if (e?.position && e.velocity && prePosition && preVelocity) {
      if (e.position.distanceTo(prePosition) < NO_OP_POSITION_EPSILON) {
        e.velocity.set(preVelocity.x, preVelocity.y, preVelocity.z);
      }
    }
    prePosition = null;
    preVelocity = null;
  };

  // Mineflayer injects its plugins (and their packet handlers) on a later tick, so handlers
  // registered now would run before Mineflayer's own and be overwritten by it. Attach on `login`,
  // by which point Mineflayer's handlers are installed, so ours runs last (and the position
  // capture is prepended to run first).
  const attach = (): void => {
    client.on("entity_velocity", onVelocityPacket);
    (client.prependListener ?? client.on).call(client, "position", capturePosition);
    client.on("position", restoreVelocity);
  };
  const botWithEvents = bot as unknown as { once(event: string, listener: () => void): unknown };
  if (typeof botWithEvents.once === "function") botWithEvents.once("login", attach);
  else attach();
}
