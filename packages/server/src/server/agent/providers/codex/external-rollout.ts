import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import { normalizeProviderReplayTimestamp } from "../../provider-history-timestamps.js";

/**
 * FORK: reading a Codex rollout from outside the process that writes it.
 *
 * A Codex TUI running in a terminal pane appends every turn to a rollout file
 * under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`.
 * The transcript tailer streams those appended lines back into the daemon's
 * session, which is what makes an externally-driven Codex agent render live.
 * This module owns the two pure halves of that: finding the rollout for a
 * thread id, and turning rollout lines into signals the session can act on.
 *
 * Line schema (measured on Codex CLI 0.149.1, 2026-08-25): every line is
 * `{timestamp, type, payload}`. The types that matter here:
 *
 * - `event_msg` with `payload.type` `task_started` / `task_complete` — turn
 *   boundaries, written by the pane as the turn runs. Unlike Claude, Codex
 *   marks these explicitly, so the tail itself is an accurate turn signal.
 *   A failed `task_complete` carries an `error` object with the displayed message.
 * - `event_msg` with `payload.type` `item_completed` — carries a full thread
 *   item in `payload.item`, in the Rust enum's PascalCase form
 *   (`UserMessage`, `AgentMessage`, `CommandExecution`, …).
 *   `threadItemToTimeline` already normalizes PascalCase types; the one gap
 *   is `AgentMessage`, whose rollout form carries `content: [{type: "Text",
 *   text}]` where the app-server form carries `text` — flattened here.
 * - a top-level `compacted` record — the replacement history written when
 *   context compaction finishes. The only rollout evidence that a compaction
 *   ended: the `context_compacted` event_msg is not written on every
 *   version (absent from 0.156 rollouts, present on 0.154).
 * - `turn_context` — written at the start of every turn with the settings
 *   the turn runs under; `payload.effort` is the reasoning effort the pane
 *   actually used (measured on 0.157.1: also mirrored at
 *   `payload.collaboration_mode.settings.reasoning_effort`).
 * - everything else (`session_meta`, `response_item`, `world_state`) is not
 *   needed for mirroring; `item_completed` covers everything the timeline
 *   renders.
 */

export type CodexRolloutSignal =
  | { kind: "turn_started" }
  | { kind: "turn_completed" }
  | { kind: "turn_failed"; error: string }
  | { kind: "compacted" }
  | { kind: "effort"; effort: string }
  | { kind: "item"; item: Record<string, unknown> };

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/**
 * Locate the rollout file for a thread id. Date directories are scanned
 * newest-first so the common case (a live session from today) touches one
 * directory; the id suffix is unique, so the first match wins.
 */
function sortedDescending(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort().toReversed();
  } catch {
    return [];
  }
}

export function resolveCodexRolloutPath(threadId: string): string | null {
  if (!threadId) {
    return null;
  }
  const sessionsDir = path.join(codexHome(), "sessions");
  const suffix = `-${threadId}.jsonl`;
  const dayDirs: string[] = [];
  for (const year of sortedDescending(sessionsDir)) {
    for (const month of sortedDescending(path.join(sessionsDir, year))) {
      for (const day of sortedDescending(path.join(sessionsDir, year, month))) {
        dayDirs.push(path.join(sessionsDir, year, month, day));
      }
    }
  }
  for (const dayDir of dayDirs) {
    const match = sortedDescending(dayDir).find(
      (file) => file.startsWith("rollout-") && file.endsWith(suffix),
    );
    if (match) {
      return path.join(dayDir, match);
    }
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Join the text parts of a rollout content array, tolerant of the Rust
 * enum's `Text` casing. */
function flattenContentText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const part of content) {
    const record = toRecord(part);
    if (!record) {
      continue;
    }
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    if (
      (type === "text" || type === "input_text" || type === "output_text") &&
      typeof record.text === "string"
    ) {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Rollout `AgentMessage` items carry `content` where the app-server form
 * carries `text`; give the mapper the field it reads. */
function normalizeRolloutItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "AgentMessage" && item.type !== "agentMessage") {
    return item;
  }
  if (typeof item.text === "string") {
    return item;
  }
  const text = flattenContentText(item.content);
  return text === null ? item : { ...item, text };
}

export function parseCodexRolloutLine(line: string): CodexRolloutSignal | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = toRecord(parsed);
  if (record?.type === "compacted") {
    return { kind: "compacted" };
  }
  if (record?.type === "turn_context") {
    const effort = readTurnContextEffort(record.payload);
    return effort ? { kind: "effort", effort } : null;
  }
  if (!record || record.type !== "event_msg") {
    return null;
  }
  const payload = toRecord(record.payload);
  if (!payload || typeof payload.type !== "string") {
    return null;
  }
  switch (payload.type) {
    case "task_started":
      return { kind: "turn_started" };
    case "task_complete": {
      const error = readCodexTurnError(payload.error);
      return error ? { kind: "turn_failed", error } : { kind: "turn_completed" };
    }
    case "item_completed": {
      const item = toRecord(payload.item);
      return item ? { kind: "item", item: normalizeRolloutItem(item) } : null;
    }
    default:
      return null;
  }
}

function readTurnContextEffort(payload: unknown): string | null {
  const effort = toRecord(payload)?.effort;
  return typeof effort === "string" && effort.trim() ? effort.trim() : null;
}

const TURN_CONTEXT_MARKER = '"type":"turn_context"';
const BACKWARD_READ_CHUNK = 256 * 1024;

/**
 * The effort of the latest turn in a rollout. Rollouts run to tens of MB and
 * the answer is near the end, so this reads backwards in chunks and stops at
 * the last `turn_context` line.
 */
export function readLatestCodexRolloutEffort(rolloutPath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    let end = fs.fstatSync(fd).size;
    let carry = "";
    while (end > 0) {
      const start = Math.max(0, end - BACKWARD_READ_CHUNK);
      const buffer = Buffer.alloc(end - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = (buffer.toString("utf8") + carry).split("\n");
      // The first piece may be a partial line; it completes with the next chunk.
      carry = start > 0 ? (lines.shift() ?? "") : "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i].includes(TURN_CONTEXT_MARKER)) continue;
        const signal = parseCodexRolloutLine(lines[i]);
        if (signal?.kind === "effort") return signal.effort;
      }
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function readCodexTurnError(value: unknown): string | null {
  const error = toRecord(value);
  if (!error) return null;
  return typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : "Codex turn failed";
}

export function codexTurnErrorHistory(
  turn: Record<string, unknown>,
): Array<{ item: AgentTimelineItem; timestamp: string | undefined }> {
  const error = readCodexTurnError(turn.error);
  if (!error) return [];
  return [
    {
      item: { type: "assistant_message", text: `[System Error] ${error}` },
      timestamp:
        normalizeProviderReplayTimestamp(turn.completedAt) ??
        normalizeProviderReplayTimestamp(turn.completed_at) ??
        normalizeProviderReplayTimestamp(turn.startedAt) ??
        normalizeProviderReplayTimestamp(turn.started_at) ??
        undefined,
    },
  ];
}
