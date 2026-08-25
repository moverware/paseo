/**
 * A prompt delivered into an external pane can be refused by that pane's own
 * UserPromptSubmit hooks — on this fork, the session-handoff freshness guard.
 * The refusal renders only in the terminal; the phone saw its message accepted
 * and then nothing (2026-08-25: a guard deadlock swallowed every routed prompt
 * for a morning with no visible failure). The tailer is the one place the
 * daemon sees those refusals, so it turns them into a timeline note.
 *
 * Routed refusals — blocks carrying the "⤳" marker — are the daemon's own
 * refusal-to-route wrapper and already render through the result path
 * (extractRoutedHookNote in agent.ts); they are never a swallowed message.
 */

const HOOK_BLOCK_PREFIX = "UserPromptSubmit operation blocked by hook:\n";

/**
 * The note to surface for a tailed transcript line recording a blocked prompt
 * submission, or null for every other line.
 */
export function extractBlockedPromptNote(line: string): string | null {
  if (!line.includes("blocked by hook")) {
    return null;
  }
  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    entry = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type !== "system") {
    return null;
  }
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content.startsWith(HOOK_BLOCK_PREFIX)) {
    return null;
  }
  const body = content.slice(HOOK_BLOCK_PREFIX.length);
  for (const match of body.matchAll(/^\[[^\]]*\]:\s*(.*)$/gm)) {
    if ((match[1] ?? "").trim().startsWith("⤳")) {
      return null;
    }
  }
  // The bracketed hook paths are terminal detail; the hooks' own words and the
  // CLI's "Original prompt:" trailer are what identify the swallowed message.
  const stripped = body.replace(/^\[[^\]]*\]:\s*/gm, "").trim();
  return `⚠️ A message was blocked in the pane and did not run:\n\n${stripped}`;
}
