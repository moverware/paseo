import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { toAgentPayload } from "./agent-projections.js";
import { startAgentRun } from "./agent-prompt.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ExternalTurnState,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

/**
 * The autonomous-turn half of a provider session, modelled the way
 * ClaudeAgentSession implements it: an external report opens the same turn a
 * provider-driven one would, and the manager sees only turn_started /
 * turn_completed.
 */
class ExternalTurnSession implements AgentSession {
  readonly provider: AgentProvider = "claude";
  readonly capabilities = CAPABILITIES;
  readonly sessionId = randomUUID();
  readonly startedPrompts: string[] = [];
  interruptCount = 0;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private externalTurnId: string | null = null;
  private turnCounter = 0;

  constructor(private readonly config: AgentSessionConfig) {}

  /** When set, startTurn opens the foreground turn but leaves it to
   * `finishForegroundTurn` to end — models a routed turn whose hook block
   * lands after the pane has reported its own turn. */
  holdForegroundTurn = false;
  private activeForegroundTurnId: string | null = null;
  private deferredExternalTurn = false;

  noteExternalTurn(state: ExternalTurnState): void {
    if (state === "running" || state === "activity") {
      if (this.externalTurnId) {
        return;
      }
      if (this.activeForegroundTurnId) {
        // ClaudeAgentSession defers a report that arrives mid daemon turn and
        // opens the external turn once the daemon turn finalizes.
        this.deferredExternalTurn = true;
        return;
      }
      this.externalTurnId = `external-${++this.turnCounter}`;
      this.emit({ type: "turn_started", provider: this.provider });
      return;
    }
    this.deferredExternalTurn = false;
    if (!this.externalTurnId) {
      return;
    }
    this.externalTurnId = null;
    if (state === "idle") {
      this.emit({ type: "turn_completed", provider: this.provider });
    }
  }

  isExternalTurnActive(): boolean {
    return this.externalTurnId !== null;
  }

  expectsExternalContinuation(): boolean {
    return this.deferredExternalTurn;
  }

  finishForegroundTurn(): void {
    const turnId = this.activeForegroundTurnId;
    if (!turnId) return;
    this.activeForegroundTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
    if (this.deferredExternalTurn) {
      this.deferredExternalTurn = false;
      this.noteExternalTurn("running");
    }
  }

  async startTurn(prompt: unknown): Promise<{ turnId: string }> {
    this.startedPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const turnId = `foreground-${++this.turnCounter}`;
    this.activeForegroundTurnId = turnId;
    setTimeout(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      if (!this.holdForegroundTurn) {
        this.finishForegroundTurn();
      }
    }, 0);
    return { turnId };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async run() {
    return { sessionId: this.sessionId, finalText: "", timeline: [] };
  }

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.config.model ?? null,
      modeId: null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.sessionId };
  }

  async close(): Promise<void> {}

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

class ExternalTurnClient implements AgentClient {
  readonly provider: AgentProvider = "claude";
  readonly capabilities = CAPABILITIES;
  session: ExternalTurnSession | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.session = new ExternalTurnSession(config);
    return this.session;
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return await this.createSession({
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
    });
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

interface Fixture {
  manager: AgentManager;
  client: ExternalTurnClient;
  agentId: string;
  session: ExternalTurnSession;
  status(): string;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const workdir = mkdtempSync(join(tmpdir(), "external-turn-"));
  const client = new ExternalTurnClient();
  const manager = new AgentManager({
    clients: { claude: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    rescueTimeouts: { interruptSessionMs: 50 },
  });
  const agent = await manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
    workspaceId: undefined,
    labels: { origin: "herdr" },
  });
  const session = client.session;
  if (!session) {
    throw new Error("session was not created");
  }
  return {
    manager,
    client,
    agentId: agent.id,
    session,
    status() {
      const snapshot = manager.getAgent(agent.id);
      if (!snapshot) {
        throw new Error("agent disappeared");
      }
      return toAgentPayload(snapshot).status;
    },
    async cleanup() {
      await manager.closeAgent(agent.id);
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

describe("external turns in the agent manager", () => {
  let fixture: Fixture | null = null;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = null;
  });

  test("a running report marks the agent running, an idle report clears it", async () => {
    fixture = await createFixture();
    expect(fixture.status()).toBe("idle");

    fixture.manager.reportExternalTurn(fixture.agentId, "running");
    await settle();
    expect(fixture.status()).toBe("running");
    expect(fixture.manager.hasInFlightRun(fixture.agentId)).toBe(true);

    fixture.manager.reportExternalTurn(fixture.agentId, "idle");
    await settle();
    expect(fixture.status()).toBe("idle");
    expect(fixture.manager.hasInFlightRun(fixture.agentId)).toBe(false);
  });

  test("a prompt sent mid external turn runs a daemon turn without interrupting the pane", async () => {
    fixture = await createFixture();
    fixture.manager.reportExternalTurn(fixture.agentId, "running");
    await settle();
    expect(fixture.manager.hasInFlightRun(fixture.agentId)).toBe(true);

    const result = await startAgentRun(fixture.manager, fixture.agentId, "from the phone", logger, {
      replaceRunning: true,
    });
    await settle();

    // The external process's own prompt hook is what interrupts the pane while
    // it delivers this prompt; a daemon-side interrupt would race its keystrokes.
    expect(fixture.session.interruptCount).toBe(0);
    expect(result.disposition).toBe("turn_started");
    expect(fixture.session.startedPrompts).toEqual(["from the phone"]);
    expect(fixture.session.isExternalTurnActive()).toBe(false);
  });

  test("a routed turn hands off to the pane's turn without an idle frame in between", async () => {
    // Interrupt-mode phone message into a live pane: the daemon turn is
    // refused by the prompt hook and typed into the pane, whose own prompt
    // hook reports running BEFORE the daemon turn's hook block lands. The
    // phone must never see idle across that boundary — it reads idle as the
    // queue being released and re-sends the message it just delivered
    // (measured 2026-09-05: every interrupt-mode message arrived twice).
    fixture = await createFixture();
    const statuses: string[] = [];
    let recording = false;
    const unsubscribe = fixture.manager.subscribe((event) => {
      if (recording && event.type === "agent_state" && event.agent.id === fixture!.agentId) {
        statuses.push(toAgentPayload(event.agent).status);
      }
    });
    try {
      fixture.session.holdForegroundTurn = true;
      const result = await startAgentRun(
        fixture.manager,
        fixture.agentId,
        "from the phone",
        logger,
      );
      expect(result.disposition).toBe("turn_started");
      await settle();
      expect(fixture.status()).toBe("running");
      recording = true;

      // The pane accepted the routed prompt and reported its turn.
      fixture.manager.reportExternalTurn(fixture.agentId, "running");
      await settle();
      // Now the daemon turn's hook block lands.
      fixture.session.finishForegroundTurn();
      await settle();

      expect(fixture.session.isExternalTurnActive()).toBe(true);
      expect(fixture.status()).toBe("running");
      expect(statuses).not.toContain("idle");

      fixture.manager.reportExternalTurn(fixture.agentId, "idle");
      await settle();
      expect(fixture.status()).toBe("idle");
    } finally {
      unsubscribe();
    }
  });

  test("releasing an external turn frees the run slot without interrupting the pane", async () => {
    // The refresh path: the app blindly interrupts any running turn before
    // rehydrating an agent. For an external turn the session releases it
    // first, so the interrupt gate (hasInFlightRun) finds nothing to cancel
    // and no Esc reaches the pane.
    fixture = await createFixture();
    fixture.manager.reportExternalTurn(fixture.agentId, "running");
    await settle();
    expect(fixture.manager.hasInFlightRun(fixture.agentId)).toBe(true);

    expect(fixture.manager.releaseExternalTurn(fixture.agentId)).toBe(true);
    expect(fixture.manager.hasInFlightRun(fixture.agentId)).toBe(false);
    expect(fixture.session.interruptCount).toBe(0);
    expect(fixture.session.isExternalTurnActive()).toBe(false);
    expect(fixture.status()).toBe("idle");

    // With no external turn open the release is a no-op, and a genuine stop
    // still reaches the session.
    expect(fixture.manager.releaseExternalTurn(fixture.agentId)).toBe(false);
  });

  test("a prompt sent while no external turn runs still starts a daemon turn", async () => {
    fixture = await createFixture();

    await startAgentRun(fixture.manager, fixture.agentId, "no turn open", logger, {
      replaceRunning: true,
    });
    await settle();

    expect(fixture.session.interruptCount).toBe(0);
    expect(fixture.session.startedPrompts).toEqual(["no turn open"]);
  });
});
