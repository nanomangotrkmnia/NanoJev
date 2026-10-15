import { describe, expect, it } from "vitest";
import { CODIV_BASE_URL } from "../src/config.js";
import { DEFAULT_SETTINGS, parseEnvText, setBackend, settingsFromContent } from "../src/cli/settings.js";

describe("parseEnvText", () => {
  it("reads KEY=value lines and ignores comments and blanks", () => {
    const parsed = parseEnvText(
      ["# a comment", "", "MC_HOST=play.example.net", "  MC_PORT = 25617  ", "NANOJEV_LOG_LEVEL=debug", "not a setting"].join(
        "\n",
      ),
    );
    expect(parsed.MC_HOST).toBe("play.example.net");
    expect(parsed.MC_PORT).toBe("25617");
    expect(parsed.NANOJEV_LOG_LEVEL).toBe("debug");
    expect(Object.keys(parsed)).toHaveLength(3);
  });
});

describe("settingsFromContent", () => {
  it("starts from defaults and overlays the file", () => {
    const settings = settingsFromContent("MC_USERNAME=Alex\nNANOJEV_LOOP_HZ=30\n");
    expect(settings.MC_USERNAME).toBe("Alex");
    expect(settings.NANOJEV_LOOP_HZ).toBe("30");
    expect(settings.MC_AUTH).toBe(DEFAULT_SETTINGS.MC_AUTH);
  });

  it("returns pure defaults for a missing file", () => {
    expect(settingsFromContent(null).OPENJEV_MODEL).toBe("openjev-latest");
  });
});

describe("setBackend", () => {
  it("sets Codiv as hosted and points the URL at api.codiv.ai", () => {
    const next = setBackend({ ...DEFAULT_SETTINGS }, "codiv");
    expect(next.NANOJEV_JEV_BACKEND).toBe("codiv");
    expect(next.OPENJEV_HOSTED).toBe("true");
    expect(next.OPENJEV_BASE_URL).toBe(CODIV_BASE_URL);
  });

  it("keeps a custom OpenJev URL when switching to codiv", () => {
    const next = setBackend({ ...DEFAULT_SETTINGS, OPENJEV_BASE_URL: "http://192.168.1.10:9000" }, "codiv");
    expect(next.OPENJEV_BASE_URL).toBe("http://192.168.1.10:9000");
  });

  it("sets local OpenJev as not hosted", () => {
    const next = setBackend({ ...DEFAULT_SETTINGS, OPENJEV_BASE_URL: "" }, "openjev");
    expect(next.OPENJEV_HOSTED).toBe("false");
    expect(next.OPENJEV_BASE_URL).toBe("http://127.0.0.1:8080");
  });

  it("only changes the backend for typesafe", () => {
    const next = setBackend({ ...DEFAULT_SETTINGS }, "typesafe");
    expect(next.NANOJEV_JEV_BACKEND).toBe("typesafe");
    expect(next.OPENJEV_HOSTED).toBe(DEFAULT_SETTINGS.OPENJEV_HOSTED);
  });
});
