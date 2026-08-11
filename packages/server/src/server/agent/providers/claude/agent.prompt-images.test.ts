import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentPromptInput, AgentSession } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

/** A query that accepts input and never produces a message. */
function createIdleQueryMock(): Query {
  return {
    next: vi.fn(() => new Promise<never>(() => {})),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const PNG = Buffer.from("pretend png").toString("base64");
const JPEG = Buffer.from("pretend jpeg").toString("base64");

/**
 * A phone's image attachments exist only as base64 inside the daemon, so a
 * UserPromptSubmit hook that routes the turn to another process has no way to
 * hand them over. Each turn's images are written to disk with a manifest the
 * hook reads and appends to the routed prompt.
 */
describe("persisting a turn's prompt images", () => {
  let paseoHome: string;
  const originalPaseoHome = process.env.PASEO_HOME;

  beforeEach(() => {
    paseoHome = mkdtempSync(join(tmpdir(), "prompt-images-"));
    process.env.PASEO_HOME = paseoHome;
  });

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    rmSync(paseoHome, { recursive: true, force: true });
  });

  async function createSession(): Promise<AgentSession> {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: () => createIdleQueryMock(),
      resolveBinary: async () => "/test/claude/bin",
    });
    return await client.createSession(
      { provider: "claude", cwd: process.cwd() },
      {
        agentId: AGENT_ID,
      },
    );
  }

  /** startTurn refuses a second turn while one is open; the SDK child never
   * answers here, so each turn is ended explicitly. */
  async function runTurn(session: AgentSession, prompt: AgentPromptInput): Promise<void> {
    await session.startTurn(prompt);
    await session.interrupt();
  }

  function imageDir(): string {
    return join(paseoHome, "prompt-images", AGENT_ID);
  }

  function manifest(): { ts: number; paths: string[] } {
    return JSON.parse(readFileSync(join(imageDir(), "manifest.json"), "utf8"));
  }

  test("writes each image and a manifest naming them", async () => {
    const session = await createSession();
    try {
      await runTurn(session, [
        { type: "text", text: "what is wrong here" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: JPEG, mimeType: "image/jpeg" },
      ]);

      const written = manifest();
      expect(written.paths).toHaveLength(2);
      expect(written.paths[0].endsWith(".png")).toBe(true);
      expect(written.paths[1].endsWith(".jpeg")).toBe(true);
      expect(readFileSync(written.paths[0], "utf8")).toBe("pretend png");
      expect(readFileSync(written.paths[1], "utf8")).toBe("pretend jpeg");
      expect(written.ts).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test("keeps only the newest turn's images, so a stale manifest cannot be read", async () => {
    const session = await createSession();
    try {
      await runTurn(session, [
        { type: "text", text: "first" },
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ]);
      const stale = manifest().paths;

      await runTurn(session, [
        { type: "text", text: "second" },
        { type: "image", data: JPEG, mimeType: "image/jpeg" },
      ]);

      const fresh = manifest();
      expect(fresh.paths).toHaveLength(1);
      expect(readdirSync(imageDir()).sort()).toEqual(
        [fresh.paths[0].split("/").at(-1), "manifest.json"].sort(),
      );
      for (const path of stale) {
        expect(() => readFileSync(path, "utf8")).toThrow();
      }
    } finally {
      await session.close();
    }
  });

  test("writes nothing for a prompt that carries no images", async () => {
    const session = await createSession();
    try {
      await runTurn(session, "just text");
      await runTurn(session, [{ type: "text", text: "still just text" }]);

      expect(() => readdirSync(imageDir())).toThrow();
    } finally {
      await session.close();
    }
  });
});
