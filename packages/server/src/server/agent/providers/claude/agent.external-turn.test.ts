import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

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

describe("external turns drive the session's autonomous turn", () => {
  test("a running report opens a turn and an idle report completes it", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("running");
      expect(turnEvents(events)).toEqual(["turn_started"]);
      expect(session.isExternalTurnActive?.()).toBe(true);

      session.noteExternalTurn?.("idle");
      expect(turnEvents(events)).toEqual(["turn_started", "turn_completed"]);
      expect(session.isExternalTurnActive?.()).toBe(false);
    } finally {
      await close();
    }
  });

  test("repeated running reports keep one turn open", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("running");
      session.noteExternalTurn?.("running");
      session.noteExternalTurn?.("running");
      expect(turnEvents(events)).toEqual(["turn_started"]);
    } finally {
      await close();
    }
  });

  test("an idle report with no open turn emits nothing", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("idle");
      expect(turnEvents(events)).toEqual([]);
      expect(session.isExternalTurnActive?.()).toBe(false);
    } finally {
      await close();
    }
  });

  test("tail activity opens a turn for a pane that reports nothing", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("activity");
      expect(turnEvents(events)).toEqual(["turn_started"]);
      expect(session.isExternalTurnActive?.()).toBe(true);
    } finally {
      await close();
    }
  });

  test("tail activity never reopens a turn once the pane reports its own boundaries", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("running");
      session.noteExternalTurn?.("idle");
      // The tailer flushes a turn's last lines seconds after the idle report.
      session.noteExternalTurn?.("activity");
      expect(turnEvents(events)).toEqual(["turn_started", "turn_completed"]);
      expect(session.isExternalTurnActive?.()).toBe(false);
    } finally {
      await close();
    }
  });

  test("superseding drops the turn without reporting it complete", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("running");
      session.noteExternalTurn?.("superseded");
      expect(turnEvents(events)).toEqual(["turn_started"]);
      expect(session.isExternalTurnActive?.()).toBe(false);
    } finally {
      await close();
    }
  });

  test("superseding a turn the daemon owns leaves it alone", async () => {
    const { session, events, close } = await createSession();
    try {
      session.noteExternalTurn?.("superseded");
      expect(turnEvents(events)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("ingesting transcript lines an external process wrote", () => {
  function userLine(text: string, uuid: string): string {
    return JSON.stringify({
      type: "user",
      uuid,
      message: { role: "user", content: text },
    });
  }

  function assistantLine(text: string, uuid: string): string {
    return JSON.stringify({
      type: "assistant",
      uuid,
      message: { role: "assistant", model: "claude-opus-4-6", content: [{ type: "text", text }] },
    });
  }

  function timelineTexts(events: AgentStreamEvent[]): string[] {
    return events.flatMap((event) =>
      event.type === "timeline" && "text" in event.item ? [event.item.text] : [],
    );
  }

  function reportedModel(events: AgentStreamEvent[]): string | null | undefined {
    const changed = events.findLast((event) => event.type === "model_changed");
    return changed?.runtimeInfo.model;
  }

  test("emits the lines as timeline events inside an open external turn", async () => {
    const { session, events, close } = await createSession();
    try {
      session.ingestExternalTranscriptLines?.(
        `${userLine("run the tests", "u1")}\n${assistantLine("running them", "a1")}\n`,
      );

      expect(turnEvents(events)).toEqual(["turn_started"]);
      expect(timelineTexts(events)).toEqual(["run the tests", "running them"]);
      // Every emitted event carries the open turn's id, so the manager can
      // stamp and coalesce them like any other turn's.
      const turnIds = new Set(
        events.map((event) => ("turnId" in event ? event.turnId : undefined)),
      );
      expect(turnIds.size).toBe(1);
      expect([...turnIds][0]).toBeDefined();
    } finally {
      await close();
    }
  });

  test("announces a model the external process switched to", async () => {
    const { session, events, close } = await createSession();
    try {
      session.ingestExternalTranscriptLines?.(`${assistantLine("hello", "a1")}\n`);
      await vi.waitFor(() => {
        expect(reportedModel(events)).toBe("claude-opus-4-6");
      });
    } finally {
      await close();
    }
  });

  test("drops the echo of a prompt the daemon routed outward", async () => {
    paseoHomeForPrompt();
    const { session, events, close } = await createSession();
    try {
      session.noteExternalIdentity?.({ agentId: "agent-9", labels: { origin: "herdr" } });
      await session.tryHandleOutOfBand?.("/compact")?.run({ emit: () => {} });

      session.ingestExternalTranscriptLines?.(
        `${userLine("/compact", "u1")}\n${assistantLine("compacted", "a1")}\n`,
      );
      expect(timelineTexts(events)).toEqual(["compacted"]);

      // Only one echo is owed, so the pane's own second /compact renders.
      session.ingestExternalTranscriptLines?.(`${userLine("/compact", "u2")}\n`);
      expect(timelineTexts(events)).toEqual(["compacted", "/compact"]);
    } finally {
      await close();
      cleanupPromptHome();
    }
  });

  let promptHome: string | null = null;
  const promptHomeOriginal = process.env.PASEO_HOME;

  function paseoHomeForPrompt(): void {
    promptHome = mkdtempSync(join(tmpdir(), "external-ingest-"));
    writeFileSync(
      join(promptHome, "config.json"),
      JSON.stringify({ daemon: { externalPromptCommand: ["/usr/bin/true"] } }),
    );
    process.env.PASEO_HOME = promptHome;
  }

  function cleanupPromptHome(): void {
    if (promptHomeOriginal === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = promptHomeOriginal;
    }
    if (promptHome) {
      rmSync(promptHome, { recursive: true, force: true });
      promptHome = null;
    }
  }
});

describe("interrupting an external turn", () => {
  let paseoHome: string | null = null;
  const originalPaseoHome = process.env.PASEO_HOME;

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    if (paseoHome) {
      rmSync(paseoHome, { recursive: true, force: true });
      paseoHome = null;
    }
  });

  /** A daemon home whose interrupt command records the environment it got. */
  function configureInterruptCommand(): { evidencePath: string } {
    paseoHome = mkdtempSync(join(tmpdir(), "external-interrupt-"));
    const evidencePath = join(paseoHome, "interrupted.txt");
    const scriptPath = join(paseoHome, "interrupt.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nprintf '%s\\n%s\\n' "$PASEO_AGENT_ID" "$PASEO_AGENT_LABELS" > ${JSON.stringify(evidencePath)}\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(paseoHome, "config.json"),
      JSON.stringify({ daemon: { externalInterruptCommand: ["/bin/sh", scriptPath] } }),
    );
    process.env.PASEO_HOME = paseoHome;
    return { evidencePath };
  }

  test("runs the configured command with the agent's identity, with no live query", async () => {
    const { evidencePath } = configureInterruptCommand();
    const { session, close } = await createSession();
    try {
      session.noteExternalIdentity?.({
        agentId: "agent-42",
        labels: { origin: "herdr", "herdr-session": "work" },
      });
      session.noteExternalTurn?.("running");

      await session.interrupt();

      await vi.waitFor(() => {
        const [agentId, labels] = readFileSync(evidencePath, "utf8").split("\n");
        expect(agentId).toBe("agent-42");
        expect(JSON.parse(labels)).toEqual({ origin: "herdr", "herdr-session": "work" });
      });
      // The interrupted turn ends here: the pane never runs its own turn-end
      // hook after a cancel, so nothing else would report it idle.
      expect(session.isExternalTurnActive?.()).toBe(false);
    } finally {
      await close();
    }
  });

  test("leaves the command alone when the open turn is the daemon's own", async () => {
    const { evidencePath } = configureInterruptCommand();
    const { session, close } = await createSession();
    try {
      await session.interrupt();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      expect(() => readFileSync(evidencePath, "utf8")).toThrow();
    } finally {
      await close();
    }
  });
});

describe("out-of-band slash commands for an externally-driven agent", () => {
  let paseoHome: string | null = null;
  const originalPaseoHome = process.env.PASEO_HOME;

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    if (paseoHome) {
      rmSync(paseoHome, { recursive: true, force: true });
      paseoHome = null;
    }
  });

  function configurePromptCommand(options?: { configured?: boolean }): { evidencePath: string } {
    paseoHome = mkdtempSync(join(tmpdir(), "external-prompt-"));
    const evidencePath = join(paseoHome, "delivered.txt");
    const scriptPath = join(paseoHome, "prompt.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\nprintf '%s' "$PASEO_PROMPT" > ${JSON.stringify(evidencePath)}\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(
      join(paseoHome, "config.json"),
      JSON.stringify(
        options?.configured === false
          ? { daemon: {} }
          : { daemon: { externalPromptCommand: ["/bin/sh", scriptPath] } },
      ),
    );
    process.env.PASEO_HOME = paseoHome;
    return { evidencePath };
  }

  function markExternallyDriven(session: AgentSession): void {
    session.noteExternalIdentity?.({ agentId: "agent-7", labels: { origin: "herdr" } });
  }

  test("returns no handler for an agent the daemon runs itself", async () => {
    configurePromptCommand();
    const { session, close } = await createSession();
    try {
      expect(session.tryHandleOutOfBand?.("/model opus")).toBeNull();
    } finally {
      await close();
    }
  });

  test("returns no handler for an ordinary prompt", async () => {
    configurePromptCommand();
    const { session, close } = await createSession();
    try {
      markExternallyDriven(session);
      expect(session.tryHandleOutOfBand?.("ship it")).toBeNull();
    } finally {
      await close();
    }
  });

  test("returns no handler when no delivery command is configured", async () => {
    configurePromptCommand({ configured: false });
    const { session, close } = await createSession();
    try {
      markExternallyDriven(session);
      expect(session.tryHandleOutOfBand?.("/model opus")).toBeNull();
    } finally {
      await close();
    }
  });

  test("delivers the command and emits the user's row when nothing else recorded it", async () => {
    const { evidencePath } = configurePromptCommand();
    const { session, close } = await createSession();
    try {
      markExternallyDriven(session);
      const handler = session.tryHandleOutOfBand?.("/model opus");
      expect(handler).not.toBeNull();

      const emitted: AgentStreamEvent[] = [];
      await handler?.run({ emit: (event) => emitted.push(event) });

      expect(emitted).toEqual([
        {
          type: "timeline",
          provider: "claude",
          item: { type: "user_message", text: "/model opus" },
        },
      ]);
      await vi.waitFor(() => {
        expect(readFileSync(evidencePath, "utf8")).toBe("/model opus");
      });
    } finally {
      await close();
    }
  });

  test("stays silent when the manager already committed the client's message", async () => {
    const { evidencePath } = configurePromptCommand();
    const { session, close } = await createSession();
    try {
      markExternallyDriven(session);
      const handler = session.tryHandleOutOfBand?.("/compact", { clientMessageId: "msg-1" });

      const emitted: AgentStreamEvent[] = [];
      await handler?.run({ emit: (event) => emitted.push(event) });

      expect(emitted).toEqual([]);
      await vi.waitFor(() => {
        expect(readFileSync(evidencePath, "utf8")).toBe("/compact");
      });
    } finally {
      await close();
    }
  });

  test("a reported external turn makes an agent externally driven without the label", async () => {
    configurePromptCommand();
    const { session, close } = await createSession();
    try {
      session.noteExternalTurn?.("running");
      session.noteExternalTurn?.("idle");
      expect(session.tryHandleOutOfBand?.("/model opus")).not.toBeNull();
    } finally {
      await close();
    }
  });
});
