import { describe, expect, it } from "vitest";
import { ConfigError, assertRunnable, getConfigStatus, isDev, loadConfig, parseHostPort } from "../src/config.js";

describe("parseHostPort", () => {
  it("parses host:port, [ipv6]:port, bare host and bare IPv6", () => {
    expect(parseHostPort("play.example.net:25617")).toEqual({ host: "play.example.net", port: 25617 });
    expect(parseHostPort("play.example.net")).toEqual({ host: "play.example.net" });
    expect(parseHostPort("[::1]:25565")).toEqual({ host: "::1", port: 25565 });
    expect(parseHostPort("::1")).toEqual({ host: "::1" });
    expect(parseHostPort("")).toEqual({ host: "" });
  });
});

describe("run mode", () => {
  it("defaults to production", () => {
    const config = loadConfig({ env: {} });
    expect(config.mode).toBe("production");
    expect(isDev(config)).toBe(false);
  });

  it("reads development from NANOJEV_MODE", () => {
    const config = loadConfig({ env: { NANOJEV_MODE: "development" } });
    expect(config.mode).toBe("development");
    expect(isDev(config)).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig({ env: { NANOJEV_MODE: "staging" } })).toThrow(ConfigError);
  });
});

describe("server address configuration", () => {
  it("accepts a full address in MC_ADDRESS", () => {
    const config = loadConfig({ env: { MC_ADDRESS: "play.example.net:25617" } });
    expect(config.minecraft.host).toBe("play.example.net");
    expect(config.minecraft.port).toBe(25617);
  });

  it("parses host:port out of MC_HOST and overrides MC_PORT", () => {
    const config = loadConfig({ env: { MC_HOST: "play.example.net:25617", MC_PORT: "25565" } });
    expect(config.minecraft.host).toBe("play.example.net");
    expect(config.minecraft.port).toBe(25617);
  });

  it("keeps MC_PORT when the address has no port", () => {
    const config = loadConfig({ env: { MC_ADDRESS: "play.example.net", MC_PORT: "1234" } });
    expect(config.minecraft.host).toBe("play.example.net");
    expect(config.minecraft.port).toBe(1234);
  });

  it("defaults the port when neither address nor MC_PORT provides one", () => {
    const config = loadConfig({ env: { MC_HOST: "play.example.net" } });
    expect(config.minecraft.port).toBe(25565);
  });
});

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({ env: {} });
    expect(config.minecraft.host).toBe("localhost");
    expect(config.minecraft.port).toBe(25565);
    expect(config.minecraft.username).toBe("NanoJev");
    expect(config.minecraft.auth).toBe("offline");
    expect(config.minecraft.version).toBe("auto");
    expect(config.target.mode).toBe("nearest");
    expect(config.jev.model).toBe("jev-latest");
    expect(config.combat.loopHz).toBe(20);
    expect(config.logLevel).toBe("info");
  });

  it("parses numbers and booleans from strings", () => {
    const config = loadConfig({
      env: {
        MC_PORT: "25566",
        MC_RECONNECT: "false",
        MC_TARGET_RANGE: "48",
        NANOJEV_LOOP_HZ: "30",
        MC_AUTH: "microsoft",
        MC_USERNAME: "Bot",
      },
    });
    expect(config.minecraft.port).toBe(25566);
    expect(config.minecraft.reconnect.enabled).toBe(false);
    expect(config.target.range).toBe(48);
    expect(config.combat.loopHz).toBe(30);
    expect(config.minecraft.auth).toBe("microsoft");
  });

  it("selects explicit mode automatically when a target username is set", () => {
    const config = loadConfig({ env: { MC_TARGET: "Steve" } });
    expect(config.target.mode).toBe("explicit");
    expect(config.target.username).toBe("Steve");
  });

  it("rejects explicit mode without a target username", () => {
    expect(() => loadConfig({ env: { MC_TARGET_MODE: "explicit" } })).toThrow(ConfigError);
  });

  it("rejects non-numeric ports", () => {
    expect(() => loadConfig({ env: { MC_PORT: "not-a-port" } })).toThrow(ConfigError);
  });

  it("rejects out-of-range loop rates", () => {
    expect(() => loadConfig({ env: { NANOJEV_LOOP_HZ: "500" } })).toThrow(ConfigError);
  });

  it("collects all issues into one error", () => {
    try {
      loadConfig({ env: { MC_PORT: "x", NANOJEV_LOOP_HZ: "y" } });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("bounds the hitselect hold to 1-3 ticks", () => {
    expect(() => loadConfig({ env: { NANOJEV_HITSELECT_TICKS: "5" } })).toThrow(ConfigError);
    expect(loadConfig({ env: { NANOJEV_HITSELECT_TICKS: "3" } }).combat.hitselectTicks).toBe(3);
  });
});

describe("Jev configuration status", () => {
  it("reports Jev as unconfigured without an API key", () => {
    const config = loadConfig({ env: {} });
    const status = getConfigStatus(config);
    expect(status.jevConfigured).toBe(false);
    expect(status.warnings.length).toBeGreaterThan(0);
    expect(() => assertRunnable(config)).toThrow(ConfigError);
  });

  it("passes validation with an API key", () => {
    const config = loadConfig({ env: { TYPESAFE_API_KEY: "test-key" } });
    const status = assertRunnable(config);
    expect(status.jevConfigured).toBe(true);
  });
});
