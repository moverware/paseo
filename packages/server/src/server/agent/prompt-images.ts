import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import type { AgentPromptContentBlock, AgentPromptInput } from "./agent-sdk-types.js";
import { resolvePaseoHome } from "../paseo-home.js";

/**
 * FORK: prompt images for turns that run in an external process.
 *
 * A phone's image attachments exist only as base64 inside the daemon. When a
 * turn is handed to a terminal pane — by the Claude route hook refusing the
 * daemon turn, or by the Codex session delegating every prompt out-of-band —
 * the pane can only be given file paths. Each turn's images are written under
 * `<paseo home>/prompt-images/<agent id>/` with a manifest naming them; only
 * the newest turn's files are kept, so a stale manifest cannot be mistaken for
 * the current turn's.
 *
 * The appendix format is shared with the route hook (fleet-config
 * claude/hooks/route-phone-message.py) and the echo ledger, which strips it
 * before matching a routed prompt against its transcript echo.
 */

export const IMAGE_PATHS_APPENDIX_HEADER = "Attached images (read these files):";

/** Fresh-manifest window the route hook honors; kept here as documentation of
 * the contract, the hook reads `ts` from the manifest itself. */
export const PROMPT_IMAGE_MANIFEST_FRESH_MS = 60_000;

type ImageBlock = Extract<AgentPromptContentBlock, { type: "image" }>;

function imageBlocks(prompt: AgentPromptInput): ImageBlock[] {
  if (typeof prompt === "string") {
    return [];
  }
  return prompt.filter(
    (block): block is ImageBlock =>
      typeof block === "object" && block !== null && "type" in block && block.type === "image",
  );
}

/**
 * Write the turn's image blocks to disk and return their paths. A write
 * failure must not break the turn: it is logged and an empty list returned.
 */
export function persistPromptImages(
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
): string[] {
  const images = imageBlocks(prompt);
  if (images.length === 0) {
    return [];
  }
  try {
    const dir = path.join(resolvePaseoHome(), "prompt-images", agentId);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
    const now = Date.now();
    const files: string[] = [];
    images.forEach((image, index) => {
      const ext = image.mimeType.split("/")[1]?.split("+")[0] || "png";
      const file = path.join(dir, `${now}-${index}.${ext}`);
      fs.writeFileSync(file, Buffer.from(image.data, "base64"));
      files.push(file);
    });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ts: now, paths: files }));
    return files;
  } catch (error) {
    logger.warn({ err: error }, "Failed to persist prompt images");
    return [];
  }
}

/**
 * The prompt text an external process receives for a turn with images: the
 * user's text followed by the paths appendix. An image-only message has no
 * text at all, so the appendix IS the prompt.
 */
export function withImagePathsAppendix(text: string, paths: string[]): string {
  if (paths.length === 0) {
    return text;
  }
  const appendix = `${IMAGE_PATHS_APPENDIX_HEADER}\n${paths.join("\n")}`;
  return text.trim() ? `${text}\n\n${appendix}` : appendix;
}
