import { describe, expect, it } from "vitest";
import { applyFableOneMillionSuffix } from "./fable-context-suffix.js";

const POOL_ENV = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
  ANTHROPIC_AUTH_TOKEN: "key",
} as NodeJS.ProcessEnv;

describe("applyFableOneMillionSuffix", () => {
  it("suffixes plain fable ids when the spawn env carries API-style auth", () => {
    expect(applyFableOneMillionSuffix("claude-fable-5-1", POOL_ENV)).toBe("claude-fable-5-1[1m]");
    expect(applyFableOneMillionSuffix("claude-fable-5", POOL_ENV)).toBe("claude-fable-5[1m]");
  });

  it("leaves already-suffixed and non-fable ids alone", () => {
    expect(applyFableOneMillionSuffix("claude-fable-5-1[1m]", POOL_ENV)).toBe(
      "claude-fable-5-1[1m]",
    );
    expect(applyFableOneMillionSuffix("claude-opus-5", POOL_ENV)).toBe("claude-opus-5");
    expect(applyFableOneMillionSuffix("claude-sonnet-5[1m]", POOL_ENV)).toBe("claude-sonnet-5[1m]");
  });

  it("leaves the id alone under subscription auth (no API env)", () => {
    expect(applyFableOneMillionSuffix("claude-fable-5-1", {} as NodeJS.ProcessEnv)).toBe(
      "claude-fable-5-1",
    );
  });

  it("passes through empty models", () => {
    expect(applyFableOneMillionSuffix(undefined, POOL_ENV)).toBeUndefined();
  });
});
