import * as fs from "node:fs";

/** Bytes of a transcript's tail to scan for a continuation row. Claude Code
 * appends the row when the conversation moves, so it is always near the end
 * of the file it leaves behind. */
const TAIL_BYTES = 256 * 1024;
const MAX_HOPS = 8;

/**
 * Claude Code can move a live conversation into another process — an
 * interactive terminal session parked into a background worker on relaunch is
 * the common case. The conversation carries on under a NEW session id, in a
 * new transcript that opens with a copy of the history so far, and the old
 * transcript ends with a `continued-in` row naming the successor. From then
 * on the old file never grows again.
 *
 * Returns the successor session id recorded in `transcriptPath`, or null when
 * the transcript is the live end of its conversation.
 */
export function readClaudeContinuation(transcriptPath: string): string | null {
  let tail: string;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      tail = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!tail.includes('"continued-in"')) {
    return null;
  }
  let successor: string | null = null;
  for (const line of tail.split("\n")) {
    if (!line.includes('"continued-in"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { type?: unknown; continuedInSessionId?: unknown };
      if (
        parsed.type === "continued-in" &&
        typeof parsed.continuedInSessionId === "string" &&
        parsed.continuedInSessionId.length > 0
      ) {
        successor = parsed.continuedInSessionId;
      }
    } catch {
      // A partial trailing line; the row it belongs to is not complete yet.
    }
  }
  return successor;
}

/**
 * Follow a conversation to its live end. `resolvePath` maps a session id to
 * its transcript path. Returns the final session id, which is `sessionId`
 * itself when nothing continued it. Bounded, and stops on a cycle.
 */
export function followClaudeContinuations(
  sessionId: string,
  resolvePath: (sessionId: string) => string | null,
): string {
  let current = sessionId;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const path = resolvePath(current);
    if (!path) {
      break;
    }
    const next = readClaudeContinuation(path);
    if (!next || seen.has(next)) {
      break;
    }
    seen.add(next);
    current = next;
  }
  return current;
}
