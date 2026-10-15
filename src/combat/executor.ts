import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotLike, ControlState } from "../minecraft/bot.js";
import { clamp, pitchTo, yawTo } from "../minecraft/math.js";
import type { CombatActionId } from "../state.js";
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
  raise_shield: {},
  sprint_reset_attack: { forward: true, sprint: true },
};

export class CombatExecutor {
  private readonly bot: BotLike;
  private readonly logger: Logger;
  private readonly attackRange: number;
  private readonly wtapReleaseTicks: number;
  private shieldActive = false;
  private shieldItem: Item | null = null;
  private controls: ControlState[] = [];
  private phaseIndex = 0;
  private ticksInPhase = 0;

  constructor(bot: BotLike, config: Config, logger: Logger) {
    this.bot = bot;
    this.logger = logger;
    this.attackRange = config.combat.attackRange;
    this.wtapReleaseTicks = Math.max(1, Math.round(config.combat.wtapReleaseTicks));
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
   * Executes one tick of the current action. Actions are played as short timelines of control
   * phases (so a W-tap can release `forward`+`sprint`, hit, then re-engage), advanced one phase
   * per call. `attackReady` gates whether a phase tagged `attack` may swing this tick.
   */
  async applyAction(
    action: CombatActionId,
    target: Entity | null,
    isNew: boolean,
    attackReady: boolean,
  ): Promise<ActionExecutionResult> {
    if (isNew) {
      this.phaseIndex = 0;
      this.ticksInPhase = 0;
    }

    const timeline = this.timeline(action);
    if (this.phaseIndex >= timeline.length) this.phaseIndex = timeline.length - 1;
    const phase = timeline[this.phaseIndex]!;

    this.setControls(phase.controls);
    await this.setShield(action === "raise_shield");

    let attacked = false;
    if (phase.attack && attackReady && target && target.isValid !== false) {
      if (target.position.distanceTo(this.bot.entity.position) <= this.attackRange + 0.5) {
        this.bot.attack(target);
        attacked = true;
      }
    }

    this.ticksInPhase += 1;
    if (this.ticksInPhase >= phase.ticks && this.phaseIndex < timeline.length - 1) {
      this.phaseIndex += 1;
      this.ticksInPhase = 0;
    }

    return { attacked, controls: desiredControls(phase.controls) };
  }

  private timeline(action: CombatActionId): ExecPhase[] {
    switch (action) {
      case "sprint_reset_attack":
        // W-tap: stop moving/sprinting, hit, then re-engage a fresh sprint.
        return [
          { ticks: this.wtapReleaseTicks, controls: {}, attack: true },
          { ticks: 1, controls: { ...CRUISE.sprint_reset_attack } },
        ];
      case "jump_attack":
        return [
          { ticks: 1, controls: { ...CRUISE.jump_attack, jump: true }, attack: true },
          { ticks: 1, controls: { ...CRUISE.jump_attack } },
        ];
      case "attack_target":
        return [
          { ticks: 1, controls: {}, attack: true },
          { ticks: 1, controls: {} },
        ];
      default:
        return [{ ticks: 1, controls: { ...CRUISE[action] } }];
    }
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
    this.phaseIndex = 0;
    this.ticksInPhase = 0;
  }
}

function desiredControls(desired: Controls): ControlState[] {
  return ALL_CONTROLS.filter((control) => desired[control] === true);
}
