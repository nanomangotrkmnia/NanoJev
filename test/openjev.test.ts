import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OPENJEV_MODEL,
  OPENJEV_MODELS,
  findModel,
  formatHostedModelLine,
  formatModelDetail,
  formatModelLine,
  supportsHardware,
  type HardwareCaps,
} from "../src/openjev/catalog.js";
import {
  buildLaunchPlan,
  deriveEndpoint,
  describeHardware,
  probeOpenJev,
  smokeDecision,
} from "../src/openjev/server.js";
import { persistModel } from "../src/cli/openjev-run.js";

const caps: HardwareCaps = {
  nvidia: true,
  nvidiaBlackwell: true,
  appleSilicon: false,
  cpu: true,
  vramGb: 48,
};

describe("OpenJev catalog", () => {
  it("includes the models the launcher advertises, including clef-flash", () => {
    const ids = OPENJEV_MODELS.map((model) => model.id);
    expect(ids).toContain("openjev-latest");
    expect(ids).toContain("clef-flash-1.0");
    expect(ids).toContain("laya-1.0");
    expect(ids).toContain("verdict-1.4");
  });

  it("renders a model with hardware and an ease-of-run score out of 10", () => {
    const clefFlash = findModel("clef-flash-1.0")!;
    const line = formatModelLine(clefFlash);
    expect(line).toBe("clef-flash-1.0 (Supports: NVIDIA Blackwell GPU (RTX 50 / Pro), ~12 GB VRAM, 6/10)");
    expect(clefFlash.easeOfRun).toBeGreaterThanOrEqual(1);
    expect(clefFlash.easeOfRun).toBeLessThanOrEqual(10);
  });

  it("renders a hosted model label without hardware or ease-of-run", () => {
    const clefFlash = findModel("clef-flash-1.0")!;
    const hosted = formatHostedModelLine(clefFlash);
    expect(hosted).toBe("clef-flash-1.0  (Clef-flash)");
    expect(hosted).not.toContain("Supports:");
    expect(hosted).not.toContain("/10");
  });

  it("resolves aliases to the same model", () => {
    expect(findModel("jev-latest")?.id).toBe("openjev-latest");
    expect(findModel("openjev-0.1")?.id).toBe("openjev-latest");
    expect(findModel("nope")).toBeUndefined();
  });

  it("describes origin and capabilities in the detail view", () => {
    const detail = formatModelDetail(findModel(DEFAULT_OPENJEV_MODEL)!);
    expect(detail).toContain("DiffusionGemma");
    expect(detail).toContain("Supports:");
  });

  it("matches models against detected hardware", () => {
    expect(supportsHardware(findModel("clef-flash-1.0")!, caps)).toBe(true);
    expect(supportsHardware(findModel("laya-1.0")!, caps)).toBe(true);
    expect(
      supportsHardware(findModel("openjev-latest")!, {
        nvidia: false,
        nvidiaBlackwell: false,
        appleSilicon: false,
        cpu: true,
        vramGb: null,
      }),
    ).toBe(false);
  });

  it("assigns a 1-10 ease score to every model", () => {
    for (const model of OPENJEV_MODELS) {
      expect(model.easeOfRun).toBeGreaterThanOrEqual(1);
      expect(model.easeOfRun).toBeLessThanOrEqual(10);
    }
  });
});

describe("OpenJev server helpers", () => {
  it("normalizes base URLs and strips the systemone/v1 suffix", () => {
    expect(deriveEndpoint("https://api.codiv.ai/v1/systemone")).toBe("https://api.codiv.ai");
    expect(deriveEndpoint("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080");
    expect(deriveEndpoint("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
  });

  it("probes /v1/models and reports reachability and model ids", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "openjev-latest" }, { id: "clef-flash-1.0" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await probeOpenJev({ baseUrl: "http://127.0.0.1:8080", fetchImpl });
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual(["openjev-latest", "clef-flash-1.0"]);
  });

  it("reports unreachable on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await probeOpenJev({ baseUrl: "http://127.0.0.1:8080", fetchImpl });
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("runs a smoke decision against /v1/systemone", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8080/v1/systemone");
      const body = JSON.parse(String(init.body));
      expect(body.questions.ping.type).toBe("choice");
      return new Response(
        JSON.stringify({ answers: { ping: { type: "choice", choice: "yes", confidence: 0.9 } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await smokeDecision({ baseUrl: "http://127.0.0.1:8080", fetchImpl, model: "openjev-latest" });
    expect(result.ok).toBe(true);
    expect(result.choice).toBe("yes");
  });

  it("builds a docker plan on NVIDIA hardware", () => {
    const plan = buildLaunchPlan(findModel("openjev-latest")!, caps);
    expect(plan.supported).toBe(true);
    expect(plan.steps.some((step) => step.command.includes("docker compose up"))).toBe(true);
    expect(plan.steps[1]!.env?.OPENJEV_BACKEND).toBe("vllm");
  });

  it("builds a pip plan without an NVIDIA GPU", () => {
    const plan = buildLaunchPlan(findModel("laya-1.0")!, {
      nvidia: false,
      nvidiaBlackwell: false,
      appleSilicon: true,
      cpu: true,
      vramGb: null,
    });
    expect(plan.steps.some((step) => step.command.includes("python -m openjev"))).toBe(true);
    expect(plan.supported).toBe(true);
  });

  it("describes detected hardware for the launcher", () => {
    expect(describeHardware(caps)).toContain("Blackwell");
    expect(describeHardware({ nvidia: false, nvidiaBlackwell: false, appleSilicon: false, cpu: true, vramGb: null })).toBe(
      "CPU only",
    );
  });
});

describe("persistModel", () => {
  it("writes the chosen OpenJev model and backend to .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "nanojev-"));
    const path = persistModel(dir, "clef-flash-1.0", "http://127.0.0.1:8080");
    const content = readFileSync(path, "utf8");
    expect(path.endsWith(".env")).toBe(true);
    expect(content).toContain("NANOJEV_JEV_BACKEND=openjev");
    expect(content).toContain("OPENJEV_MODEL=clef-flash-1.0");
    expect(content).toContain("OPENJEV_BASE_URL=http://127.0.0.1:8080");
  });
});
