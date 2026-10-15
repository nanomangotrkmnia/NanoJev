import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_OPENJEV_MODEL,
  OPENJEV_MODELS,
  findModel,
  formatHostedModelLine,
  formatModelLine,
  supportsHardware,
} from "../openjev/catalog.js";
import { describeHardware, detectHardware, probeOpenJev } from "../openjev/server.js";
import { ENV_TEMPLATE, readEnvFile, upsertEnv } from "./env-file.js";
import { createPrompter, isInteractive } from "./prompt.js";
import { planSetupEnv } from "./setup-lib.js";

export interface SetupOptions {
  envPath?: string;
  force?: boolean;
  fetchImpl?: typeof fetch;
}

export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const envPath = resolve(options.envPath ?? ".env");
  const existing = readEnvFile(envPath);

  if (!isInteractive()) {
    process.stderr.write(
      "No interactive console detected. Copy .env.example to .env and fill it in, or run `nanojev setup` from a terminal.\n",
    );
    return 1;
  }

  const prompter = createPrompter();
  try {
    const caps = detectHardware();
    process.stdout.write(`\nNanoJev setup\nDetected hardware: ${describeHardware(caps)}\n\n`);

    if (existing && !options.force) {
      const overwrite = await prompter.confirm(".env already exists. Reconfigure it?", true);
      if (!overwrite) {
        process.stdout.write("Keeping the existing .env.\n");
        return 0;
      }
    }

    const backend = await prompter.choose<"typesafe" | "openjev" | "codiv">(
      "Which decision backend should NanoJev use?",
      [
        {
          label: "TypeSafe Jev API (hosted cloud)",
          value: "typesafe",
          detail: "Needs a TYPESAFE_API_KEY from https://console.typesafe.ai. No local hardware required.",
        },
        {
          label: "Codiv (hosted OpenJev, api.codiv.ai)",
          value: "codiv",
          detail: "Free tier (100M input tokens). Needs an sk-codiv-... key from https://codiv.ai. No local hardware.",
        },
        {
          label: "Local OpenJev server (run the open model yourself)",
          value: "openjev",
          detail: "Docker/GPU or CPU via run-openjev.bat. Default endpoint http://127.0.0.1:8080.",
        },
      ],
    );

    let answers;
    if (backend === "typesafe") {
      const apiKey = await prompter.ask("Paste your TYPESAFE_API_KEY");
      const model = await prompter.ask("Jev model", "jev-latest");
      answers = planSetupEnv({
        backend: "typesafe",
        typesafeApiKey: apiKey,
        typesafeModel: model,
        openjevHosted: false,
        openjevModel: DEFAULT_OPENJEV_MODEL,
        openjevBaseUrl: "http://127.0.0.1:8080",
        minecraft: await promptMinecraft(prompter),
      });
    } else if (backend === "codiv") {
      const apiKey = await prompter.ask("Paste your Codiv API key (sk-codiv-...)");
      const modelId = await chooseHostedModel(
        prompter,
        "Choose the OpenJev model to use on Codiv (hosted; no local hardware needed)",
      );
      answers = planSetupEnv({
        backend: "codiv",
        openjevHosted: true,
        openjevBaseUrl: "https://api.codiv.ai",
        openjevModel: modelId,
        openjevApiKey: apiKey,
        minecraft: await promptMinecraft(prompter),
      });
      const probe = await probeOpenJev({ baseUrl: "https://api.codiv.ai", apiKey, fetchImpl: options.fetchImpl });
      process.stdout.write(
        probe.reachable
          ? `  Codiv reachable; models: ${probe.models.join(", ") || "(none reported)"}\n`
          : `  Codiv not reachable yet (${probe.error}). Check the key and network.\n`,
      );
    } else {
      const baseUrl = await prompter.ask("OpenJev base URL", "http://127.0.0.1:8080");
      const modelId = await chooseOpenJevModel(prompter, caps, "Choose an OpenJev model");

      const probe = await probeOpenJev({ baseUrl, fetchImpl: options.fetchImpl });
      if (probe.reachable) {
        process.stdout.write(`  OpenJev is already running; models: ${probe.models.join(", ") || "(none reported)"}\n`);
      } else {
        process.stdout.write(`  OpenJev not reachable yet at ${baseUrl} (${probe.error}). Start it with run-openjev.bat.\n`);
      }

      answers = planSetupEnv({
        backend: "openjev",
        openjevHosted: false,
        openjevBaseUrl: baseUrl,
        openjevModel: modelId,
        minecraft: await promptMinecraft(prompter),
      });
    }

    const chosen =
      answers.NANOJEV_JEV_BACKEND === "openjev" || answers.NANOJEV_JEV_BACKEND === "codiv"
        ? findModel(answers.OPENJEV_MODEL ?? "")
        : undefined;
    if (chosen) process.stdout.write(`  Selected ${formatModelLine(chosen)}\n`);

    const base = existing ?? ENV_TEMPLATE;
    const updated = upsertEnv(base, answers);
    writeFileSync(envPath, updated, "utf8");
    process.stdout.write(`\nWrote ${envPath}\n`);

    process.stdout.write(
      backend === "openjev"
        ? "Next: run run-openjev.bat to start the local model, then start.bat.\n"
        : "Next: run start.bat to connect the bot.\n",
    );
    return 0;
  } finally {
    prompter.close();
  }
}

async function chooseOpenJevModel(
  prompter: ReturnType<typeof createPrompter>,
  caps: ReturnType<typeof detectHardware>,
  question: string,
): Promise<string> {
  const modelChoices = OPENJEV_MODELS.map((model) => ({
    label: formatModelLine(model) + (supportsHardware(model, caps) ? "" : "  [not recommended on this machine]"),
    value: model.id,
    detail: `${model.name} - ${model.origin}`,
  }));
  return prompter.choose(question + " (change it later in .env)", modelChoices);
}

/**
 * Model picker for a hosted OpenJev (Codiv): lists the available OpenJev models without the
 * local hardware / ease-of-run framing, which only applies when you run the server yourself.
 */
async function chooseHostedModel(prompter: ReturnType<typeof createPrompter>, question: string): Promise<string> {
  const modelChoices = OPENJEV_MODELS.map((model) => ({
    label: formatHostedModelLine(model),
    value: model.id,
    detail: `${model.origin} | size ${model.size}; ${model.input}; up to ${model.maxChoices} choices`,
  }));
  return prompter.choose(question + " (change it later in .env)", modelChoices);
}

async function promptMinecraft(prompter: ReturnType<typeof createPrompter>) {
  process.stdout.write("\nMinecraft connection\n");
  const address = await prompter.ask("Server address (host or host:port, e.g. play.example.net:25617)", "localhost:25565");
  const username = await prompter.ask("Bot username", "NanoJev");
  const auth = await prompter.choose<"offline" | "microsoft">("Authentication", [
    { label: "offline", value: "offline", detail: "Cracked/offline servers (no Microsoft account)." },
    { label: "microsoft", value: "microsoft", detail: "Premium accounts; uses the device-code sign-in flow." },
  ]);
  const version = await prompter.ask("Minecraft version (auto or a tested version like 1.21.4)", "auto");
  const target = await prompter.ask("Target username (blank = nearest eligible player)", "");
  return { address, username, auth, version, target: target || undefined };
}
