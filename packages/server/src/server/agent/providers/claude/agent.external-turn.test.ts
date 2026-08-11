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
