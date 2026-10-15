import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createJevProvider, describeProvider } from "../src/jev/factory.js";

describe("createJevProvider", () => {
  it("creates the TypeSafe provider by default", () => {
    const config = loadConfig({ env: { TYPESAFE_API_KEY: "sk-typesafe" } });
    const provider = createJevProvider(config);
    expect(provider.name).toBe("typesafe");
    expect(provider.describe()).toContain("api.typesafe.ai");
  });

  it("creates a local OpenJev provider without requiring a key", () => {
    const config = loadConfig({ env: { NANOJEV_JEV_BACKEND: "openjev", OPENJEV_MODEL: "clef-flash-1.0" } });
    const provider = createJevProvider(config);
    expect(provider.name).toBe("openjev");
    expect(provider.configured).toBe(true);
    expect(provider.describe()).toContain("clef-flash-1.0");
    expect(provider.describe()).toContain("http://127.0.0.1:8080");
  });

  it("creates a Codiv provider pointed at api.codiv.ai", () => {
    const config = loadConfig({ env: { NANOJEV_JEV_BACKEND: "codiv", OPENJEV_API_KEY: "sk-codiv-abc" } });
    const provider = createJevProvider(config);
    const description = describeProvider(config);
    expect(provider.name).toBe("codiv");
    expect(description.backend).toBe("codiv");
    expect(description.baseUrl).toBe("https://api.codiv.ai");
    expect(description.hosted).toBe(true);
  });

  it("defaults the Codiv base URL and hosted flag from the backend", () => {
    const config = loadConfig({ env: { NANOJEV_JEV_BACKEND: "codiv", OPENJEV_API_KEY: "sk-codiv-abc" } });
    expect(config.openjev.baseUrl).toBe("https://api.codiv.ai");
    expect(config.openjev.hosted).toBe(true);
  });

  it("honors an explicit OpenJev base URL for a local server", () => {
    const config = loadConfig({
      env: { NANOJEV_JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://192.168.1.10:9000" },
    });
    const description = describeProvider(config);
    expect(description.baseUrl).toBe("http://192.168.1.10:9000");
    expect(description.hosted).toBe(false);
  });
});
