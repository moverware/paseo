import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { followClaudeContinuations, readClaudeContinuation } from "./continuation.js";

describe("Claude transcript continuation", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function transcript(name: string, lines: object[]): string {
    dir ??= mkdtempSync(join(tmpdir(), "claude-continuation-"));
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return path;
  }

  test("reads the successor named by the transcript's continued-in row", () => {
    const path = transcript("root", [
      { type: "user", session_id: "root", message: { role: "user", content: "hi" } },
      { type: "continued-in", sessionId: "root", continuedInSessionId: "child" },
    ]);
    expect(readClaudeContinuation(path)).toBe("child");
  });

  test("a transcript without a continuation is the live end", () => {
    const path = transcript("root", [
      { type: "user", session_id: "root", message: { role: "user", content: "hi" } },
      { type: "assistant", session_id: "root", message: { role: "assistant", content: [] } },
    ]);
    expect(readClaudeContinuation(path)).toBeNull();
    expect(readClaudeContinuation(join(dir!, "missing.jsonl"))).toBeNull();
  });

  test("follows a chain of continuations and stops on a cycle", () => {
    const paths = new Map<string, string>();
    paths.set(
      "root",
      transcript("root", [{ type: "continued-in", continuedInSessionId: "middle" }]),
    );
    paths.set(
      "middle",
      transcript("middle", [{ type: "continued-in", continuedInSessionId: "leaf" }]),
    );
    paths.set("leaf", transcript("leaf", [{ type: "user", session_id: "leaf" }]));
    const resolve = (sessionId: string) => paths.get(sessionId) ?? null;
    expect(followClaudeContinuations("root", resolve)).toBe("leaf");
    expect(followClaudeContinuations("leaf", resolve)).toBe("leaf");

    paths.set("leaf", transcript("leaf", [{ type: "continued-in", continuedInSessionId: "root" }]));
    expect(followClaudeContinuations("root", resolve)).toBe("leaf");
  });
});
