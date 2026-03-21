import { describe, it, expect, afterEach } from "bun:test";
import { loadConfig } from "../../lib/config";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("throws if AZURE_STORAGE_CONNECTION_STRING is missing", () => {
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    expect(() => loadConfig()).toThrow("AZURE_STORAGE_CONNECTION_STRING is required");
  });

  it("returns frozen config with defaults", () => {
    const config = loadConfig();
    expect(config.env).toBe("local"); // Set by tests/setup.ts preload
    expect(typeof config.port).toBe("number");
    expect(config.queueName).toBe("conversions");
    expect(config.containerInputs).toBe("inputs");
    expect(config.containerOutputs).toBe("outputs");
    expect(config.containerJobs).toBe("jobs");
    expect(config.containerLogs).toBe("logs");
    expect(config.conversionTimeoutMs).toBe(1_800_000);
    expect(config.maxFileSizeMb).toBe(500);
    expect(config.maxQueuedJobs).toBe(20);
    expect(config.idleShutdownMs).toBe(900_000);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("computes queue visibility timeout from conversion timeout", () => {
    process.env.CONVERSION_TIMEOUT_MS = "600000"; // 10 min
    const config = loadConfig();
    // Should be 600 + 300 = 900 seconds
    expect(config.queueVisibilityTimeoutSec).toBe(900);
  });

  it("respects explicit queue visibility timeout", () => {
    process.env.QUEUE_VISIBILITY_TIMEOUT_SEC = "1200";
    const config = loadConfig();
    expect(config.queueVisibilityTimeoutSec).toBe(1200);
  });

  it("rejects invalid BIM_ENV", () => {
    process.env.BIM_ENV = "staging";
    expect(() => loadConfig()).toThrow("Invalid BIM_ENV");
  });
});
