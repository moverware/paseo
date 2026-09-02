// FORK: daemon-spawned Claude children here run under API-style auth
// (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in the spawn env — an account-pool
// proxy). Under API auth Claude Code assumes a 200k context window for the
// Fable models unless the model id carries the explicit [1m] suffix, while
// the subscription models actually run 1M — a plain id makes the CLI report
// full context ~5x early and auto-compact constantly. The catalog and the
// session config keep the plain id (what the app selects and what runtime
// mirroring normalizes back to); the suffix exists only on the spawned
// process's model option.
const PLAIN_FABLE_MODEL_PATTERN = /^claude-fable-\d+(?:-\d+)?$/;

export function applyFableOneMillionSuffix(
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!model || !PLAIN_FABLE_MODEL_PATTERN.test(model)) {
    return model;
  }
  if (!env["ANTHROPIC_AUTH_TOKEN"] && !env["ANTHROPIC_BASE_URL"]) {
    return model;
  }
  return `${model}[1m]`;
}
