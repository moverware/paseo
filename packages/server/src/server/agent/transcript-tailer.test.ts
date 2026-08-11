import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import type { AgentSession } from "./agent-sdk-types.js";
import { TranscriptTailer } from "./transcript-tailer.js";

/** Stands in for the provider session: records the lines it was handed, the
 * way ClaudeAgentSession converts and emits them. */
function buildSession(transcriptPath: string, ingested: string[][]): AgentSession {
  const session: Partial<AgentSession> = {
    provider: "claude",
    externalTranscriptPath: () => transcriptPath,
    ingestExternalTranscriptLines: (content: string): void => {
      const texts = content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => (JSON.parse(line) as { text: string }).text);
      ingested.push(texts);
    },
  };
  return session as AgentSession;
}

describe("TranscriptTailer", () => {
  let dir: string;
  let transcriptPath: string;
  let tailer: TranscriptTailer;
  let ingested: string[][];
  let inFlight: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-tailer-"));
    transcriptPath = path.join(dir, "session.jsonl");
    ingested = [];
    inFlight = false;
    tailer = new TranscriptTailer({
      logger: pino({ enabled: false }),
      hasDaemonRun: () => inFlight,
      pollIntervalMs: 25,
    });
  });

  afterEach(() => {
    tailer.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function ingestedTexts(): string[] {
    return ingested.flat();
  }

  test("streams whole lines appended after arm, skipping preexisting content", async () => {
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ text: "old" })}\n`);
    tailer.arm("agent-1", buildSession(transcriptPath, ingested));

    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "fresh" })}\n`);

    await vi.waitFor(() => {
      expect(ingestedTexts()).toEqual(["fresh"]);
    });
  });

  test("buffers a partial trailing line until its newline arrives", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath, ingested));

    const full = JSON.stringify({ text: "split-line" });
    fs.appendFileSync(transcriptPath, full.slice(0, 10));
    // Wait out at least one poll so the partial write is observed alone.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(ingestedTexts()).toEqual([]);

    fs.appendFileSync(transcriptPath, `${full.slice(10)}\n`);
    await vi.waitFor(() => {
      expect(ingestedTexts()).toEqual(["split-line"]);
    });
  });

  test("skips content written while a daemon-side run is in flight", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath, ingested));

    inFlight = true;
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "daemon-run" })}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

    inFlight = false;
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "external" })}\n`);
    await vi.waitFor(() => {
      expect(ingestedTexts()).toEqual(["external"]);
    });
  });

  test("resyncs to the end on truncation instead of re-emitting from zero", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath, ingested));
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "one" })}\n`);
    await vi.waitFor(() => {
      expect(ingestedTexts()).toEqual(["one"]);
    });

    fs.writeFileSync(transcriptPath, "");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "after-truncate" })}\n`);
    await vi.waitFor(() => {
      expect(ingestedTexts()).toEqual(["one", "after-truncate"]);
    });
  });

  test("disarm stops emission", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath, ingested));
    tailer.disarm("agent-1");

    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "ignored" })}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(ingestedTexts()).toEqual([]);
  });
});
