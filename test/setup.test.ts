import { describe, expect, it, vi } from "vitest";
import { planSetupEnv, verifyBackend } from "../src/cli/setup-lib.js";

const minecraft = { address: "play.example.net:25566", username: "NanoJev", auth: "offline" as const, version: "auto" };

describe("planSetupEnv", () => {
  it("writes TypeSafe settings for the typesafe backend", () => {
    const env = planSetupEnv({
      mode: "production",
      backend: "typesafe",
      typesafeApiKey: "sk-typesafe",
      typesafeModel: "jev-latest",
      openjevHosted: false,
      openjevModel: "openjev-latest",
      openjevBaseUrl: "http://127.0.0.1:8080",
      minecraft,
    });
    expect(env.NANOJEV_MODE).toBe("production");
    expect(env.NANOJEV_JEV_BACKEND).toBe("typesafe");
    expect(env.TYPESAFE_API_KEY).toBe("sk-typesafe");
    expect(env.MC_ADDRESS).toBe("play.example.net:25566");
    expect(env.MC_HOST).toBe("play.example.net");
    expect(env.MC_PORT).toBe("25566");
  });

  it("writes local OpenJev settings for the openjev backend", () => {
    const env = planSetupEnv({
      mode: "production",
      backend: "openjev",
      openjevHosted: false,
      openjevBaseUrl: "http://127.0.0.1:8080",
      openjevModel: "clef-flash-1.0",
      minecraft,
    });
    expect(env.NANOJEV_JEV_BACKEND).toBe("openjev");
    expect(env.OPENJEV_HOSTED).toBe("false");
    expect(env.OPENJEV_MODEL).toBe("clef-flash-1.0");
    expect(env.OPENJEV_BASE_URL).toBe("http://127.0.0.1:8080");
  });

  it("writes Codiv settings and forces hosted=true for the codiv backend", () => {
    const env = planSetupEnv({
      mode: "development",
      backend: "codiv",
      openjevHosted: true,
      openjevBaseUrl: "https://api.codiv.ai",
      openjevModel: "openjev-latest",
      openjevApiKey: "sk-codiv-abc",
      minecraft,
    });
    expect(env.NANOJEV_MODE).toBe("development");
    expect(env.NANOJEV_JEV_BACKEND).toBe("codiv");
    expect(env.OPENJEV_HOSTED).toBe("true");
    expect(env.OPENJEV_BASE_URL).toBe("https://api.codiv.ai");
    expect(env.OPENJEV_API_KEY).toBe("sk-codiv-abc");
  });
});

describe("verifyBackend", () => {
  it("reports a reachable local OpenJev server", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "openjev-latest" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await verifyBackend(
      { NANOJEV_JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8080" },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("openjev-latest");
  });

  it("reports an unreachable OpenJev server with guidance", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await verifyBackend(
      { NANOJEV_JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8080" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("run-openjev");
  });

  it("checks the Codiv endpoint using the Codiv base URL", async () => {
    let seenUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: [{ id: "openjev-latest" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await verifyBackend(
      { NANOJEV_JEV_BACKEND: "codiv", OPENJEV_API_KEY: "sk-codiv-abc" },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(seenUrl).toBe("https://api.codiv.ai/v1/models");
  });

  it("reports TypeSafe configured when a key is present", async () => {
    const result = await verifyBackend({ TYPESAFE_API_KEY: "sk-x" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("TypeSafe");
  });
});
