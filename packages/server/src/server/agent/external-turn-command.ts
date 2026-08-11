import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "pino";

import { resolvePaseoHome } from "../paseo-home.js";

/**
 * Commands that reach the process running an agent's turns when that process
 * is not this daemon — the provider CLI in a terminal pane.
 *
 * - `interrupt` stops the running turn (the phone's stop button).
 * - `prompt` types a prompt into it (slash commands, which the daemon-side
 *   child would otherwise execute against a session nobody is watching).
 *
 * Both are argv arrays under `daemon.*` in the daemon config file. They are
 * read from that file here rather than threaded from bootstrap through the
 * manager and the provider factory: the only caller is the provider session,
 * and a config key is a seam that survives an upstream merge where four
 * changed function signatures would not.
 */
export type ExternalCommandKind = "interrupt" | "prompt";

const CONFIG_KEY: Record<ExternalCommandKind, string> = {
  interrupt: "externalInterruptCommand",
  prompt: "externalPromptCommand",
};

/**
 * What the spawned command needs to find the external process: the agent it
 * belongs to, the provider session it is running, and the labels that say
 * which terminal session and workspace hold the pane.
 */
export interface ExternalAgentIdentity {
  agentId: string | null;
  sessionId: string | null;
  cwd: string;
  labels: Record<string, string>;
}

/** Argv for one of the external commands, or null when it is not configured. */
export function readExternalTurnCommand(
  kind: ExternalCommandKind,
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(resolvePaseoHome(env), "config.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const daemon = (parsed as { daemon?: Record<string, unknown> } | null)?.daemon;
  const argv = daemon?.[CONFIG_KEY[kind]];
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }
  return argv.every((entry) => typeof entry === "string") ? (argv as string[]) : null;
}

/**
 * Launch one of the external commands, fire and forget. Returns false when it
 * is not configured or could not be spawned — the caller decides whether that
 * is worth surfacing.
 */
export function spawnExternalTurnCommand(params: {
  kind: ExternalCommandKind;
  identity: ExternalAgentIdentity;
  logger: Logger;
  prompt?: string;
}): boolean {
  const { kind, identity, logger, prompt } = params;
  const argv = readExternalTurnCommand(kind);
  if (!argv) {
    return false;
  }
  const [command, ...args] = argv;
  try {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        PASEO_AGENT_ID: identity.agentId ?? "",
        PASEO_AGENT_SESSION_ID: identity.sessionId ?? "",
        PASEO_AGENT_CWD: identity.cwd,
        PASEO_AGENT_LABELS: JSON.stringify(identity.labels),
        ...(prompt === undefined ? {} : { PASEO_PROMPT: prompt }),
      },
      stdio: "ignore",
      detached: false,
    });
    child.on("error", (error) => {
      logger.warn({ err: error, kind, agentId: identity.agentId }, "external command failed");
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        logger.warn({ kind, agentId: identity.agentId, code }, "external command exited non-zero");
      }
    });
  } catch (error) {
    logger.warn(
      { err: error, kind, agentId: identity.agentId },
      "external command failed to spawn",
    );
    return false;
  }
  logger.info({ kind, agentId: identity.agentId }, "external command launched");
  return true;
}
