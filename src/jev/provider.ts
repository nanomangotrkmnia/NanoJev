import type { ChoiceSpec } from "../state.js";

export interface DecisionRequest {
  state: Record<string, unknown>;
  choice: ChoiceSpec;
  model: string;
}

export interface DecisionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface DecisionResponse {
  answer: unknown;
  model: string;
  usage: DecisionUsage;
}

export interface DecideOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface JevProvider {
  readonly name: string;
  readonly configured: boolean;
  describe(): string;
  decide(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse>;
}
