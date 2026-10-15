import { createJevProvider } from "../jev/factory.js";
import { CODIV_BASE_URL, loadConfig, parseHostPort } from "../config.js";
import { useOpenJev } from "../config.js";
import { probeOpenJev } from "../openjev/server.js";
import { TypesafeJevProvider } from "../jev/typesafe-provider.js";

export interface SetupAnswers {
  backend: "typesafe" | "openjev" | "codiv";
  typesafeApiKey?: string;
  typesafeBaseUrl?: string;
  typesafeModel?: string;
  openjevHosted: boolean;
  openjevModel: string;
  openjevApiKey?: string;
  openjevBaseUrl: string;
  minecraft: {
    address: string;
    username: string;
    auth: "offline" | "microsoft";
    version: string;
    target?: string;
  };
}

export function planSetupEnv(answers: SetupAnswers): Record<string, string> {
  const parsed = parseHostPort(answers.minecraft.address);
  const updates: Record<string, string> = {
    NANOJEV_JEV_BACKEND: answers.backend,
    MC_ADDRESS: answers.minecraft.address,
    MC_HOST: parsed.host || "localhost",
    MC_PORT: parsed.port ? String(parsed.port) : "25565",
    MC_USERNAME: answers.minecraft.username,
    MC_AUTH: answers.minecraft.auth,
    MC_VERSION: answers.minecraft.version,
    MC_TARGET: answers.minecraft.target ?? "",
  };

  if (answers.backend === "typesafe") {
    updates.TYPESAFE_API_KEY = answers.typesafeApiKey ?? "";
    updates.TYPESAFE_BASE_URL = answers.typesafeBaseUrl ?? "";
    updates.JEV_MODEL = answers.typesafeModel || "jev-latest";
    updates.OPENJEV_HOSTED = "false";
    return updates;
  }

  updates.JEV_MODEL = "jev-latest";
  updates.OPENJEV_MODEL = answers.openjevModel || "openjev-latest";
  updates.OPENJEV_API_KEY = answers.openjevApiKey ?? "";

  if (answers.backend === "codiv") {
    updates.OPENJEV_HOSTED = "true";
    updates.OPENJEV_BASE_URL = answers.openjevBaseUrl || CODIV_BASE_URL;
  } else {
    updates.OPENJEV_HOSTED = answers.openjevHosted ? "true" : "false";
    updates.OPENJEV_BASE_URL =
      answers.openjevBaseUrl || (answers.openjevHosted ? CODIV_BASE_URL : "http://127.0.0.1:8080");
  }

  return updates;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export async function verifyBackend(
  env: NodeJS.ProcessEnv,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<VerifyResult> {
  let config;
  try {
    config = loadConfig({ env });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  if (useOpenJev(config)) {
    const probe = await probeOpenJev({
      baseUrl: config.openjev.baseUrl,
      apiKey: config.openjev.apiKey,
      fetchImpl: options.fetchImpl,
    });
    if (!probe.reachable) {
      return {
        ok: false,
        detail: `OpenJev at ${config.openjev.baseUrl} is not reachable (${probe.error ?? "no response"}). Start it with run-openjev.bat, or use the hosted endpoint.`,
      };
    }
    const known = probe.models.length === 0 || probe.models.some((id) => id === config.openjev.model);
    return {
      ok: true,
      detail: `OpenJev reachable at ${config.openjev.baseUrl}; models: ${probe.models.join(", ") || "(none reported)"}${known ? "" : `; requested model ${config.openjev.model} was not listed`}`,
    };
  }

  const provider = TypesafeJevProvider.fromConfig(config);
  return {
    ok: provider.configured,
    detail: provider.configured
      ? `TypeSafe Jev configured (${provider.describe()})`
      : "TYPESAFE_API_KEY is empty",
  };
}

export function providerForEnv(env: NodeJS.ProcessEnv) {
  return createJevProvider(loadConfig({ env }));
}
