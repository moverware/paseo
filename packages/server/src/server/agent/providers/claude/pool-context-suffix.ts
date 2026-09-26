import { findClaudeModel } from "./models.js";

// FORK: daemon-spawned Claude children here run under API-style auth
// (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in the spawn env — an account-pool
// proxy). Under API auth Claude Code trusts a model's native 1M window only on
// a first-party host; behind any other base URL it assumes 200k unless the
// model id carries the explicit [1m] suffix, so a plain id makes the CLI
// report full context ~5x early and auto-compact on every turn. The catalog
// and the session config keep the plain id (what the app selects and what
// runtime mirroring normalizes back to); the suffix exists only on the model
// string handed to the pool-authed process — the spawned child's option, or
// the /model delivered to a pane that runs under the same env.
const ONE_MILLION = 1_000_000;

export function usesPoolAuth(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env["ANTHROPIC_AUTH_TOKEN"] || env["ANTHROPIC_BASE_URL"]);
}

/** A manifest model whose plain id is a 1M-context model: Claude Code needs
 * the suffix to size the window under pool auth. Ids that already carry one,
 * unknown ids, aliases and 200k models pass through unchanged. */
export function applyPoolContextSuffix(
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!model || /\[1m\]/i.test(model) || !usesPoolAuth(env)) {
    return model;
  }
  if (findClaudeModel(model)?.contextWindowMaxTokens !== ONE_MILLION) {
    return model;
  }
  return `${model}[1m]`;
}

const MODEL_COMMAND_PATTERN = /^(\/model\s+)(\S+)(\s*)$/;

/** `/model <id>` with the id suffixed as above; any other text unchanged. */
export function applyPoolContextSuffixToModelCommand(text: string, env: NodeJS.ProcessEnv): string {
  const match = text.match(MODEL_COMMAND_PATTERN);
  if (!match) {
    return text;
  }
  return `${match[1]}${applyPoolContextSuffix(match[2], env)}${match[3]}`;
}
