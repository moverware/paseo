/**
 * How long a delivered prompt may wait for its transcript echo. Slash commands
 * flush only with the external process's next turn, which can be arbitrarily
 * later; an expired entry just means one message renders twice.
 */
const PENDING_ECHO_TTL_MS = 600_000;

import type { AgentPromptInput } from "./agent-sdk-types.js";

/** The text half of a prompt — what the external process will echo back. */
export function promptEchoText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

/**
 * Strip the decorations a prompt picks up on its way through the external
 * process before comparing it to its echo: inline "[Image #N]" markers (the
 * CLI renders attached image paths as markers, wherever the blocks land) and
 * the router's trailing "Attached images (read these files): …" appendix. What
 * is left is what the user actually typed.
 */
export function normalizeRoutedPromptText(text: string): string {
  const withoutMarkers = text.replace(/\[Image #\d+\]/g, "");
  const appendixIndex = withoutMarkers.indexOf("Attached images (read these files):");
  const body = appendixIndex === -1 ? withoutMarkers : withoutMarkers.slice(0, appendixIndex);
  return body.trim();
}

/**
 * Prompts handed to an external process whose transcript echo has not been
 * seen yet.
 *
 * A prompt the daemon commits and then routes outward comes back through the
 * transcript tail as a second copy of the same user message, and without this
 * every routed message renders twice. Upstream's clientMessageId
 * reconciliation cannot do it: the external process writes its own transcript
 * entry with none of the daemon's identifiers, so text is all there is to
 * match on. Exact one-shot accounting rather than a content window — each
 * delivery eats exactly one matching echo.
 *
 * Messages typed directly in the external process never have a ledger entry,
 * so they always render.
 */
export class ExternalEchoLedger {
  private entries: Array<{ text: string; ts: number }> = [];

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record a prompt's expected echo BEFORE its run starts. The route hook
   * delivers to the external process before refusing the daemon turn, so the
   * echo can reach the tail ahead of any result-time signal (measured
   * 2026-08-06) — send time is the only unbeatable point.
   */
  record(text: string): void {
    const normalized = normalizeRoutedPromptText(text);
    if (!normalized) {
      return;
    }
    this.entries.push({ text: normalized, ts: this.now() });
  }

  /** True when this tailed user message is a delivered prompt coming back;
   * consumes the entry, so one delivery eats exactly one echo. */
  consume(text: string): boolean {
    const cutoff = this.now() - PENDING_ECHO_TTL_MS;
    this.entries = this.entries.filter((entry) => entry.ts >= cutoff);
    const normalized = normalizeRoutedPromptText(text);
    const index = this.entries.findIndex(
      (entry) => normalized === entry.text || normalized.startsWith(`${entry.text}\n`),
    );
    if (index === -1) {
      return false;
    }
    this.entries.splice(index, 1);
    return true;
  }

  /** Outstanding entries, for tests and diagnostics. */
  get pendingCount(): number {
    return this.entries.length;
  }
}
