import type { Config } from "./config.js";
import type { CombatActionId, LegalAction, Observation } from "./state.js";
import { round } from "./minecraft/math.js";

type Descriptor = (obs: Observation, config: Config) => string;

export const ACTION_DESCRIPTIONS: Record<CombatActionId, Descriptor> = {
  approach: (obs) =>
    `Walk straight toward the target to reduce the gap (currently ~${obs.target?.distance ?? "?"} blocks). ` +
    `Slower than sprinting and does not commit to a sprint. Use when a steady close-in is preferred. ` +
    `Requires an unobstructed path; does not guarantee a specific displacement.`,
  close_distance_sprinting: (obs) =>
    `Sprint directly at the target to close the gap as fast as possible (currently ~${obs.target?.distance ?? "?"} blocks). ` +
    `Highest closing speed, but commits the bot to a straight line and is easier for the opponent to read. ` +
    `Requires an unobstructed path; does not guarantee a specific displacement.`,
  strafe_left: () =>
    `Circle to the bot's left while keeping orientation on the target. ` +
    `Helps dodge incoming melee swings and break the opponent's aim. Keeps current distance roughly constant.`,
  strafe_right: () =>
    `Circle to the bot's right while keeping orientation on the target. ` +
    `Helps dodge incoming melee swings and break the opponent's aim. Keeps current distance roughly constant.`,
  retreat: (obs) =>
    `Move directly away from the target to open space and reset the fight ` +
    `(self health ${obs.self.health}/20, target ~${obs.target?.distance ?? "?"} blocks). ` +
    `Trades map control for safety; the bot still swings if the target stays in reach.`,
  hold_position: () =>
    `Stand still and make no movement input. Preserves position and stamina, and keeps the bot ready ` +
    `to react, but concedes initiative and map pressure.`,
  track_target: () =>
    `Keep the aim locked on the target without moving. Maintains orientation so a follow-up attack is accurate, ` +
    `but yields no positional advantage this interval.`,
  attack_target: (obs) =>
    `Face and swing at the target now (in range at ~${obs.target?.distance ?? "?"} blocks and the attack is off cooldown). ` +
    `Commits the interval to the swing and leaves the bot stationary; use it to stop and hit rather than chase. ` +
    `Damage output is not predicted here.`,
  jump_attack: (obs) =>
    `Jump while swinging at the target (in range at ~${obs.target?.distance ?? "?"} blocks, grounded, attack off cooldown). ` +
    `May help reset knockback and land a critical hit in supported versions, but commits to a jump and reduces control. ` +
    `Critical-hit behavior is version-dependent and not guaranteed.`,
  sprint_reset_attack: (obs) =>
    `W-tap: stop moving and sprinting for one short beat, land a single hit at ~${obs.target?.distance ?? "?"} blocks ` +
    `while not sprinting, then re-engage a fresh sprint. A sprint reset can add knockback and help chain hits, but it ` +
    `gives up a beat of forward pressure and the effect is server/version dependent (not guaranteed).`,
  hitselect: (obs, config) =>
    `Hitselect: hold the attack for ~${config.combat.hitselectTicks} tick(s) instead of swinging now, then jump and crit ` +
    `(attack while airborne and falling) at ~${obs.target?.distance ?? "?"} blocks. Critical hits do markedly more damage ` +
    `in versions that have them, but the delay risks eating the opponent's hit first, and crit timing is version-dependent ` +
    `and not guaranteed.`,
  jump_reset: (obs) =>
    `Jump reset: jump on the same tick as the hit at ~${obs.target?.distance ?? "?"} blocks to cancel/reduce the knockback ` +
    `you take. Keeps the attack on schedule and your momentum intact, but commits to a jump; the knockback reduction is ` +
    `server/version dependent (not guaranteed).`,
  raise_shield: () =>
    `Equip and raise the shield in the off-hand to block incoming melee and projectiles. ` +
    `Strong defense, but movement slows while blocking and attacks cannot be made in the same interval.`,
  reposition: (obs) =>
    `Move sideways to a more open adjacent position (${obs.environment.openDirectionCount} open directions detected) ` +
    `to escape a corner or wall. Improves future movement options at the cost of this interval's pressure.`,
};

const ORDER: CombatActionId[] = [
  "attack_target",
  "sprint_reset_attack",
  "hitselect",
  "jump_attack",
  "jump_reset",
  "approach",
  "close_distance_sprinting",
  "strafe_left",
  "strafe_right",
  "retreat",
  "raise_shield",
  "reposition",
  "track_target",
  "hold_position",
];

export function buildLegalActions(obs: Observation, config: Config): LegalAction[] {
  const target = obs.target;
  const actions = new Set<CombatActionId>();

  if (!target || !target.valid || !target.alive || !target.inRange || target.visible === false) {
    actions.add("hold_position");
    return finalize(actions, obs, config);
  }

  const inMeleeRange = target.distance <= config.combat.attackRange;
  const attackReady = obs.self.attackReady;
  const healthFraction = obs.self.health / 20;
  const canMove = obs.environment.openDirectionCount >= 1;

  if (canMove) {
    if (!inMeleeRange) {
      actions.add("approach");
      actions.add("close_distance_sprinting");
    }
    if (target.distance <= config.combat.strafeRange) {
      actions.add("strafe_left");
      actions.add("strafe_right");
      actions.add("reposition");
    }
    if (target.distance <= config.combat.strafeRange || healthFraction <= config.combat.retreatHealthFraction) {
      actions.add("retreat");
    }
  }

  if (inMeleeRange && attackReady) {
    actions.add("attack_target");
    if (obs.self.onGround) actions.add("jump_attack");
    if (config.combat.wtapEnabled && canMove) actions.add("sprint_reset_attack");
    if (config.combat.hitselectEnabled && canMove && obs.self.onGround) actions.add("hitselect");
    if (config.combat.jumpResetEnabled && canMove && obs.self.onGround) actions.add("jump_reset");
  }

  if (obs.self.shieldAvailable) actions.add("raise_shield");

  actions.add("track_target");
  actions.add("hold_position");

  return finalize(actions, obs, config);
}

function finalize(actions: Set<CombatActionId>, obs: Observation, config: Config): LegalAction[] {
  return ORDER.filter((id) => actions.has(id)).map((id) => ({
    id,
    description: normalize(ACTION_DESCRIPTIONS[id](obs, config)),
  }));
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function actionSummary(actions: LegalAction[]): string {
  return actions.map((action) => action.id).join(", ");
}

export function distanceBucket(distanceToTarget: number, bucket: number): number {
  if (bucket <= 0) return 0;
  return Math.round(distanceToTarget / bucket) * bucket;
}

export function observationSignature(obs: Observation, config: Config): string {
  if (!obs.target) return "no-target";
  return [
    obs.target.id,
    distanceBucket(obs.target.distance, config.combat.materialDistanceBucket),
    round(obs.self.health / 5, 0),
    obs.target.inRange ? "in" : "out",
    obs.self.attackReady ? "ready" : "cooldown",
    obs.environment.openDirectionCount,
  ].join("|");
}

/**
 * A compact key that captures everything `buildLegalActions` branches on. Callers recompute the
 * legal action list only when this key changes, avoiding repeated string building and Set
 * allocation on every tick while the bot's tactical situation is unchanged.
 */
export function legalActionsSignature(obs: Observation, config: Config): string {
  const target = obs.target;
  if (!target || !target.valid || !target.alive || !target.inRange || target.visible === false) return "none";
  const melee = target.distance <= config.combat.attackRange;
  const close = target.distance <= config.combat.strafeRange;
  const lowHealth = obs.self.health / 20 <= config.combat.retreatHealthFraction;
  return [
    target.id,
    melee ? "m" : "f",
    close ? "c" : "x",
    obs.self.attackReady ? "r" : "-",
    obs.self.onGround ? "g" : "-",
    obs.self.shieldAvailable ? "s" : "-",
    obs.environment.openDirectionCount > 0 ? "o" : "b",
    lowHealth ? "l" : "-",
    config.combat.wtapEnabled ? "w" : "-",
    config.combat.hitselectEnabled ? "h" : "-",
    config.combat.jumpResetEnabled ? "j" : "-",
  ].join("|");
}
