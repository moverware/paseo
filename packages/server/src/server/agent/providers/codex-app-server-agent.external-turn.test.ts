import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

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

  test("a capacity failure ends the external turn and remains failed after the idle hook", () => {
    const session = createSession();
    const events = collectEvents(session);
    const message = "Selected model is at capacity. Please try a different model.";

    session.ingestExternalTranscriptLines(
      [
        rolloutLine({ type: "task_started", turn_id: "failed-turn" }),
        rolloutLine({
          type: "task_complete",
          turn_id: "failed-turn",
          last_agent_message: null,
          error: { message, codex_error_info: "server_overloaded" },
        }),
      ].join("\n"),
    );
    session.noteExternalTurn("idle");
    session.noteExternalTurn("activity");

    expect(session.isExternalTurnActive()).toBe(false);
    expect(events).toEqual([
      { type: "turn_started", provider: "codex" },
      { type: "turn_failed", provider: "codex", error: message },
    ]);

    session.ingestExternalTranscriptLines(
      [
        rolloutLine({ type: "task_started", turn_id: "retry-turn" }),
        rolloutLine({ type: "task_complete", turn_id: "retry-turn", error: null }),
      ].join("\n"),
    );
    expect(events.slice(2)).toEqual([
      { type: "turn_started", provider: "codex" },
      { type: "turn_completed", provider: "codex", usage: undefined },
    ]);
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

  test("a question the pane parked in its drawer becomes a question card", () => {
    const session = createSession();
    const events = collectEvents(session);
    session.ingestExternalTranscriptLines(
      `${rolloutLine({
        type: "item_completed",
        thread_id: THREAD_ID,
        turn_id: "t1",
        item: {
          type: "AgentMessage",
          id: "call_q1",
          phase: "final_answer",
          delivery: "async",
          content: [{ type: "Text", text: "Which tab should swipe-back apply to?" }],
          questions: [
            { title: "Which tab should swipe-back apply to?", options: ["Outfits", "Closet"] },
          ],
        },
      })}\n`,
    );
    const requested = events.find((event) => event.type === "permission_requested");
    expect(requested).toBeDefined();
    expect(requested?.type === "permission_requested" && requested.request).toMatchObject({
      id: "permission-call_q1",
      kind: "question",
      name: "request_user_input_async",
    });
    expect(session.getPendingPermissions().map((request) => request.id)).toEqual([
      "permission-call_q1",
    ]);
    const timeline = events.filter((event) => event.type === "timeline");
    expect(timeline.at(-1)?.type === "timeline" && timeline.at(-1)?.item).toMatchObject({
      type: "tool_call",
      name: "request_user_input_async",
    });
  });

  test("answering a pane question types the answer into the drawer instead of steering", async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const out = join(home, "env.txt");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        daemon: { externalPromptCommand: ["/bin/sh", "-c", `env > "${out}"`] },
      }),
    );
    const originalHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    try {
      const session = createSession();
      session.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });
      const events = collectEvents(session);
      session.ingestExternalTranscriptLines(
        `${rolloutLine({
          type: "item_completed",
          thread_id: THREAD_ID,
          turn_id: "t1",
          item: {
            type: "AgentMessage",
            id: "call_q2",
            delivery: "async",
            content: [{ type: "Text", text: "Unlock the console?" }],
            questions: [{ title: "Unlock the console?", options: null }],
          },
        })}\n`,
      );
      const result = await session.respondToPermission("permission-call_q2", {
        behavior: "allow",
        updatedInput: { answers: { "Question 1": "Done, it is unlocked" } },
      });
      expect(result).toBeUndefined();
      const deadline = Date.now() + 5000;
      while (!existsSync(out) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const env = readFileSync(out, "utf8");
      expect(env).toContain("PASEO_QUESTION=answer");
      expect(env).toContain("Done, it is unlocked");
      expect(events.some((event) => event.type === "permission_resolved")).toBe(true);
      expect(session.getPendingPermissions()).toEqual([]);
    } finally {
      if (originalHome === undefined) {
        delete process.env.PASEO_HOME;
      } else {
        process.env.PASEO_HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
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

  test("an unknown native transcript stays pending through restoration until the first prompt writes it", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-pending-transcript-"));
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const session = createSession();
    try {
      session.bindExternalSession({ sessionId: THREAD_ID, transcriptPath: "" });
      expect(session.externalTranscriptPath()).toBeNull();
      expect(session.externalTranscriptPending()).toBe(true);
      await session.connect();
      expect((await session.getRuntimeInfo()).sessionId).toBe(THREAD_ID);
      const handle = session.describePersistence();
      expect(handle).toMatchObject({
        sessionId: THREAD_ID,
        metadata: { externalTranscriptPath: "" },
      });
      const restored = new CodexAppServerAgentSession(
        { provider: "codex", cwd: home, model: "gpt-5.4" },
        handle,
        createTestLogger(),
        () => {
          throw new Error("Pending native transcript must not start a daemon writer");
        },
        {},
        false,
        false,
        false,
        "agent-1",
        "history",
      );
      try {
        await restored.connect();
        expect((await restored.getRuntimeInfo()).sessionId).toBe(THREAD_ID);
        expect(restored.externalTranscriptPending()).toBe(true);
        expect(restored.describePersistence()?.metadata.externalTranscriptPath).toBe("");
        const history: AgentStreamEvent[] = [];
        for await (const event of restored.streamHistory()) history.push(event);
        expect(history).toEqual([]);

        const dayDir = join(home, "sessions", "2026", "09", "14");
        mkdirSync(dayDir, { recursive: true });
        const rolloutPath = join(dayDir, `rollout-2026-09-14T00-00-00-${THREAD_ID}.jsonl`);
        writeFileSync(rolloutPath, rolloutLine({ type: "task_started" }));
        expect(restored.externalTranscriptPath()).toBe(rolloutPath);
        expect(restored.externalTranscriptPending()).toBe(false);
        expect(restored.describePersistence()?.metadata.externalTranscriptPath).toBe(rolloutPath);
        expect(session.externalTranscriptPath()).toBe(rolloutPath);
        expect(session.externalTranscriptPending()).toBe(false);
      } finally {
        await restored.close();
      }
    } finally {
      await session.close();
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session with no thread exposes no transcript", () => {
    const session = createSession();
    expect(session.externalTranscriptPath()).toBe(null);
  });
});

describe("codex out-of-band prompt delegation", () => {
  test("binds a blank native session and delegates its initial prompt without a writer", async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-native-codex-"));
    const evidencePath = join(home, "prompt.txt");
    const scriptPath = join(home, "prompt.sh");
    const transcriptPath = join(home, "not-created-yet.jsonl");
    writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s' "$PASEO_PROMPT" > "${evidencePath}"\n`);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        daemon: { externalPromptCommand: ["/bin/sh", scriptPath] },
      }),
    );
    const originalHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    const session = createSession();
    try {
      session.bindExternalSession({ sessionId: THREAD_ID, transcriptPath });
      expect(session.id).toBe(THREAD_ID);
      expect(session.externalTranscriptPath()).toBe(transcriptPath);
      expect(session.describePersistence()).toMatchObject({
        sessionId: THREAD_ID,
        metadata: { externalTranscriptPath: transcriptPath },
      });
      expect((await session.getRuntimeInfo()).sessionId).toBe(THREAD_ID);
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory()) history.push(event);
      expect(history).toEqual([]);
      session.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });
      const handler = session.tryHandleOutOfBand("compare these models");
      expect(handler).not.toBeNull();
      await handler?.run({ emit: () => {} });
      await vi.waitFor(() =>
        expect(readFileSync(evidencePath, "utf8")).toBe("compare these models"),
      );
      expect(session.isExternalTurnActive()).toBe(false);

      const restored = new CodexAppServerAgentSession(
        { provider: "codex", cwd: home, model: "gpt-5.4" },
        session.describePersistence(),
        createTestLogger(),
        () => {
          throw new Error("Blank native mirror must not spawn app-server");
        },
        {},
        false,
        false,
        false,
        "agent-1",
        "history",
      );
      await restored.connect();
      expect(restored.externalTranscriptPath()).toBe(transcriptPath);
      expect((await restored.getRuntimeInfo()).sessionId).toBe(THREAD_ID);
      await restored.close();
    } finally {
      await session.close();
      if (originalHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

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

describe("external prompt delivery env", () => {
  test("the sender's active-turn choice rides along as PASEO_ACTIVE_TURN", async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
    const out = join(home, "env.txt");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        daemon: { externalPromptCommand: ["/bin/sh", "-c", `env > "${out}"`] },
      }),
    );
    const originalHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    try {
      const driven = createSession();
      driven.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });
      const handler = driven.tryHandleOutOfBand?.("stop and look", {
        activeTurnBehavior: "interrupt",
      });
      expect(handler).not.toBeNull();
      await handler?.run({ emit: () => {} });
      const deadline = Date.now() + 5000;
      while (!existsSync(out) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const env = readFileSync(out, "utf8");
      expect(env).toContain("PASEO_ACTIVE_TURN=interrupt");
      expect(env).toContain("PASEO_PROMPT=stop and look");
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

describe("a pane compacting its context", () => {
  function compactionMarkers(events: AgentStreamEvent[]): string[] {
    return events.flatMap((event) =>
      event.type === "timeline" && event.item.type === "compaction" ? [event.item.status] : [],
    );
  }

  test("a compacting report opens the turn and posts one loading marker", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.noteExternalTurn("compacting");
    session.noteExternalTurn("compacting");

    expect(session.isExternalTurnActive()).toBe(true);
    expect(events).toEqual([
      { type: "turn_started", provider: "codex" },
      { type: "timeline", provider: "codex", item: { type: "compaction", status: "loading" } },
    ]);
  });

  test("the rollout's compacted record completes the marker only when one is open", () => {
    const session = createSession();
    const events = collectEvents(session);
    const compacted = JSON.stringify({
      timestamp: "2026-09-23T23:47:42.255Z",
      type: "compacted",
      payload: { message: "summary", replacement_history: [], window_number: 2 },
    });

    // A compaction the phone never saw start renders nothing, as for a
    // daemon-run session.
    session.noteExternalTurn("running");
    session.ingestExternalTranscriptLines(`${compacted}\n`);
    expect(compactionMarkers(events)).toEqual([]);

    session.noteExternalTurn("compacting");
    session.ingestExternalTranscriptLines(`${compacted}\n`);
    expect(compactionMarkers(events)).toEqual(["loading", "completed"]);

    session.noteExternalTurn("compacting");
    expect(compactionMarkers(events)).toEqual(["loading", "completed", "loading"]);
  });

  test("the marker closes with the turn", () => {
    const session = createSession();
    const events = collectEvents(session);

    session.noteExternalTurn("compacting");
    session.noteExternalTurn("idle");
    session.noteExternalTurn("compacting");

    expect(compactionMarkers(events)).toEqual(["loading", "loading"]);
  });
});

/**
 * FORK: the pane runs its own reasoning effort. Each turn's `turn_context`
 * line records it; without reading that, the client shows the configured
 * level (usually none, so "auto") instead of what the pane runs.
 */
describe("codex external effort", () => {
  function turnContextLine(effort: string): string {
    return JSON.stringify({
      timestamp: "2026-09-26T19:00:00.000Z",
      type: "turn_context",
      payload: { turn_id: "t1", model: "gpt-6-astra", effort },
    });
  }

  function createPaneSession(): TestSession {
    const session = createSession();
    session.bindExternalSession({ sessionId: THREAD_ID, transcriptPath: "" });
    session.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });
    return session;
  }

  test("a tailed turn_context reports its effort once", async () => {
    const session = createPaneSession();
    const events = collectEvents(session);

    session.ingestExternalTranscriptLines(`${turnContextLine("high")}\n`);
    session.ingestExternalTranscriptLines(`${turnContextLine("high")}\n`);

    expect(events).toEqual([
      { type: "thinking_option_changed", provider: "codex", thinkingOptionId: "high" },
    ]);
    expect((await session.getRuntimeInfo()).thinkingOptionId).toBe("high");
  });

  test("a reloaded pane reports the latest turn's effort already on disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-effort-"));
    try {
      const transcriptPath = join(home, `rollout-${THREAD_ID}.jsonl`);
      // Big enough that the backward read crosses a chunk boundary.
      const filler = rolloutLine({ type: "token_count", pad: "x".repeat(300_000) });
      writeFileSync(
        transcriptPath,
        [turnContextLine("low"), filler, turnContextLine("xhigh"), filler, ""].join("\n"),
      );
      const session = createSession();
      session.bindExternalSession({ sessionId: THREAD_ID, transcriptPath });
      session.noteExternalIdentity({ agentId: "agent-1", labels: { origin: "herdr" } });

      expect((await session.getRuntimeInfo()).thinkingOptionId).toBe("xhigh");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an effort change for a pane is refused with a notice, not applied", async () => {
    const session = createPaneSession();
    session.ingestExternalTranscriptLines(`${turnContextLine("high")}\n`);

    const notice = await session.setThinkingOption("low");

    expect(notice).toMatchObject({ type: "warning" });
    expect((await session.getRuntimeInfo()).thinkingOptionId).toBe("high");
  });
});
