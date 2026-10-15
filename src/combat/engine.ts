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

const MAX_BACKOFF_MS = 30_000;

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

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private tickCount = 0;
  private generation = 0;

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
  }

  get running(): boolean {
    return !this.stopped;
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

    if (this.currentAction) {
      await this.executeCurrent(targetEntity);
    }
  }

  private setAction(action: CombatActionId, decision: DecisionResult | null): void {
    this.currentAction = action;
    this.currentActionIsNew = true;
    this.currentDecision = decision;
  }

  private async executeCurrent(target: Entity | null): Promise<void> {
    if (!this.currentAction) return;
    const isNew = this.currentActionIsNew;
    const attackReady = this.now() - this.lastAttackAtMs >= this.config.combat.attackIntervalMs;
    const result = await this.executor.applyAction(this.currentAction, target, isNew, attackReady);
    this.currentActionIsNew = false;
    if (result.attacked) {
      this.lastAttackAtMs = this.now();
      this.logger.debug("attacked target", { action: this.currentAction });
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
      this.recordOutcome("invalid", latencyMs);
      this.onDecisionFailure(error instanceof JevError ? error : new JevError("invalid", String(error)));
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
