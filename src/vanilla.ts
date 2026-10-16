/**
 * Hard limits that keep NanoJev's actions within what a stock Minecraft Java client can do.
 *
 * NanoJev only drives the bot through ordinary client inputs (movement control states, look,
 * attack, use-item); it never writes packets or drives the bot with position/velocity writes. (The
 * one exception is `minecraft/knockback.ts`, which restores the knockback velocity Mineflayer
 * mis-scales on 1.21.9+ and keeps the momentum and aim across the server's position re-syncs, so the
 * bot behaves like a stock client.) These constants additionally cap the *decision* values so the
 * bot never attempts anything a vanilla client could not, e.g. attacking outside normal melee reach
 * or swinging faster than one server tick.
 */
export const VANILLA_ATTACK_REACH = 3.0;
export const VANILLA_ATTACK_INTERVAL_MIN_MS = 50;
export const VANILLA_TICK_MS = 50;

/** True when a target is close enough to be hit by a vanilla client (no reach extension). */
export function withinVanillaReach(distance: number): boolean {
  return distance <= VANILLA_ATTACK_REACH;
}
