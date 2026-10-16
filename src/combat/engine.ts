import type { Entity } from "prismarine-entity";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { BotLike } from "../minecraft/bot.js";
import { TargetSelector } from "../target.js";
import { buildLegalActions, legalActionsSignature, observationSignature } from "../actions.js";
import { sampleObservation, type ObservationCache } from "../observation.js";
import { JevError, type CombatActionId, type DecisionResult, type LegalAction, type Observation, type TargetState } from "../state.js";
import { buildCombatState, buildDecisionChoice, toDecisionResult } from "../jev/decision.js";
import type { JevProvider } from "../jev/provider.js";
import type { CombatExecutor } from "./executor.js";
import { DecisionMetrics, type DecisionOutcome, type MetricsSnapshot } from "./metrics.js";
import { VANILLA_ATTACK_REACH } from "../vanilla.js";

const MAX_BACKOFF_MS = 30_000;

/** Actions whose whole point is to time a swing themselves, so the reflex must not swing. */
const REFLEX_ATTACK_BLOCKED = new Set<CombatActionId>(["hitselect", "raise_shield"]);

/** Actions that already pick the movement, so the movement reflex must not add its own. */
const MOVEMENT_ACTIONS = new Set<CombatActionId>([
  "approach",
  "close_distance_sprinting",
  "strafe_left",
  "strafe_right",
  "retreat",
  "reposition",
]);

/** Blocks the bot climbs by jumping; anything taller needs real pathfinding. */
const CLIMB_JUMP_MAX_RISE = 1.6;
const CLIMB_JUMP_MAX_DISTANCE = 4;

export interface CombatEngineDeps {
  bot: BotLike;
  config: Config;
  logger: Logger;
  provider: JevProvider;
  selector: TargetSelector;
  executor: CombatExecutor;
  metrics?: DecisionMetrics;
  now?: () => number;
}

export interface CombatEngineSnapshot {
  running: boolean;
  decisionInFlight: boolean;
  currentAction: CombatActionId | null;
  target: TargetState | null;
  metrics: MetricsSnapshot;
}

export class CombatEngine {
  private readonly bot: BotLike;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly provider: JevProvider;
  private readonly selector: TargetSelector;
  private readonly executor: CombatExecutor;
  private readonly metrics: DecisionMetrics;
  private readonly now: () => number;
  private readonly attackRange: number;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private tickCount = 0;
  private generation = 0;
  private forcedAction: CombatActionId | null = null;

  private lastAttackAtMs = Number.NEGATIVE_INFINITY;
  private lastDecisionRequestMs = Number.NEGATIVE_INFINITY;
  private decisionInFlight = false;
  private abortController: AbortController | null = null;
  private inflight: Promise<void> | null = null;
  private backoffMs = 0;

  private currentAction: CombatActionId | null = null;
  private currentActionIsNew = false;
  private currentDecision: DecisionResult | null = null;
  private decisionSignature: string | null = null;
  private lastObservation: Observation | null = null;
  private lastLegalActions: LegalAction[] = [];
  private observationCache: ObservationCache = {};
  private legalCache: { key: string; actions: LegalAction[] } | null = null;

  constructor(deps: CombatEngineDeps) {
    this.bot = deps.bot;
    this.config = deps.config;
    this.logger = deps.logger;
    this.provider = deps.provider;
    this.selector = deps.selector;
    this.executor = deps.executor;
    this.metrics = deps.metrics ?? new DecisionMetrics();
    this.now = deps.now ?? Date.now;
    this.attackRange = Math.min(this.config.combat.attackRange, VANILLA_ATTACK_REACH);
  }

  get running(): boolean {
    return !this.stopped;
  }

  /**
   * Development override: pin the action the bot runs until cleared, so a dev can exercise one move
   * by hand. Pass `null` to hand control back to the model. Never used on the production path.
   */
  forceAction(action: CombatActionId | null): void {
    this.forcedAction = action;
  }

  get forced(): CombatActionId | null {
    return this.forcedAction;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const intervalMs = Math.max(1, Math.round(1000 / this.config.combat.loopHz));
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.logger.info("combat loop started", { loopHz: this.config.combat.loopHz, intervalMs });
  }

  stop(reason = "shutdown"): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abortController?.abort(new Error("engine stopped"));
    this.abortController = null;
    this.reset(reason);
    this.logger.info("combat loop stopped", { reason });
  }

  /** Called on respawn, reconnect, or world change: abandon state and rebuild from scratch. */
  reset(reason: string): void {
    this.generation += 1;
    this.selector.reset();
    this.executor.release();
    this.currentAction = null;
    this.currentActionIsNew = false;
    this.currentDecision = null;
    this.decisionSignature = null;
    this.lastObservation = null;
    this.lastLegalActions = [];
    this.observationCache = {};
    this.legalCache = null;
    this.backoffMs = 0;
    this.lastAttackAtMs = Number.NEGATIVE_INFINITY;
    this.logger.debug("combat state reset", { reason });
  }

  snapshot(): CombatEngineSnapshot {
    return {
      running: !this.stopped,
      decisionInFlight: this.decisionInFlight,
      currentAction: this.currentAction,
      target: this.lastObservation?.target ?? null,
      metrics: this.metrics.snapshot(this.now()),
    };
  }

  private isReady(): boolean {
    const entity = this.bot.entity;
    return Boolean(entity && entity.position && entity.isValid !== false && typeof this.bot.health === "number");
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } catch (error) {
      this.logger.error("combat tick failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    if (!this.isReady()) {
      this.executor.release();
      return;
    }

    this.tickCount += 1;
    const now = this.now();
    const attackReady = now - this.lastAttackAtMs >= this.config.combat.attackIntervalMs;
    const targetEntity = this.selector.select(this.bot, now);

    const observation = await sampleObservation(
      this.bot,
      this.config,
      {
        tick: this.tickCount,
        now,
        attackReady,
        target: targetEntity,
      },
      this.observationCache,
    );
    this.lastObservation = observation;

    if (targetEntity) {
      try {
        await this.executor.trackTarget(targetEntity);
      } catch (error) {
        this.logger.debug("target tracking failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const legalKey = legalActionsSignature(observation, this.config);
    let legalActions = this.legalCache?.key === legalKey ? this.legalCache.actions : null;
    if (!legalActions) {
      legalActions = buildLegalActions(observation, this.config);
      this.legalCache = { key: legalKey, actions: legalActions };
    }
    this.lastLegalActions = legalActions;

    // Development override: run one action on every tick, bypassing the model. Dev console only.
    if (this.forcedAction) {
      if (this.currentAction !== this.forcedAction) this.setAction(this.forcedAction, null);
      await this.executeCurrent(targetEntity);
      return;
    }

    if (!observation.target) {
      this.abandon("target lost");
      return;
    }

    if (legalActions.length <= 1) {
      this.metrics.record({ latencyMs: 0, outcome: "skipped", atMs: now });
      const only = legalActions[0]?.id ?? "hold_position";
      this.setAction(only, null);
      await this.executeCurrent(targetEntity);
      return;
    }

    const signature = observationSignature(observation, this.config);
    const materialChange = this.decisionSignature !== null && signature !== this.decisionSignature;
    const retryDue = now - this.lastDecisionRequestMs >= this.config.combat.decisionMinIntervalMs + this.backoffMs;
    const needsDecision = (this.currentAction === null || materialChange) && retryDue && !this.decisionInFlight;

    if (needsDecision) {
      this.dispatchDecision(observation, legalActions, observation.target.id, signature, now);
    }

    // Act every tick like a per-tick controller rather than waiting on the decision.
    if (this.currentAction) {
      await this.executeCurrent(targetEntity);
    }

    // If there is no chosen action yet, swing on the reflex so the bot fights from the first tick
    // instead of standing still for the seconds the model takes to answer.
    if (this.currentAction === null && this.config.combat.reflexAttack && this.tryReflexAttack(null, targetEntity, attackReady)) {
      this.lastAttackAtMs = this.now();
    }

    // Movement is a per-tick reflex too, so the bot is never a sitting duck: it keeps its distance
    // and circles while the model thinks, whether or not a decision has landed. The model's own
    // movement actions (approach, strafes, retreat) take precedence when it picks one.
    if (!this.currentAction || !MOVEMENT_ACTIONS.has(this.currentAction)) {
      this.applyMovementReflex(observation);
    }
    this.applyClimbJump(observation);
  }

  /**
   * The move the bot makes on its own: back off when hurt, close the gap when out of reach, and
   * otherwise circle the target. It never stands still while an enemy is in sight.
   */
  private applyMovementReflex(observation: Observation): void {
    if (!this.config.combat.fallbackAction) return;
    const target = observation.target;
    if (!target || observation.environment.openDirectionCount < 1) return;

    if (target.distance > this.attackRange) {
      this.bot.setControlState("forward", true);
      if (target.distance > this.config.combat.strafeRange) this.bot.setControlState("sprint", true);
      return;
    }
    if (
      observation.self.health / 20 <= this.config.combat.retreatHealthFraction &&
      observation.environment.openDirectionCount >= 1
    ) {
      this.bot.setControlState("back", true);
      return;
    }
    // Alternate the circle direction every ~half second so the bot keeps its angle changing.
    this.bot.setControlState(Math.floor(this.tickCount / 10) % 2 === 0 ? "left" : "right", true);
  }

  /**
   * Jump reflex for terrain: hop when the target is on a block above the bot, or when a step is
   * blocking the approach, so the bot can climb a hill or a single block to reach the player.
   */
  private applyClimbJump(observation: Observation): void {
    const target = observation.target;
    if (!target) return;
    const entity = this.bot.entity;

    // Hold jump while the target is above or a step is blocking the way. The physics only actually
    // leaves the ground when the bot is grounded, so a held jump becomes a hop up each block the
    // bot reaches rather than a single mistimed jump. (Do not gate on `entity.onGround`: the
    // server's per-tick position syncs keep clobbering it to false.)
    const rise = target.position.y - entity.position.y;
    const blocked =
      (entity as unknown as { isCollidedHorizontally?: boolean }).isCollidedHorizontally === true;
    const wantsClimb = rise > 0.5 && rise <= CLIMB_JUMP_MAX_RISE && target.distance <= CLIMB_JUMP_MAX_DISTANCE;
    const stuckAgainstStep = blocked && target.distance > this.attackRange;
    if (wantsClimb || stuckAgainstStep) this.bot.setControlState("jump", true);
  }

  private setAction(action: CombatActionId, decision: DecisionResult | null): void {
    this.currentAction = action;
    this.currentActionIsNew = true;
    this.currentDecision = decision;
  }

  private async executeCurrent(target: Entity | null): Promise<void> {
    if (!this.currentAction) return;
    const isNew = this.currentActionIsNew;
    this.currentActionIsNew = false;
    await this.executeAction(this.currentAction, target, isNew);
  }

  private async executeAction(action: CombatActionId, target: Entity | null, isNew: boolean): Promise<void> {
    const attackReady = this.now() - this.lastAttackAtMs >= this.config.combat.attackIntervalMs;
    const result = await this.executor.applyAction(action, target, isNew, attackReady);

    let attacked = result.attacked;
    // Reflex: a vanilla client swings the moment the cooldown is up, no matter what it is doing.
    // Without this the bot only ever swings on the tick an action timeline says so, so attacks wait
    // on the (slow) decision cadence. Technique actions that time their own swing keep control.
    if (!attacked && this.config.combat.reflexAttack && this.tryReflexAttack(action, target, attackReady)) {
      attacked = true;
      this.logger.debug("reflex attack", { action });
    }
    if (attacked) {
      this.lastAttackAtMs = this.now();
      this.logger.debug("attacked target", { action });
    }
  }

  private tryReflexAttack(action: CombatActionId | null, target: Entity | null, attackReady: boolean): boolean {
    if (!attackReady || !target || target.isValid === false) return false;
    if (action && REFLEX_ATTACK_BLOCKED.has(action)) return false;
    if (target.position.distanceTo(this.bot.entity.position) > this.attackRange) return false;
    try {
      this.bot.attack(target);
      return true;
    } catch {
      return false;
    }
  }

  private dispatchDecision(
    observation: Observation,
    legalActions: LegalAction[],
    targetId: number,
    signature: string,
    now: number,
  ): void {
    this.decisionInFlight = true;
    this.lastDecisionRequestMs = now;
    const generation = this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = now;

    this.inflight = this.performDecision({
      observation,
      legalActions,
      targetId,
      signature,
      generation,
      controller,
      startedAt,
    });
  }

  /** Waits for the current in-flight decision (if any) to finish. Useful for tests and shutdown. */
  async settle(): Promise<void> {
    while (this.inflight) {
      const pending = this.inflight;
      try {
        await pending;
      } catch {
        /* performDecision never rejects, but be safe */
      }
      if (this.inflight === pending) this.inflight = null;
    }
  }

  private async performDecision(ctx: {
    observation: Observation;
    legalActions: LegalAction[];
    targetId: number;
    signature: string;
    generation: number;
    controller: AbortController;
    startedAt: number;
  }): Promise<void> {
    const { legalActions, targetId, signature, generation, controller, startedAt } = ctx;
    const timeoutMs = this.config.combat.decisionTimeoutMs;
    const timeout = setTimeout(() => controller.abort(new Error("decision timeout")), timeoutMs);

    try {
      const request = {
        state: buildCombatState(ctx.observation, legalActions),
        choice: buildDecisionChoice(legalActions),
        model: this.config.jev.model,
      };
      const response = await this.provider.decide(request, {
        signal: controller.signal,
        timeoutMs: this.config.jev.timeoutMs,
      });
      const latencyMs = this.now() - startedAt;
      this.onDecisionResolved({ response, legalActions, targetId, signature, generation, latencyMs });
    } catch (error) {
      const latencyMs = this.now() - startedAt;
      const jevError = error instanceof JevError ? error : new JevError("unknown", error instanceof Error ? error.message : String(error));
      this.recordOutcome(jevError.kind, latencyMs);
      this.onDecisionFailure(jevError);
    } finally {
      clearTimeout(timeout);
      this.decisionInFlight = false;
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private onDecisionResolved(ctx: {
    response: { answer: unknown; model: string; usage: { inputTokens: number | null; outputTokens: number | null } };
    legalActions: LegalAction[];
    targetId: number;
    signature: string;
    generation: number;
    latencyMs: number;
  }): void {
    const { response, legalActions, targetId, signature, generation, latencyMs } = ctx;

    if (this.stopped || generation !== this.generation || this.selector.currentTarget?.id !== targetId) {
      this.recordOutcome("stale", latencyMs);
      this.logger.debug("discarded stale decision (target changed)", { targetId });
      return;
    }

    const latestSignature = this.lastObservation ? observationSignature(this.lastObservation, this.config) : "no-target";
    if (latestSignature !== signature) {
      this.recordOutcome("stale", latencyMs);
      this.logger.debug("discarded stale decision (world changed)", { signature, latestSignature });
      return;
    }

    let decision: DecisionResult;
    try {
      decision = toDecisionResult({
        answer: response.answer,
        legalActions,
        model: response.model,
        usage: response.usage,
        latencyMs,
        answeredAtMs: this.now(),
      });
    } catch (error) {
      const jevError = error instanceof JevError ? error : new JevError("invalid", String(error));
      if (jevError.kind === "stale") {
        // The answer named an action that is no longer offered (e.g. an attack now on cooldown).
        // Drop it and keep fighting on the current action / reflex instead of abandoning.
        this.recordOutcome("stale", latencyMs);
        this.logger.debug("ignored a no-longer-legal decision", { message: jevError.message });
        return;
      }
      this.recordOutcome("invalid", latencyMs);
      this.onDecisionFailure(jevError);
      return;
    }

    const stillLegal = legalActions.some((action) => action.id === decision.actionId);
    if (!stillLegal) {
      this.recordOutcome("stale", latencyMs);
      return;
    }

    this.recordOutcome("ok", latencyMs);
    this.backoffMs = 0;
    this.setAction(decision.actionId, decision);
    this.decisionSignature = signature;
    this.logger.info("jev selected action", {
      action: decision.actionId,
      confidence: decision.confidence,
      latencyMs,
      model: decision.model,
      topProbabilities: topProbabilities(decision.probabilities),
    });
  }

  private onDecisionFailure(error: JevError): void {
    this.logger.warn("decision request failed", { kind: error.kind, status: error.status, message: error.message });

    if (this.config.jev.onFailure === "hold" && error.kind !== "auth") {
      this.logger.debug("onFailure=hold: keeping previous action while Jev is unavailable");
    } else {
      this.abandon(`decision ${error.kind}`);
    }

    const step = Math.max(this.config.combat.decisionMinIntervalMs, 1);
    this.backoffMs = Math.min(this.backoffMs === 0 ? step : this.backoffMs * 2, MAX_BACKOFF_MS);
    if (error.kind === "auth") {
      this.backoffMs = MAX_BACKOFF_MS;
      this.logger.error("Jev authentication failed; halting new combat actions until credentials are fixed");
    }
    this.logger.debug("decision backoff set", { backoffMs: this.backoffMs });
  }

  private abandon(reason: string): void {
    if (this.currentAction !== null) this.logger.debug("clearing current action", { reason });
    this.currentAction = null;
    this.currentActionIsNew = false;
    this.currentDecision = null;
    this.executor.release();
  }

  private recordOutcome(outcome: DecisionOutcome, latencyMs: number): void {
    this.metrics.record({ latencyMs, outcome, atMs: this.now() });
  }
}

function topProbabilities(probabilities: Record<string, number>, limit = 3): Record<string, number> {
  const sorted = Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const output: Record<string, number> = {};
  for (const [key, value] of sorted) output[key] = value;
  return output;
}
