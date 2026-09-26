import { describe, expect, it } from "vitest";
import {
  applyPoolContextSuffix,
  applyPoolContextSuffixToModelCommand,
} from "./pool-context-suffix.js";

const POOL_ENV = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
  ANTHROPIC_AUTH_TOKEN: "key",
} as NodeJS.ProcessEnv;

const DIRECT_ENV = {} as NodeJS.ProcessEnv;

describe("applyPoolContextSuffix", () => {
  it("suffixes plain 1M-context model ids when the spawn env carries API-style auth", () => {
    expect(applyPoolContextSuffix("claude-fable-5-1", POOL_ENV)).toBe("claude-fable-5-1[1m]");
    expect(applyPoolContextSuffix("claude-fable-5", POOL_ENV)).toBe("claude-fable-5[1m]");
    expect(applyPoolContextSuffix("claude-opus-5-5", POOL_ENV)).toBe("claude-opus-5-5[1m]");
    expect(applyPoolContextSuffix("claude-opus-5", POOL_ENV)).toBe("claude-opus-5[1m]");
  });

  it("leaves already-suffixed ids alone", () => {
    expect(applyPoolContextSuffix("claude-fable-5-1[1m]", POOL_ENV)).toBe("claude-fable-5-1[1m]");
    expect(applyPoolContextSuffix("claude-sonnet-5[1m]", POOL_ENV)).toBe("claude-sonnet-5[1m]");
  });

  it("leaves 200k models, aliases and unknown ids alone", () => {
    expect(applyPoolContextSuffix("claude-opus-4-8", POOL_ENV)).toBe("claude-opus-4-8");
    expect(applyPoolContextSuffix("claude-sonnet-5", POOL_ENV)).toBe("claude-sonnet-5");
    expect(applyPoolContextSuffix("opus", POOL_ENV)).toBe("opus");
    expect(applyPoolContextSuffix("glm-4.6", POOL_ENV)).toBe("glm-4.6");
  });

  it("leaves the id alone under subscription auth (no API env)", () => {
    expect(applyPoolContextSuffix("claude-fable-5-1", DIRECT_ENV)).toBe("claude-fable-5-1");
    expect(applyPoolContextSuffix("claude-opus-5-5", DIRECT_ENV)).toBe("claude-opus-5-5");
  });

  it("passes through empty models", () => {
    expect(applyPoolContextSuffix(undefined, POOL_ENV)).toBeUndefined();
  });
});

describe("applyPoolContextSuffixToModelCommand", () => {
  it("suffixes the id of a /model command under pool auth", () => {
    expect(applyPoolContextSuffixToModelCommand("/model claude-opus-5-5", POOL_ENV)).toBe(
      "/model claude-opus-5-5[1m]",
    );
    expect(applyPoolContextSuffixToModelCommand("/model  claude-fable-5-1 ", POOL_ENV)).toBe(
      "/model  claude-fable-5-1[1m] ",
    );
  });

  it("leaves other commands, bare /model and non-1M ids unchanged", () => {
    expect(applyPoolContextSuffixToModelCommand("/model opus", POOL_ENV)).toBe("/model opus");
    expect(applyPoolContextSuffixToModelCommand("/model", POOL_ENV)).toBe("/model");
    expect(applyPoolContextSuffixToModelCommand("/compact", POOL_ENV)).toBe("/compact");
    expect(applyPoolContextSuffixToModelCommand("/model claude-opus-5-5", DIRECT_ENV)).toBe(
      "/model claude-opus-5-5",
    );
  });
});
