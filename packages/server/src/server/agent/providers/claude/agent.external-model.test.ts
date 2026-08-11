import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

function createIdleQueryMock(): Query {
  return {
    next: vi.fn(async () => ({ done: true, value: undefined })),
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

async function createSession(model?: string): Promise<AgentSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => createIdleQueryMock(),
    resolveBinary: async () => "/test/claude/bin",
  });
  return await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    ...(model ? { model } : {}),
  });
}

function assistantLine(model: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a-${model}`,
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
  });
}

function modelCommandLine(args: string): string {
  return JSON.stringify({
    type: "user",
    uuid: `u-${args}`,
    message: {
      role: "user",
      content: `<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>${args}</command-args>`,
    },
  });
}

/**
 * The pane's model is read out of its transcript: a /model switch there never
 * touches the daemon-side session, so without this the client's selector shows
 * whatever the agent was launched with until the next full reload.
 */
describe("mirroring the external process's model", () => {
  test("adopts the model stamped on an assistant entry", async () => {
    const session = await createSession("claude-sonnet-4-6");
    try {
      session.ingestExternalTranscriptLines?.(`${assistantLine("claude-opus-4-6")}\n`);

      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("claude-opus-4-6");
      expect(info.extra?.runtimeModel).toBe("claude-opus-4-6");
    } finally {
      await session.close();
    }
  });

  test("adopts a /model switch the pane ran, which stamps no assistant entry yet", async () => {
    const session = await createSession("claude-sonnet-4-6");
    try {
      session.ingestExternalTranscriptLines?.(`${modelCommandLine("claude-opus-4-6")}\n`);

      expect((await session.getRuntimeInfo()).model).toBe("claude-opus-4-6");
    } finally {
      await session.close();
    }
  });

  test("ignores a /model run with no argument", async () => {
    const session = await createSession("claude-sonnet-4-6");
    try {
      session.ingestExternalTranscriptLines?.(`${modelCommandLine("  ")}\n`);

      // Nothing observed yet: the launch config is not evidence of what the
      // pane is running, only a transcript stamp is.
      expect((await session.getRuntimeInfo()).model).toBeNull();
    } finally {
      await session.close();
    }
  });

  test("does not downgrade a long-context variant to its bare spelling", async () => {
    const session = await createSession();
    try {
      // Selecting the 1m-context variant, then an assistant entry that stamps
      // the same model without the suffix — the SDK drops it.
      session.noteExternalModelSwitch?.("claude-sonnet-4-6[1m]");
      expect((await session.getRuntimeInfo()).model).toBe("claude-sonnet-4-6[1m]");

      session.ingestExternalTranscriptLines?.(`${assistantLine("claude-sonnet-4-6")}\n`);

      expect((await session.getRuntimeInfo()).model).toBe("claude-sonnet-4-6[1m]");
    } finally {
      await session.close();
    }
  });

  test("still follows a real switch away from a long-context variant", async () => {
    const session = await createSession();
    try {
      session.noteExternalModelSwitch?.("claude-sonnet-4-6[1m]");
      session.ingestExternalTranscriptLines?.(`${assistantLine("claude-opus-4-6")}\n`);

      expect((await session.getRuntimeInfo()).model).toBe("claude-opus-4-6");
    } finally {
      await session.close();
    }
  });

  test("leaves the model alone for lines that carry no model evidence", async () => {
    const session = await createSession("claude-sonnet-4-6");
    try {
      session.ingestExternalTranscriptLines?.(
        `${JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } })}\n`,
      );

      expect((await session.getRuntimeInfo()).model).toBeNull();
    } finally {
      await session.close();
    }
  });
});
