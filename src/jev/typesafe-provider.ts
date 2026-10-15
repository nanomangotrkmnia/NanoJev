import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
  choice,
  type EntryType,
} from "@typesafe-ai/sdk";
import type { Config } from "../config.js";
import { JevError, type DecisionFailureKind } from "../state.js";
import { DECISION_QUESTION_ID } from "./decision.js";
import type { DecideOptions, DecisionRequest, DecisionResponse, JevProvider } from "./provider.js";

export interface TypesafeJevProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  label?: string;
}

function classifyError(error: unknown): JevError {
  if (error instanceof JevError) return error;

  const message = error instanceof Error ? error.message : String(error);

  const make = (kind: DecisionFailureKind, status?: number) =>
    new JevError(kind, message, status, { cause: error });

  if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return make("timeout");
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) return make("auth", error.status);
  if (error instanceof RateLimitError || error instanceof InternalServerError) return make("unavailable", error.status);
  if (error instanceof APIConnectionError) return make("unavailable");
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) return make("invalid", error.status);
  if (error instanceof APIError) {
    const status = error.status;
    return make(typeof status === "number" && status >= 500 ? "unavailable" : "unknown", status);
  }
  if (error instanceof TypeSafeError) return make("unknown");
  return make("unknown");
}

/**
 * Live Jev provider backed by the official TypeSafe SDK (`@typesafe-ai/sdk`).
 *
 * Sends a single typed Choice question to `client.systemOne` and returns the raw
 * Choice answer for validation. It never executes model output directly.
 */
export class TypesafeJevProvider implements JevProvider {
  readonly name: string;
  readonly configured: boolean;
  private readonly client: TypeSafeClient;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: TypesafeJevProviderOptions) {
    this.name = options.label ?? "typesafe";
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? "https://api.typesafe.ai";
    this.configured = options.apiKey.trim().length > 0;
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      defaultModel: options.model,
      timeout: options.timeoutMs,
      retry: { maxRetries: options.maxRetries },
      logLevel: "off",
      // The SDK zstd-compresses request bodies >= 1 KiB by default. Hosted OpenJev
      // (Codiv) rejects those with `422 ... JSON decode error`, and combat observations
      // are well over 1 KiB, so send every body uncompressed.
      compression: false,
      fetch: options.fetchImpl,
    });
  }

  static fromConfig(config: Config): TypesafeJevProvider {
    return new TypesafeJevProvider({
      apiKey: config.jev.apiKey ?? "",
      baseUrl: config.jev.baseUrl,
      model: config.jev.model,
      timeoutMs: config.jev.timeoutMs,
      maxRetries: config.jev.maxRetries,
      label: "typesafe",
    });
  }

  describe(): string {
    return this.configured
      ? `${this.name} model=${this.model} endpoint=${this.baseUrl}`
      : `${this.name} (not configured: API key missing) model=${this.model} endpoint=${this.baseUrl}`;
  }

  async decide(request: DecisionRequest, options: DecideOptions = {}): Promise<DecisionResponse> {
    if (!this.configured) {
      throw new JevError("auth", "TYPESAFE_API_KEY is not configured");
    }

    try {
      const result = await this.client.systemOne(
        {
          state: request.state as unknown as NonNullable<EntryType>,
          model: request.model,
          questions: {
            [DECISION_QUESTION_ID]: choice(request.choice.instructions, request.choice.criteria),
          },
        },
        { signal: options.signal, timeout: options.timeoutMs },
      );

      const answer = (result.answers as Record<string, unknown>)[DECISION_QUESTION_ID];
      return {
        answer,
        model: result.model,
        usage: {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        },
      };
    } catch (error) {
      throw classifyError(error);
    }
  }
}
