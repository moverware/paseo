import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "pino";

import { resolvePaseoHome } from "../paseo-home.js";
import type { AgentProviderNotice } from "./agent-sdk-types.js";

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
export type ExternalCommandKind = "interrupt" | "prompt" | "create";

/**
 * Value of the `origin` label that marks an agent whose turns are run by an
 * external process. The deployment stamps it when it imports the session, and
 * it is the only evidence available for a pane that has been idle since the
 * daemon started and so has reported no turns yet.
 */
export const EXTERNAL_ORIGIN_LABEL = "herdr";

/**
 * Timeline text for a prompt the external command could not deliver: nothing
 * reached the pane, so the message is not in the conversation and the sender
 * should send it again once the pane is reachable.
 */
export const EXTERNAL_DELIVERY_FAILED =
  "[System Error] This message did not reach the terminal session that runs this " +
  "conversation. Check that its pane is open and send it again.";

/** Reply to an effort change for a Codex pane: the Codex TUI has no command
 * that sets effort from typed text, so the level stays whatever the pane runs. */
export const EXTERNAL_CODEX_EFFORT_NOTICE: AgentProviderNotice = {
  type: "warning",
  message: "Change effort in the terminal pane with /model; Codex takes no effort command.",
};

/** Exit code the external prompt command returns when asked to answer a
 * question the terminal pane is no longer holding: it was answered or
 * skipped there, so the client's copy of the question is stale. */
export const EXTERNAL_QUESTION_GONE_EXIT_CODE = 3;

export const EXTERNAL_QUESTION_ALREADY_RESOLVED =
  "This question was already answered or skipped in the terminal pane.";

const CONFIG_KEY: Record<ExternalCommandKind, string> = {
  create: "externalCreateCommand",
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
  /** Which provider CLI runs the pane — the command scripts fall back to
   * matching panes by kind when the session id can't be matched (herdr does
   * not surface codex session ids). */
  provider?: string;
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
  /** Sender's interrupt/steer choice for a running turn, delivered as PASEO_ACTIVE_TURN. */
  activeTurnBehavior?: "interrupt" | "steer";
  /** Called when the command exits non-zero: the external process was not
   * reached, so whatever was sent to it did not arrive. */
  onFailure?: (code: number | null) => void;
  /** The prompt answers ("answer") or dismisses ("dismiss") a question the
   * external process is holding open, rather than starting a new turn.
   * Delivered as PASEO_QUESTION. */
  question?: "answer" | "dismiss";
}): boolean {
  const { kind, identity, logger, prompt, activeTurnBehavior, onFailure, question } = params;
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
        PASEO_AGENT_PROVIDER: identity.provider ?? "claude",
        ...(prompt === undefined ? {} : { PASEO_PROMPT: prompt }),
        ...(activeTurnBehavior === undefined ? {} : { PASEO_ACTIVE_TURN: activeTurnBehavior }),
        ...(question === undefined ? {} : { PASEO_QUESTION: question }),
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
        onFailure?.(code);
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
