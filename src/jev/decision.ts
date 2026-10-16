import { z } from "zod";
import type { ChoiceSpec, CombatActionId, DecisionResult, LegalAction, Observation } from "../state.js";
import { JevError } from "../state.js";

export const DECISION_QUESTION_ID = "next_action";

export const DECISION_QUESTION =
  "Given the current combat state and the listed legal actions, which action is most appropriate for the next combat interval?";

export function buildCombatState(obs: Observation, legalActions: LegalAction[]): Record<string, unknown> {
  const self: Record<string, unknown> = {
    health: obs.self.health,
    food: obs.self.food,
    onGround: obs.self.onGround,
    heldItem: obs.self.heldItem,
    shieldAvailable: obs.self.shieldAvailable,
    attackReady: obs.self.attackReady,
    speed: obs.self.speed,
  };
  const target = obs.target
    ? {
        username: obs.target.username,
        distance: obs.target.distance,
        relativeYawDeg: obs.target.relativeYawDeg,
        relativePitchDeg: obs.target.relativePitchDeg,
        onGround: obs.target.onGround,
        health: obs.target.health,
        visible: obs.target.visible,
        velocity: obs.target.velocity,
      }
    : null;

  return {
    task: "Minecraft PvP combat. Choose the single best action for the next combat interval.",
    self,
    target,
    environment: {
      dimension: obs.environment.dimension,
      openDirections: obs.environment.movingInto,
      openDirectionCount: obs.environment.openDirectionCount,
      groundBelow: obs.environment.groundBelow,
      inWater: obs.environment.inWater,
      inLava: obs.environment.inLava,
      nearbyHostiles: obs.environment.nearbyHostiles,
    },
    data_notes: {
      targetHealth: obs.sources.targetHealth,
      visibility: obs.sources.visibility,
      attackReady: "estimated from a configurable attack interval, not read from the protocol",
      distances: "approximate block distance",
      swings:
        "the bot swings by itself the instant its attack is off cooldown and the target is in reach, " +
        "whatever action is chosen, so use the action to choose positioning, spacing, and technique " +
        "rather than whether to attack; only timing techniques (hitselect) hold the swing",
    },
    legal_actions: legalActions.map((action) => action.id),
  };
}

export function buildDecisionChoice(legalActions: LegalAction[]): ChoiceSpec {
  const criteria: Record<string, string> = {};
  for (const action of legalActions) {
    criteria[action.id] = action.description;
  }
  return { instructions: DECISION_QUESTION, criteria };
}

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.number()).optional(),
  confidence: z.number().nullable().optional(),
});

export interface RawChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
}

export function parseChoiceAnswer(answer: unknown, legalActions: LegalAction[]): RawChoiceAnswer {
  const parsed = choiceAnswerSchema.safeParse(answer);
  if (!parsed.success) {
    throw new JevError("invalid", `Jev returned a malformed Choice answer: ${parsed.error.message}`);
  }

  const offered = new Set<string>(legalActions.map((action) => action.id));
  if (!offered.has(parsed.data.choice)) {
    // Not offered *now* (e.g. an attack that went on cooldown while the answer was in flight). This
    // is a stale/misaligned pick, not a malformed answer, so the caller should drop it and keep the
    // current action rather than treat it as a fatal error.
    throw new JevError(
      "stale",
      `Jev selected "${parsed.data.choice}", which was not among the offered actions (${[...offered].join(", ")})`,
    );
  }

  return {
    choice: parsed.data.choice,
    probabilities: parsed.data.probabilities ?? {},
    confidence: parsed.data.confidence ?? null,
  };
}

export interface BuildDecisionResultInput {
  answer: unknown;
  legalActions: LegalAction[];
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  latencyMs: number;
  answeredAtMs: number;
}

export function toDecisionResult(input: BuildDecisionResultInput): DecisionResult {
  const answer = parseChoiceAnswer(input.answer, input.legalActions);
  return {
    actionId: answer.choice as CombatActionId,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    model: input.model,
    usage: input.usage,
    latencyMs: input.latencyMs,
    answeredAtMs: input.answeredAtMs,
  };
}
