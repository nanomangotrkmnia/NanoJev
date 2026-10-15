import { execFileSync } from "node:child_process";
import { OPENJEV_MODELS, supportsHardware, type HardwareCaps, type OpenJevModel } from "./catalog.js";

export interface OpenJevProbeResult {
  reachable: boolean;
  models: string[];
  error?: string;
}

export interface OpenJevProbeOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  if (url.endsWith("/v1/systemone")) url = url.slice(0, -"/v1/systemone".length);
  else if (url.endsWith("/v1")) url = url.slice(0, -"/v1".length);
  return url;
}

export function deriveEndpoint(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl);
}

function extractModelIds(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => (typeof entry === "string" ? entry : (entry as { id?: string; name?: string })?.id ?? (entry as { name?: string })?.name))
      .filter((id): id is string => typeof id === "string");
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const list = record.data ?? record.models;
    if (Array.isArray(list)) return extractModelIds(list);
  }
  return [];
}

export async function probeOpenJev(options: OpenJevProbeOptions): Promise<OpenJevProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("probe timeout")), options.timeoutMs ?? 3_000);
  try {
    const response = await fetchImpl(`${deriveEndpoint(options.baseUrl)}/v1/models`, {
      headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { reachable: false, models: [], error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    return { reachable: true, models: extractModelIds(payload) };
  } catch (error) {
    return { reachable: false, models: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export interface OpenJevSmokeResult {
  ok: boolean;
  choice?: string;
  confidence?: number | null;
  error?: string;
}

export async function smokeDecision(options: OpenJevProbeOptions & { model?: string }): Promise<OpenJevSmokeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("smoke timeout")), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(`${deriveEndpoint(options.baseUrl)}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model ?? "openjev-latest",
        state: "The server is on fire and customers are complaining.",
        questions: {
          ping: {
            type: "choice",
            instructions: "Is this an emergency?",
            criteria: { yes: "needs immediate attention", no: "can wait" },
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as { answers?: Record<string, { choice?: string; confidence?: number | null }> };
    const answer = payload.answers?.ping;
    return { ok: Boolean(answer?.choice), choice: answer?.choice, confidence: answer?.confidence ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export function detectHardware(): HardwareCaps {
  const caps: HardwareCaps = {
    nvidia: false,
    nvidiaBlackwell: false,
    appleSilicon: process.platform === "darwin" && process.arch === "arm64",
    cpu: true,
    vramGb: null,
  };

  try {
    const output = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader"],
      { encoding: "utf8", timeout: 4_000, windowsHide: true },
    ).trim();
    const firstLine = output.split(/\r?\n/)[0] ?? "";
    if (firstLine) {
      caps.nvidia = true;
      const match = firstLine.match(/(\d+)\s*MiB/i);
      if (match) caps.vramGb = Math.round(Number(match[1]) / 1024);
      const lower = firstLine.toLowerCase();
      caps.nvidiaBlackwell =
        lower.includes("rtx 50") ||
        lower.includes("rtx pro") ||
        lower.includes("b200") ||
        lower.includes("b100") ||
        lower.includes("gb200") ||
        lower.includes("blackwell");
    }
  } catch {
    caps.nvidia = false;
  }

  return caps;
}

export function describeHardware(caps: HardwareCaps): string {
  const parts: string[] = [];
  if (caps.nvidiaBlackwell) parts.push(`NVIDIA Blackwell${caps.vramGb ? ` (${caps.vramGb} GB)` : ""}`);
  else if (caps.nvidia) parts.push(`NVIDIA GPU${caps.vramGb ? ` (${caps.vramGb} GB)` : ""}`);
  if (caps.appleSilicon) parts.push("Apple silicon");
  if (parts.length === 0) parts.push("CPU only");
  return parts.join(" + ");
}

export interface LaunchStep {
  description: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface LaunchPlan {
  model: OpenJevModel;
  supported: boolean;
  endpoint: string;
  steps: LaunchStep[];
}

export const OPENJEV_REPO = "https://github.com/razorback16/openjev.git";

export function buildLaunchPlan(model: OpenJevModel, caps: HardwareCaps, port = 8080): LaunchPlan {
  const env: Record<string, string> = { OPENJEV_BACKEND: model.backend };
  if (model.envModel) env.OPENJEV_MODEL = model.envModel;
  if (model.backend === "mlx") env.OPENJEV_BACKEND = "mlx";

  const supported = supportsHardware(model, caps);

  const steps: LaunchStep[] = [
    {
      description: "Fetch OpenJev if it is not checked out yet",
      command: `git clone ${OPENJEV_REPO} tools/openjev`,
    },
  ];

  if (caps.nvidia) {
    steps.push({
      description: "Start the container (vLLM backends) on 127.0.0.1:8080",
      command: "docker compose up -d",
      cwd: "tools/openjev",
      env,
    });
  } else {
    steps.push({
      description: "Install OpenJev and run it in-process",
      command: `pip install -e '.[${model.backend}]' && python -m openjev`,
      cwd: "tools/openjev",
      env,
    });
  }

  return {
    model,
    supported,
    endpoint: `http://127.0.0.1:${port}`,
    steps,
  };
}

export function modelsForHardware(caps: HardwareCaps): OpenJevModel[] {
  return OPENJEV_MODELS.map((model) => model);
}
