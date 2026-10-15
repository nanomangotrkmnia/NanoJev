import { describe, expect, it } from "vitest";
import { ENV_TEMPLATE, upsertEnv } from "../src/cli/env-file.js";

describe("upsertEnv", () => {
  it("replaces existing keys and preserves comments", () => {
    const updated = upsertEnv(ENV_TEMPLATE, { TYPESAFE_API_KEY: "abc123", MC_HOST: "play.example.net" });
    expect(updated).toContain("TYPESAFE_API_KEY=abc123");
    expect(updated).toContain("MC_HOST=play.example.net");
    expect(updated).toContain("# ---- Minecraft connection ----");
    expect(updated).not.toContain("TYPESAFE_API_KEY=\n");
  });

  it("appends keys that are not present yet", () => {
    const updated = upsertEnv("MC_HOST=localhost\n", { OPENJEV_MODEL: "clef-flash-1.0" });
    expect(updated).toContain("MC_HOST=localhost");
    expect(updated).toContain("OPENJEV_MODEL=clef-flash-1.0");
  });

  it("only replaces the first occurrence of a key", () => {
    const updated = upsertEnv("A=1\nA=1\n", { A: "2" });
    expect(updated.split("\n").filter((line) => line === "A=2")).toHaveLength(1);
    expect(updated).toContain("A=1");
  });
});
