import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
 * - `event_msg` with `payload.type` `item_completed` — carries a full thread
 *   item in `payload.item`, in the Rust enum's PascalCase form
 *   (`UserMessage`, `AgentMessage`, `CommandExecution`, …).
 *   `threadItemToTimeline` already normalizes PascalCase types; the one gap
 *   is `AgentMessage`, whose rollout form carries `content: [{type: "Text",
 *   text}]` where the app-server form carries `text` — flattened here.
 * - everything else (`session_meta`, `response_item`, `turn_context`,
 *   `world_state`, compaction bookkeeping) is not needed for mirroring;
 *   `item_completed` covers everything the timeline renders.
 */

export type CodexRolloutSignal =
  | { kind: "turn_started" }
  | { kind: "turn_completed" }
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
    case "task_complete":
      return { kind: "turn_completed" };
    case "item_completed": {
      const item = toRecord(payload.item);
      return item ? { kind: "item", item: normalizeRolloutItem(item) } : null;
    }
    default:
      return null;
  }
}
