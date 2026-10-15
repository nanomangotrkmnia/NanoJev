import { describe, expect, it, vi } from "vitest";
import { TypesafeJevProvider } from "../src/jev/typesafe-provider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseChoice = {
  instructions: "Which action?",
  criteria: { attack_target: "hit now", hold_position: "wait" },
};

describe("TypesafeJevProvider", () => {
  it("sends a typed Choice question to /v1/systemone with bearer auth and a model", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        model: "jev-1.13.0",
        answers: {
          next_action: { type: "choice", choice: "attack_target", probabilities: { attack_target: 1 }, confidence: 1 },
        },
        usage: { input_tokens: 100, output_tokens: 4 },
      });
    }) as unknown as typeof fetch;

    const provider = new TypesafeJevProvider({
      apiKey: "secret-key",
      baseUrl: "https://api.example.test",
      model: "jev-latest",
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    expect(provider.configured).toBe(true);

    const result = await provider.decide({
      state: { task: "combat" },
      choice: baseChoice,
      model: "jev-latest",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/systemone");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-key");

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ task: "combat" });
    expect(body.questions.next_action.type).toBe("choice");
    expect(body.questions.next_action.criteria).toEqual(baseChoice.criteria);

    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 4 });
    expect((result.answer as { choice: string }).choice).toBe("attack_target");
  });

  it("sends large states uncompressed so compression-free endpoints accept them", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        model: "openjev-0.1",
        answers: {
          next_action: { type: "choice", choice: "hold_position", probabilities: { hold_position: 1 }, confidence: 1 },
        },
        usage: { input_tokens: 4000, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const provider = new TypesafeJevProvider({
      apiKey: "k",
      baseUrl: "https://api.example.test",
      model: "openjev-latest",
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
    });

    // Bodies >= 1 KiB are the ones the SDK would otherwise zstd-compress.
    const bigState = { blob: "x".repeat(4000) };
    await provider.decide({ state: bigState, choice: baseChoice, model: "openjev-latest" });

    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(String(calls[0]!.init.body)).state).toEqual(bigState);
  });

  it("maps 401 to an auth failure without retrying", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: { error_type: "auth", message: "bad key" } }, 401)) as unknown as typeof fetch;
    const provider = new TypesafeJevProvider({
      apiKey: "bad",
      baseUrl: "https://api.example.test",
      model: "jev-latest",
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl,
    });

    await expect(
      provider.decide({ state: {}, choice: baseChoice, model: "jev-latest" }),
    ).rejects.toMatchObject({ name: "JevError", kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 500 to unavailable and retries up to the configured budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;
    const provider = new TypesafeJevProvider({
      apiKey: "k",
      baseUrl: "https://api.example.test",
      model: "jev-latest",
      timeoutMs: 1000,
      maxRetries: 1,
      fetchImpl,
    });

    await expect(
      provider.decide({ state: {}, choice: baseChoice, model: "jev-latest" }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("reports not configured when the API key is empty", () => {
    const provider = new TypesafeJevProvider({
      apiKey: "",
      baseUrl: "https://api.example.test",
      model: "jev-latest",
      timeoutMs: 1000,
      maxRetries: 0,
    });
    expect(provider.configured).toBe(false);
    expect(provider.describe()).toContain("not configured");
  });

  it("labels the provider for a local OpenJev endpoint", () => {
    const provider = new TypesafeJevProvider({
      apiKey: "openjev-local",
      baseUrl: "http://127.0.0.1:8080",
      model: "clef-flash-1.0",
      timeoutMs: 1000,
      maxRetries: 0,
      label: "openjev",
    });
    expect(provider.name).toBe("openjev");
    expect(provider.describe()).toContain("clef-flash-1.0");
    expect(provider.describe()).toContain("127.0.0.1:8080");
  });
});
