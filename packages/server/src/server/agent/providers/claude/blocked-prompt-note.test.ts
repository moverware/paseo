import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { extractBlockedPromptNote } from "./blocked-prompt-note.js";

function blockedSystemLine(content: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "informational",
    content,
    level: "warning",
    uuid: "s1",
  });
}

const GUARD_BLOCK =
  "UserPromptSubmit operation blocked by hook:\n" +
  "[/Users/mover/hooks/session-watermark.py check]: Session continued in another client (last write there at 11:56).\n" +
  "This window's context is stale; submitting would fork the conversation.\n\n\n" +
  "Original prompt: Hello?";

describe("extractBlockedPromptNote", () => {
  test("surfaces a freshness-guard block with hook paths stripped", () => {
    const note = extractBlockedPromptNote(blockedSystemLine(GUARD_BLOCK));
    expect(note).toContain("blocked in the pane");
    expect(note).toContain("Session continued in another client");
    expect(note).toContain("Original prompt: Hello?");
    expect(note).not.toContain("session-watermark.py");
  });

  test("ignores routed refusals — the ⤳ marker renders through the result path", () => {
    const routed =
      "UserPromptSubmit operation blocked by hook:\n" +
      "[/Users/mover/hooks/session-watermark.py check]: Session continued in another client.\n" +
      "[/Users/mover/hooks/route-phone-message.py]: ⤳ interrupted the running turn\n\n\n" +
      "Original prompt: hi";
    expect(extractBlockedPromptNote(blockedSystemLine(routed))).toBeNull();
  });

  test("ignores non-system lines that merely mention the phrase", () => {
    const assistant = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "UserPromptSubmit operation blocked by hook:\nfoo" }],
      },
    });
    expect(extractBlockedPromptNote(assistant)).toBeNull();
  });

  test("ignores unparseable and unrelated lines", () => {
    expect(extractBlockedPromptNote("not json blocked by hook")).toBeNull();
    expect(extractBlockedPromptNote(blockedSystemLine("PostToolUse note"))).toBeNull();
    expect(extractBlockedPromptNote("")).toBeNull();
  });
});

/** A query that never yields — nothing here runs a turn through the SDK. */
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

async function createSession(): Promise<{
  session: AgentSession;
  events: AgentStreamEvent[];
  close: () => Promise<void>;
}> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => createIdleQueryMock(),
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, events, close: () => session.close() };
}

function turnEvents(events: AgentStreamEvent[]): string[] {
  return events.map((event) => event.type).filter((type) => type.startsWith("turn_"));
}

function timelineTexts(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && "text" in event.item ? [event.item.text] : [],
  );
}

describe("tailed blocked prompts reach the timeline", () => {
  test("a bare block batch emits the note and closes the activity turn", async () => {
    const { session, events, close } = await createSession();
    try {
      session.ingestExternalTranscriptLines?.(`${blockedSystemLine(GUARD_BLOCK)}\n`);

      const texts = timelineTexts(events);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("blocked in the pane");
      expect(texts[0]).toContain("Original prompt: Hello?");
      // Nothing will ever report idle for a refused submission; the turn the
      // tail activity opened must not read running until the quiescence sweep.
      expect(turnEvents(events)).toEqual(["turn_started", "turn_completed"]);
      expect(session.isExternalTurnActive?.()).toBe(false);
    } finally {
      await close();
    }
  });

  test("a block sharing its batch with real turn lines leaves the turn open", async () => {
    const { session, events, close } = await createSession();
    try {
      const user = JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "Hello?" },
      });
      session.ingestExternalTranscriptLines?.(`${blockedSystemLine(GUARD_BLOCK)}\n${user}\n`);

      expect(timelineTexts(events)).toEqual([
        "Hello?",
        expect.stringContaining("blocked in the pane"),
      ]);
      expect(turnEvents(events)).toEqual(["turn_started"]);
      expect(session.isExternalTurnActive?.()).toBe(true);
    } finally {
      await close();
    }
  });
});
