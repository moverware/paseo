import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { normalizeRoutedPromptText } from "./external-echo-ledger.js";
import { persistPromptImages, withImagePathsAppendix } from "./prompt-images.js";

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const PNG = Buffer.from("pretend png").toString("base64");

describe("prompt images handed to an external process", () => {
  let paseoHome: string;
  const originalPaseoHome = process.env.PASEO_HOME;

  beforeEach(() => {
    paseoHome = mkdtempSync(join(tmpdir(), "prompt-images-"));
    process.env.PASEO_HOME = paseoHome;
  });

  afterEach(() => {
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    rmSync(paseoHome, { recursive: true, force: true });
  });

  test("returns the written paths and names them in the manifest", () => {
    const paths = persistPromptImages(
      AGENT_ID,
      [
        { type: "text", text: "why did this fail" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
      createTestLogger(),
    );
    expect(paths).toHaveLength(1);
    expect(readFileSync(paths[0], "utf8")).toBe("pretend png");
    const manifest = JSON.parse(
      readFileSync(join(paseoHome, "prompt-images", AGENT_ID, "manifest.json"), "utf8"),
    );
    expect(manifest.paths).toEqual(paths);
  });

  test("a text-only prompt writes nothing and returns no paths", () => {
    expect(persistPromptImages(AGENT_ID, "just text", createTestLogger())).toEqual([]);
  });

  test("the appendix follows the text, or stands alone for an image-only message", () => {
    expect(withImagePathsAppendix("look", ["/a/1.png"])).toBe(
      "look\n\nAttached images (read these files):\n/a/1.png",
    );
    expect(withImagePathsAppendix("", ["/a/1.png"])).toBe(
      "Attached images (read these files):\n/a/1.png",
    );
    expect(withImagePathsAppendix("look", [])).toBe("look");
  });

  test("the echo ledger strips the appendix back to what the user typed", () => {
    expect(normalizeRoutedPromptText(withImagePathsAppendix("look", ["/a/1.png"]))).toBe("look");
  });
});
