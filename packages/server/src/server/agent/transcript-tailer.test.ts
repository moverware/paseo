import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import pino from "pino";
import type { AgentSession, ImportedTimelineEntry } from "./agent-sdk-types.js";
import { TranscriptTailer } from "./transcript-tailer.js";

function buildSession(transcriptPath: string): AgentSession {
  const session: Partial<AgentSession> = {
    provider: "claude",
    externalTranscriptPath: () => transcriptPath,
    convertExternalTranscriptLines: (content: string): ImportedTimelineEntry[] => {
      const entries: ImportedTimelineEntry[] = [];
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        const parsed = JSON.parse(line) as { text: string };
        entries.push({ item: { type: "assistant_message", text: parsed.text } });
      }
      return entries;
    },
  };
  return session as AgentSession;
}

describe("TranscriptTailer", () => {
  let dir: string;
  let transcriptPath: string;
  let tailer: TranscriptTailer;
  let emitted: Array<{ agentId: string; entries: ImportedTimelineEntry[] }>;
  let inFlight: boolean;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-tailer-"));
    transcriptPath = path.join(dir, "session.jsonl");
    emitted = [];
    inFlight = false;
    tailer = new TranscriptTailer({
      logger: pino({ enabled: false }),
      hasInFlightRun: () => inFlight,
      emitEntries: (agentId, entries) => {
        emitted.push({ agentId, entries });
      },
      pollIntervalMs: 25,
    });
  });

  afterEach(() => {
    tailer.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function emittedTexts(): string[] {
    return emitted.flatMap(({ entries }) =>
      entries.map((entry) => (entry.item.type === "assistant_message" ? entry.item.text : "")),
    );
  }

  test("streams whole lines appended after arm, skipping preexisting content", async () => {
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ text: "old" })}\n`);
    tailer.arm("agent-1", buildSession(transcriptPath));

    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "fresh" })}\n`);

    await vi.waitFor(() => {
      expect(emittedTexts()).toEqual(["fresh"]);
    });
  });

  test("buffers a partial trailing line until its newline arrives", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath));

    const full = JSON.stringify({ text: "split-line" });
    fs.appendFileSync(transcriptPath, full.slice(0, 10));
    // Wait out at least one poll so the partial write is observed alone.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(emitted).toEqual([]);

    fs.appendFileSync(transcriptPath, `${full.slice(10)}\n`);
    await vi.waitFor(() => {
      expect(emittedTexts()).toEqual(["split-line"]);
    });
  });

  test("skips content written while a daemon-side run is in flight", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath));

    inFlight = true;
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "daemon-run" })}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

    inFlight = false;
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "external" })}\n`);
    await vi.waitFor(() => {
      expect(emittedTexts()).toEqual(["external"]);
    });
  });

  test("resyncs to the end on truncation instead of re-emitting from zero", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath));
    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "one" })}\n`);
    await vi.waitFor(() => {
      expect(emittedTexts()).toEqual(["one"]);
    });

    fs.writeFileSync(transcriptPath, "");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "after-truncate" })}\n`);
    await vi.waitFor(() => {
      expect(emittedTexts()).toEqual(["one", "after-truncate"]);
    });
  });

  test("disarm stops emission", async () => {
    tailer.arm("agent-1", buildSession(transcriptPath));
    tailer.disarm("agent-1");

    fs.appendFileSync(transcriptPath, `${JSON.stringify({ text: "ignored" })}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(emitted).toEqual([]);
  });
});
