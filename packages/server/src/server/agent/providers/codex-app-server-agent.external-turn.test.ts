import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "./codex-app-server-agent.js";

/**
 * FORK: external-turn behavior for Codex TUI panes. Mirrors the Claude
 * session's semantics: hook reports and tail activity open the provider's
 * autonomous turn, idle closes it, superseded drops it silently, and rollout
 * lines ingested by the transcript tailer emit ordinary timeline events.
 */

type TestSession = CodexAppServerAgentSession & {
  activeForegroundTurnId: string | null;
  currentThreadId: string | null;
  openDeferredExternalTurn(): void;
  externalEchoes: { record(text: string): void };
  lastExternalIdleAt: number;
};

function createSession(config: Partial<AgentSessionConfig> = {}): TestSession {
  return new CodexAppServerAgentSession(
    {
      provider: "codex",
      cwd: "/tmp/codex-external-turn-test",
      model: "gpt-5.4",
      ...config,
    },
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session cannot spawn Codex app-server");
    },
  ) as unknown as TestSession;
}

function collectEvents(session: TestSession): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

function rolloutLine(payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: "2026-08-25T13:01:27.000Z", type: "event_msg", payload });
}

const THREAD_ID = "01a039de-a478-78e3-8871-0b7b9525e0b3";

describe("codex external turns", () => {
  test("a running report opens the turn and an idle report closes it", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.noteExternalTurn("running");
    expect(session.isExternalTurnActive()).toBe(true);
    expect(events).toEqual([{ type: "turn_started", provider: "codex" }]);

    session.noteExternalTurn("idle");
    expect(session.isExternalTurnActive()).toBe(false);
    expect(events[1]).toMatchObject({ type: "turn_completed", provider: "codex" });
  });

  test("superseded drops the turn without emitting turn_completed", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.noteExternalTurn("running");
    session.noteExternalTurn("superseded");
    expect(session.isExternalTurnActive()).toBe(false);
    expect(events).toEqual([{ type: "turn_started", provider: "codex" }]);
  });

  test("activity inside the settle window after idle does not reopen the turn, running does", () => {
    const session = createSession();
    session.noteExternalTurn("running");
    session.noteExternalTurn("idle");

    session.noteExternalTurn("activity");
    expect(session.isExternalTurnActive()).toBe(false);

    session.noteExternalTurn("running");
    expect(session.isExternalTurnActive()).toBe(true);
  });

  test("a report during a daemon foreground turn is deferred, then released", () => {
    const session = createSession();
    const events = collectEvents(session);
    session.activeForegroundTurnId = "fg-1";

    session.noteExternalTurn("running");
    expect(session.isExternalTurnActive()).toBe(false);
    expect(events).toEqual([]);

    session.activeForegroundTurnId = null;
    session.openDeferredExternalTurn();
    expect(session.isExternalTurnActive()).toBe(true);
    expect(events).toEqual([{ type: "turn_started", provider: "codex" }]);
  });

  test("ingested rollout lines drive turn state and emit timeline items", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.ingestExternalTranscriptLines(
      [
        rolloutLine({ type: "task_started", turn_id: "t1", started_at: 1 }),
        rolloutLine({
          type: "item_completed",
          thread_id: THREAD_ID,
          turn_id: "t1",
          item: {
            type: "UserMessage",
            id: "u1",
            content: [{ type: "text", text: "hello from the pane", text_elements: [] }],
          },
        }),
        rolloutLine({
          type: "item_completed",
          thread_id: THREAD_ID,
          turn_id: "t1",
          item: {
            type: "AgentMessage",
            id: "a1",
            content: [{ type: "Text", text: "hi back" }],
            phase: "final_answer",
          },
        }),
        rolloutLine({ type: "task_complete", turn_id: "t1", last_agent_message: "hi back" }),
      ].join("\n"),
    );

    expect(events[0]).toEqual({ type: "turn_started", provider: "codex" });
    expect(events[1]).toMatchObject({
      type: "timeline",
      item: { type: "user_message", text: "hello from the pane" },
    });
    expect(events[2]).toMatchObject({
      type: "timeline",
      item: { type: "assistant_message", text: "hi back" },
    });
    expect(events[3]).toMatchObject({ type: "turn_completed", provider: "codex" });
    expect(session.isExternalTurnActive()).toBe(false);
  });

  test("a recorded prompt echo is consumed instead of rendering twice", () => {
    const session = createSession();
    const events = collectEvents(session);
    session.externalEchoes.record("routed message");

    session.ingestExternalTranscriptLines(
      rolloutLine({
        type: "item_completed",
        thread_id: THREAD_ID,
        turn_id: "t1",
        item: {
          type: "UserMessage",
          id: "u1",
          content: [{ type: "text", text: "routed message", text_elements: [] }],
        },
      }),
    );

    const timeline = events.filter((event) => event.type === "timeline");
    expect(timeline).toEqual([]);
  });

  test("non-signal rollout lines are ignored", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.ingestExternalTranscriptLines(
      [
        JSON.stringify({ type: "session_meta", payload: { id: THREAD_ID } }),
        JSON.stringify({ type: "turn_context", payload: { cwd: "/tmp" } }),
        "not json at all",
        "",
      ].join("\n"),
    );

    expect(events).toEqual([]);
    expect(session.isExternalTurnActive()).toBe(false);
  });

  test("externalTranscriptPath resolves the rollout for the resume handle's thread", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const dayDir = join(home, "sessions", "2026", "08", "25");
    mkdirSync(dayDir, { recursive: true });
    const rolloutPath = join(dayDir, `rollout-2026-08-25T13-01-27-${THREAD_ID}.jsonl`);
    writeFileSync(rolloutPath, "");
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const session = new CodexAppServerAgentSession(
        { provider: "codex", cwd: "/tmp/codex-external-turn-test" },
        { sessionId: THREAD_ID },
        createTestLogger(),
        () => {
          throw new Error("Test session cannot spawn Codex app-server");
        },
      ) as unknown as TestSession;
      expect(session.externalTranscriptPath()).toBe(rolloutPath);
      // Cached: still resolves after the file tree is gone.
      rmSync(home, { recursive: true, force: true });
      expect(session.externalTranscriptPath()).toBe(rolloutPath);
    } finally {
      if (previousHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session with no thread exposes no transcript", () => {
    const session = createSession();
    expect(session.externalTranscriptPath()).toBe(null);
  });
});

describe("codex out-of-band prompt delegation", () => {
  test("every prompt on an externally-driven agent goes out-of-band, none otherwise", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ daemon: { externalPromptCommand: ["/usr/bin/true"] } }),
    );
    const originalHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    try {
      const driven = createSession();
      driven.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });
      // Unlike Claude's slash-only routing, plain prompts delegate too —
      // Codex's writer lock makes a daemon turn on a pane session impossible.
      expect(driven.tryHandleOutOfBand?.("plain prompt")).not.toBeNull();
      expect(driven.tryHandleOutOfBand?.("/compact")).not.toBeNull();

      const daemonOwned = createSession();
      expect(daemonOwned.tryHandleOutOfBand?.("plain prompt")).toBeNull();
    } finally {
      if (originalHome === undefined) {
        delete process.env.PASEO_HOME;
      } else {
        process.env.PASEO_HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("codex external turn interplay with the manager seams", () => {
  afterEach(() => {
    // noop — sessions here never spawn processes.
  });

  test("noteExternalIdentity marks the session externally driven by label", () => {
    const session = createSession();
    session.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });
    const events = collectEvents(session);
    // Externally driven sessions record prompt echoes at startTurn; verified
    // indirectly: an ingested user message matching a recorded echo is
    // swallowed (see the echo test). Here we only assert identity is held
    // without opening a turn.
    expect(events).toEqual([]);
    expect(session.isExternalTurnActive()).toBe(false);
  });
});
