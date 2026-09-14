import { spawn } from "node:child_process";
import type { AgentSession, AgentSessionConfig } from "./agent-sdk-types.js";
import { readExternalTurnCommand } from "./external-turn-command.js";

interface ExternalPane {
  sessionId: string;
  transcriptPath: string;
  labels: Record<string, string>;
}

export function externalCreationCommand(
  enabled: boolean | undefined,
  provider: string,
): string[] | null {
  return enabled && (provider === "claude" || provider === "codex")
    ? readExternalTurnCommand("create")
    : null;
}

async function command(argv: string[], input: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Native pane creation timed out. Check the session-handoff service."));
    }, 75_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Native pane creation failed: ${stderr.trim() || `exit ${code}`}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Invalid native pane creation response"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function paneResult(value: unknown): ExternalPane {
  const pane = value as Partial<ExternalPane> | null;
  if (
    !pane ||
    typeof pane.sessionId !== "string" ||
    !pane.sessionId ||
    typeof pane.transcriptPath !== "string" ||
    !pane.labels ||
    pane.labels.origin !== "herdr" ||
    !Object.values(pane.labels).every((label) => typeof label === "string")
  ) {
    throw new Error("Native pane creation returned an invalid session identity");
  }
  return pane as ExternalPane;
}

/** The native pane owns every turn, including the first; the daemon registers its mirror. */
export async function registerWithExternalPane<T>(input: {
  argv: string[] | null;
  agentId: string;
  config: AgentSessionConfig;
  workspaceId: string | undefined;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  session: AgentSession;
  register: (labels: Record<string, string> | undefined) => Promise<T>;
  unregister: () => Promise<void>;
}): Promise<T> {
  if (!input.argv) return input.register(input.labels);
  if (!input.session.bindExternalSession) {
    throw new Error(`Provider ${input.config.provider} cannot bind a native pane`);
  }
  let registered = false;
  try {
    const pane = paneResult(
      await command(input.argv, {
        operation: "start",
        agentId: input.agentId,
        config: input.config,
        workspaceId: input.workspaceId,
        labels: input.labels,
        env: input.env,
      }),
    );
    input.session.bindExternalSession(pane);
    const agent = await input.register(pane.labels);
    registered = true;
    await command(input.argv, { operation: "commit", agentId: input.agentId });
    return agent;
  } catch (error) {
    await command(input.argv, { operation: "rollback", agentId: input.agentId }).catch(() => {});
    if (registered) await input.unregister();
    else await input.session.close();
    throw error;
  }
}
