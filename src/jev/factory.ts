import { CODIV_BASE_URL, useOpenJev, type Config } from "../config.js";
import { TypesafeJevProvider } from "./typesafe-provider.js";
import type { JevProvider } from "./provider.js";

export const LOCAL_OPENJEV_PLACEHOLDER_KEY = "openjev-local";

export interface ProviderDescription {
  backend: "typesafe" | "openjev" | "codiv";
  label: string;
  model: string;
  baseUrl: string;
  hosted: boolean;
}

export function describeProvider(config: Config): ProviderDescription {
  if (config.jev.backend === "codiv") {
    return {
      backend: "codiv",
      label: "codiv",
      model: config.openjev.model,
      baseUrl: config.openjev.baseUrl || CODIV_BASE_URL,
      hosted: true,
    };
  }
  if (useOpenJev(config)) {
    return {
      backend: "openjev",
      label: "openjev",
      model: config.openjev.model,
      baseUrl: config.openjev.baseUrl,
      hosted: config.openjev.hosted,
    };
  }
  return {
    backend: "typesafe",
    label: "typesafe",
    model: config.jev.model,
    baseUrl: config.jev.baseUrl ?? "https://api.typesafe.ai",
    hosted: true,
  };
}

/**
 * Builds the live Jev decision provider.
 *
 * TypeSafe Jev, a local OpenJev server, and Codiv all speak the same `/v1/systemone` wire API,
 * so the same official `@typesafe-ai/sdk` client serves every backend; only the base URL, API
 * key, and model differ.
 */
export function createJevProvider(config: Config): JevProvider {
  if (config.jev.backend === "codiv") {
    return new TypesafeJevProvider({
      apiKey: config.openjev.apiKey ?? "",
      baseUrl: config.openjev.baseUrl || CODIV_BASE_URL,
      model: config.openjev.model,
      timeoutMs: config.jev.timeoutMs,
      maxRetries: config.jev.maxRetries,
      label: "codiv",
    });
  }

  if (useOpenJev(config)) {
    return new TypesafeJevProvider({
      apiKey: config.openjev.apiKey ?? LOCAL_OPENJEV_PLACEHOLDER_KEY,
      baseUrl: config.openjev.baseUrl,
      model: config.openjev.model,
      timeoutMs: config.jev.timeoutMs,
      maxRetries: config.jev.maxRetries,
      label: "openjev",
    });
  }

  return TypesafeJevProvider.fromConfig(config);
}
