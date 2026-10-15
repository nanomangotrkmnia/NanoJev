import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildLegalActions } from "../src/actions.js";
import {
  DECISION_QUESTION,
  DECISION_QUESTION_ID,
  buildCombatState,
  buildDecisionChoice,
  parseChoiceAnswer,
  toDecisionResult,
} from "../src/jev/decision.js";
import { JevError } from "../src/state.js";
import { makeObservation, makeSelf } from "./helpers/observation.js";

const config = loadConfig({ env: {} });

describe("buildDecisionChoice", () => {
  it("builds one Choice question over exactly the legal actions", () => {
    const legal = buildLegalActions(makeObservation({ self: makeSelf({ shieldAvailable: true }) }), config);
    const choice = buildDecisionChoice(legal);

    expect(choice.instructions).toBe(DECISION_QUESTION);
    expect(Object.keys(choice.criteria).sort()).toEqual(legal.map((action) => action.id).sort());
    for (const action of legal) {
      expect(choice.criteria[action.id]).toBe(action.description);
    }
  });
});

describe("buildCombatState", () => {
  it("includes a compact observation with the legal action ids", () => {
    const obs = makeObservation({ self: makeSelf({ health: 7 }) });
    const legal = buildLegalActions(obs, config);
    const state = buildCombatState(obs, legal) as Record<string, unknown>;

    expect(state.legal_actions).toEqual(legal.map((action) => action.id));
    expect((state.self as Record<string, unknown>).health).toBe(7);
    expect((state.target as Record<string, unknown>).username).toBe("Steve");
    expect(state.data_notes).toBeDefined();
  });
});

describe("parseChoiceAnswer", () => {
  const legal = buildLegalActions(makeObservation({}), config);

  it("accepts a valid in-set choice and keeps probabilities and confidence", () => {
    const answer = {
      type: "choice",
      choice: "attack_target",
      probabilities: { attack_target: 0.8, hold_position: 0.2 },
      confidence: 0.64,
    };
    const parsed = parseChoiceAnswer(answer, legal);
    expect(parsed.choice).toBe("attack_target");
    expect(parsed.confidence).toBe(0.64);
    expect(parsed.probabilities.attack_target).toBe(0.8);
  });

  it("rejects a choice that was not offered", () => {
    const answer = { type: "choice", choice: "teleport_away", probabilities: {}, confidence: 1 };
    expect(() => parseChoiceAnswer(answer, legal)).toThrow(JevError);
    try {
      parseChoiceAnswer(answer, legal);
    } catch (error) {
      expect((error as JevError).kind).toBe("invalid");
    }
  });

  it("rejects malformed answers", () => {
    expect(() => parseChoiceAnswer({ type: "noul", noul: 0.9 }, legal)).toThrow(JevError);
    expect(() => parseChoiceAnswer(null, legal)).toThrow(JevError);
    expect(() => parseChoiceAnswer("attack_target", legal)).toThrow(JevError);
  });

  it("does not require probabilities or confidence", () => {
    const parsed = parseChoiceAnswer({ type: "choice", choice: "hold_position" }, legal);
    expect(parsed.choice).toBe("hold_position");
    expect(parsed.confidence).toBeNull();
    expect(parsed.probabilities).toEqual({});
  });
});

describe("toDecisionResult", () => {
  it("maps a Jev answer to a typed decision result", () => {
    const legal = buildLegalActions(makeObservation({}), config);
    const result = toDecisionResult({
      answer: { type: "choice", choice: "track_target", probabilities: { track_target: 1 }, confidence: 1 },
      legalActions: legal,
      model: "jev-1.13.0",
      usage: { inputTokens: 120, outputTokens: 3 },
      latencyMs: 42,
      answeredAtMs: 1000,
    });
    expect(result.actionId).toBe("track_target");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.latencyMs).toBe(42);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 3 });
  });
});

describe("question id", () => {
  it("is a stable identifier used to read the answer back", () => {
    expect(DECISION_QUESTION_ID).toBe("next_action");
  });
});
