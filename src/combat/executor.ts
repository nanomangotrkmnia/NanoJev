import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotLike, ControlState } from "../minecraft/bot.js";
import { clamp, pitchTo, yawTo } from "../minecraft/math.js";
import type { CombatActionId } from "../state.js";
import { VANILLA_ATTACK_REACH } from "../vanilla.js";
import { eyePosition } from "../observation.js";

const ALL_CONTROLS: ControlState[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];

export interface ActionExecutionResult {
  attacked: boolean;
  controls: ControlState[];
}

type Controls = Partial<Record<ControlState, boolean>>;

interface ExecPhase {
  ticks: number;
  controls: Controls;
  attack?: boolean;
  /** Only swing this phase while airborne and falling (a critical-hit attempt). */
  attackWhenFalling?: boolean;
}

/** The steady controls an action holds once its special phases are done. */
const CRUISE: Record<CombatActionId, Controls> = {
  approach: { forward: true },
  close_distance_sprinting: { forward: true, sprint: true },
  strafe_left: { left: true },
  strafe_right: { right: true },
  retreat: { back: true },
  reposition: { left: true },
  hold_position: {},
  track_target: {},
  attack_target: {},
  jump_attack: { forward: true },
  sprint_reset_attack: { forward: true, sprint: true },
  hitselect: { forward: true, sprint: true },
  jump_reset: { forward: true, sprint: true },
  raise_shield: {},
};

export class CombatExecutor {
  private readonly bot: BotLike;
  private readonly logger: Logger;
  private readonly attackRange: number;
  private readonly timelines: Record<CombatActionId, ExecPhase[]>;
  private shieldActive = false;
  private shieldItem: Item | null = null;
  private controls: ControlState[] = [];
  private currentActionId: CombatActionId | null = null;
  private phaseIndex = 0;
  private ticksInPhase = 0;
  private finished = false;

  constructor(bot: BotLike, config: Config, logger: Logger) {
    this.bot = bot;
    this.logger = logger;
    // Never exceed normal melee reach, whatever the configuration says.
    this.attackRange = Math.min(config.combat.attackRange, VANILLA_ATTACK_REACH);
    this.timelines = buildTimelines(
      Math.max(1, Math.round(config.combat.wtapReleaseTicks)),
      Math.min(3, Math.max(1, Math.round(config.combat.hitselectTicks))),
    );
  }

  get activeControls(): ControlState[] {
    return [...this.controls];
  }

  async trackTarget(target: Entity): Promise<void> {
    const origin = eyePosition(this.bot.entity);
    const destination = eyePosition(target);
    const yaw = yawTo(origin, destination);
    const pitch = clamp(pitchTo(origin, destination), -Math.PI / 2, Math.PI / 2);
    await this.bot.look(yaw, pitch, true);
  }

  /**
   * Executes one tick of the current action. Multi-tick techniques (W-tap, hitselect, jump reset)
   * are played as timelines of control phases advanced one phase per call.
   *
   * A sequence restarts only when a *different* action is requested, or the same action is
   * re-requested after the previous sequence finished; a re-request mid-sequence continues it, so
   * a decision that arrives while a technique is running cannot interrupt it. `attackReady` gates
   * whether an attack phase may swing this tick.
   */
  async applyAction(
    action: CombatActionId,
    target: Entity | null,
    isNew: boolean,
    attackReady: boolean,
  ): Promise<ActionExecutionResult> {
    const isSame = action === this.currentActionId;
    if (!isSame || (isNew && this.finished)) {
      this.phaseIndex = 0;
      this.ticksInPhase = 0;
      this.finished = false;
    }
    this.currentActionId = action;

    const timeline = this.timelines[action];
    if (this.phaseIndex >= timeline.length) this.phaseIndex = timeline.length - 1;
    const phase = timeline[this.phaseIndex]!;

    this.setControls(phase.controls);
    await this.setShield(action === "raise_shield");

    let attacked = false;
    if (phase.attack && attackReady && target && target.isValid !== false) {
      const inRange = target.position.distanceTo(this.bot.entity.position) <= this.attackRange;
      const critReady = !phase.attackWhenFalling || this.isFalling();
      if (inRange && critReady) {
        this.bot.attack(target);
        attacked = true;
      }
    }

    this.ticksInPhase += 1;
    if (this.ticksInPhase >= phase.ticks) {
      if (this.phaseIndex < timeline.length - 1) {
        this.phaseIndex += 1;
        this.ticksInPhase = 0;
      } else {
        this.finished = true;
      }
    }

    return { attacked, controls: this.controls };
  }

  private isFalling(): boolean {
    const entity = this.bot.entity;
    if (entity.onGround) return false;
    const velocityY = entity.velocity?.y ?? 0;
    return velocityY < 0;
  }

  private setControls(desired: Controls): void {
    this.controls = desiredControls(desired);
    for (const control of ALL_CONTROLS) {
      this.bot.setControlState(control, desired[control] === true);
    }
  }

  private async setShield(raised: boolean): Promise<void> {
    if (raised) {
      if (!this.shieldActive) {
        const item = this.findShield();
        if (item) {
          try {
            await this.bot.equip(item, "off-hand");
            this.bot.activateItem(true);
            this.shieldItem = item;
            this.shieldActive = true;
          } catch (error) {
            this.logger.warn("failed to raise shield", { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      return;
    }

    if (this.shieldActive) {
      this.bot.deactivateItem();
      this.shieldActive = false;
      try {
        await this.bot.unequip("off-hand");
      } catch {
        /* best effort */
      }
      this.shieldItem = null;
    }
  }

  private findShield(): Item | null {
    if (this.shieldItem) return this.shieldItem;
    const equipped = Array.isArray(this.bot.entity.equipment)
      ? this.bot.entity.equipment.find((item) => item?.name === "shield")
      : undefined;
    if (equipped) return equipped;
    try {
      return this.bot.inventory.items().find((item) => item.name === "shield") ?? null;
    } catch {
      return null;
    }
  }

  release(): void {
    if (this.shieldActive) {
      try {
        this.bot.deactivateItem();
      } catch {
        /* best effort */
      }
      this.shieldActive = false;
    }
    try {
      this.bot.clearControlStates();
    } catch {
      /* best effort */
    }
    for (const control of ALL_CONTROLS) {
      try {
        this.bot.setControlState(control, false);
      } catch {
        /* best effort */
      }
    }
    this.controls = [];
    this.currentActionId = null;
    this.phaseIndex = 0;
    this.ticksInPhase = 0;
    this.finished = false;
  }
}

function desiredControls(desired: Controls): ControlState[] {
  return ALL_CONTROLS.filter((control) => desired[control] === true);
}

/** Precomputes every action timeline once, so the tick loop never allocates phases. */
function buildTimelines(wtapReleaseTicks: number, hitselectTicks: number): Record<CombatActionId, ExecPhase[]> {
  const timelines = {} as Record<CombatActionId, ExecPhase[]>;
  for (const action of Object.keys(CRUISE) as CombatActionId[]) {
    timelines[action] = [{ ticks: 1, controls: { ...CRUISE[action] } }];
  }

  timelines.attack_target = [
    { ticks: 1, controls: {}, attack: true },
    { ticks: 1, controls: {} },
  ];
  timelines.jump_attack = [
    { ticks: 1, controls: { ...CRUISE.jump_attack, jump: true }, attack: true },
    { ticks: 1, controls: { ...CRUISE.jump_attack } },
  ];
  timelines.sprint_reset_attack = [
    { ticks: wtapReleaseTicks, controls: {}, attack: true },
    { ticks: 1, controls: { ...CRUISE.sprint_reset_attack } },
  ];
  // Hitselect: hold the hit for a beat, jump, then crit on the way down.
  timelines.hitselect = [
    { ticks: hitselectTicks, controls: {} },
    { ticks: 1, controls: { jump: true } },
    { ticks: 12, controls: {}, attack: true, attackWhenFalling: true },
    { ticks: 1, controls: { ...CRUISE.hitselect } },
  ];
  // Jump reset: jump on the same tick as the hit, to cancel/reduce the knockback taken.
  timelines.jump_reset = [
    { ticks: 1, controls: { ...CRUISE.jump_reset, jump: true }, attack: true },
    { ticks: 1, controls: { ...CRUISE.jump_reset } },
  ];

  return timelines;
}
