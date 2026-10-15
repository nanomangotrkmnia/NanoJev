import type { DecideOptions, DecisionRequest, DecisionResponse, JevProvider } from "../../src/jev/provider.js";

export interface ScriptedProvider {
  provider: JevProvider;
  requests: DecisionRequest[];
  calls: number;
}

export function choiceAnswer(choice: string, confidence = 1): DecisionResponse {
  return {
    answer: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence },
    model: "scripted-1",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

export function scriptedProvider(
  handler: (request: DecisionRequest, options: DecideOptions, index: number) => Promise<DecisionResponse>,
): ScriptedProvider {
  const requests: DecisionRequest[] = [];
  const state: ScriptedProvider = {
    requests,
    calls: 0,
    provider: {
      name: "scripted",
      configured: true,
      describe: () => "scripted",
      decide: async (request, options) => {
        const index = state.calls;
        state.calls += 1;
        requests.push(request);
        return handler(request, options ?? {}, index);
      },
    },
  };
  return state;
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
