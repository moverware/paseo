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

  noteExternalTurn(state: ExternalTurnState): void {
    if (state === "running" || state === "activity") {
      if (this.externalTurnId) {
        return;
      }
      this.externalTurnId = `external-${++this.turnCounter}`;
      this.emit({ type: "turn_started", provider: this.provider });
      return;
    }
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

  async startTurn(prompt: unknown): Promise<{ turnId: string }> {
    this.startedPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const turnId = `foreground-${++this.turnCounter}`;
    setTimeout(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      this.emit({ type: "turn_completed", provider: this.provider, turnId });
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
    expect(result.outOfBand).toBe(false);
    expect(fixture.session.startedPrompts).toEqual(["from the phone"]);
    expect(fixture.session.isExternalTurnActive()).toBe(false);
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
