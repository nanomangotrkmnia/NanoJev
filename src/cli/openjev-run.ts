import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CODIV_BASE_URL } from "../config.js";
import { ENV_TEMPLATE, readEnvFile, upsertEnv } from "./env-file.js";
import {
  DEFAULT_OPENJEV_MODEL,
  OPENJEV_MODELS,
  findModel,
  formatModelDetail,
  formatModelLine,
  supportsHardware,
  type OpenJevModel,
} from "../openjev/catalog.js";
import { buildLaunchPlan, describeHardware, detectHardware, probeOpenJev, type LaunchStep } from "../openjev/server.js";
import { createPrompter, isInteractive } from "./prompt.js";

export function printModelCatalog(): void {
  const caps = detectHardware();
  process.stdout.write(`OpenJev models (hardware detected: ${describeHardware(caps)}):\n\n`);
  for (const model of OPENJEV_MODELS) {
    const supported = supportsHardware(model, caps);
    process.stdout.write(`  ${formatModelDetail(model)}${supported ? "" : "\n      [not recommended on this hardware]"}\n`);
  }
  process.stdout.write("\nChoose one with: nanojev openjev --model <id>\n");
  process.stdout.write("Hosted OpenJev on Codiv needs no hardware: use `nanojev codiv`.\n");
}

export async function runCodivInfo(fetchImpl?: typeof fetch): Promise<number> {
  const baseUrl = CODIV_BASE_URL;
  process.stdout.write(`\nCodiv - hosted OpenJev (${baseUrl}/v1/systemone)\n\n`);
  process.stdout.write("Codiv runs the open System One models for you with a free tier (100M input tokens).\n");
  process.stdout.write("Use it by choosing the Codiv backend in `nanojev setup`, or set in .env:\n\n");
  process.stdout.write("  NANOJEV_JEV_BACKEND=codiv\n");
  process.stdout.write(`  OPENJEV_BASE_URL=${baseUrl}\n`);
  process.stdout.write("  OPENJEV_HOSTED=true\n");
  process.stdout.write("  OPENJEV_API_KEY=sk-codiv-...   # from https://codiv.ai\n");
  process.stdout.write("  OPENJEV_MODEL=openjev-latest\n\n");

  const probe = await probeOpenJev({ baseUrl, fetchImpl });
  if (probe.reachable) {
    process.stdout.write(`Reachable. Models reported by Codiv: ${probe.models.join(", ") || "(none reported)"}\n`);
  } else {
    process.stdout.write(`Not reachable right now (${probe.error ?? "no response"}). Sign up at https://codiv.ai for a key.\n`);
  }
  return probe.reachable ? 0 : 1;
}

export interface RunOpenJevOptions {
  argv: string[];
  fetchImpl?: typeof fetch;
  rootDir?: string;
}

export async function runOpenJev(options: RunOpenJevOptions): Promise<number> {
  const caps = detectHardware();
  const rootDir = resolve(options.rootDir ?? ".");
  const execute = options.argv.includes("--execute") || options.argv.includes("-y");
  const modelFlag = readFlag(options.argv, "--model");

  process.stdout.write(`\nOpenJev launcher\nDetected hardware: ${describeHardware(caps)}\n\n`);

  let model: OpenJevModel;
  if (modelFlag) {
    const found = findModel(modelFlag);
    if (!found) {
      process.stderr.write(`Unknown model "${modelFlag}". Known ids: ${OPENJEV_MODELS.map((m) => m.id).join(", ")}\n`);
      return 1;
    }
    model = found;
  } else if (isInteractive()) {
    const prompter = createPrompter();
    try {
      const choices = OPENJEV_MODELS.map((candidate) => ({
        label: formatModelLine(candidate) + (supportsHardware(candidate, caps) ? "" : "  [not recommended on this machine]"),
        value: candidate.id,
        detail: `${candidate.name} - ${candidate.origin}`,
      }));
      const id = await prompter.choose("Which OpenJev model should run? (you can change it later)", choices);
      model = findModel(id) ?? OPENJEV_MODELS[0]!;
    } finally {
      prompter.close();
    }
  } else {
    model = findModel(DEFAULT_OPENJEV_MODEL)!;
  }

  const plan = buildLaunchPlan(model, caps);
  process.stdout.write(`Model: ${formatModelLine(model)}\n      ${model.origin}\n`);
  process.stdout.write(`Endpoint after start: ${plan.endpoint}\n`);
  if (!plan.supported) {
    process.stdout.write("Warning: this hardware does not match the model's requirements.\n");
  }

  if (!options.argv.includes("--no-write")) {
    const envPath = persistModel(rootDir, model.id, plan.endpoint);
    process.stdout.write(`Saved selection to ${envPath} (OPENJEV_MODEL=${model.id}, NANOJEV_JEV_BACKEND=openjev).\n`);
    process.stdout.write("Change the model any time with `nanojev openjev --model <id>` or `nanojev models`.\n");
  }

  process.stdout.write("\nSteps:\n");
  plan.steps.forEach((step, index) => {
    process.stdout.write(`  ${index + 1}. ${step.description}\n     $ ${step.command}\n`);
  });

  const probe = await probeOpenJev({ baseUrl: plan.endpoint, fetchImpl: options.fetchImpl });
  if (probe.reachable) {
    process.stdout.write(`\nAn OpenJev server is already reachable at ${plan.endpoint} (models: ${probe.models.join(", ") || "none reported"}).\n`);
    if (!execute) {
      process.stdout.write("Nothing to start. Use start.bat to run the bot.\n");
      return 0;
    }
  }

  if (!execute) {
    process.stdout.write("\nDry run. Re-run with `--execute` (or use run-openjev.bat) to actually start it.\n");
    process.stdout.write(`After it is up, set OPENJEV_MODEL=${model.id} in .env and run start.bat.\n`);
    return 0;
  }

  return executeSteps(plan.steps, rootDir);
}

function executeSteps(steps: LaunchStep[], rootDir: string): number {
  for (const step of steps) {
    const cwd = step.cwd ? resolve(rootDir, step.cwd) : rootDir;
    if (step.cwd && !existsSync(cwd) && step.command.startsWith("docker")) {
      process.stderr.write(`Skipping "${step.command}": ${cwd} does not exist (run the clone step first).\n`);
      return 1;
    }
    process.stdout.write(`\n> ${step.command}\n`);
    const result = spawnSync(step.command, {
      cwd,
      shell: true,
      stdio: "inherit",
      env: { ...process.env, ...(step.env ?? {}) },
    });
    if (result.status !== 0) {
      process.stderr.write(`Step failed with exit code ${result.status ?? "unknown"}.\n`);
      return result.status ?? 1;
    }
  }
  return 0;
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const prefixed = argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

export function persistModel(rootDir: string, modelId: string, baseUrl: string): string {
  const envPath = resolve(rootDir, ".env");
  const base = readEnvFile(envPath) ?? ENV_TEMPLATE;
  const updated = upsertEnv(base, {
    NANOJEV_JEV_BACKEND: "openjev",
    OPENJEV_MODEL: modelId,
    OPENJEV_BASE_URL: baseUrl,
    OPENJEV_HOSTED: "false",
  });
  writeFileSync(envPath, updated, "utf8");
  return envPath;
}
