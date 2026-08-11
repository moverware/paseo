import * as fs from "node:fs";
import type { Logger } from "pino";
import type { AgentSession, ImportedTimelineEntry } from "./agent-sdk-types.js";

export const TRANSCRIPT_TAILER_DEFAULT_POLL_MS = 1000;

export interface TranscriptTailerOptions {
  logger: Logger;
  /** True while the DAEMON itself is running a turn for this agent. Its own
   * stream pump broadcasts those events, so tailed lines written by that run
   * are skipped instead of emitted twice. An external turn is an in-flight run
   * too, and must NOT count here — those lines exist only in the transcript. */
  hasDaemonRun: (agentId: string) => boolean;
  /** Deliver converted entries into the manager's persistence + broadcast
   * pipeline. Called with whole-line batches, in file order. */
  emitEntries: (agentId: string, entries: ImportedTimelineEntry[]) => void;
  pollIntervalMs?: number;
}

interface TailedTranscript {
  path: string;
  session: AgentSession;
  offset: number;
  /** Bytes after the last newline seen — a line the writer has not finished.
   * Kept as bytes, not a string, so a multi-byte character split across two
   * reads survives intact. */
  remainder: Buffer;
  resyncTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Streams turns that run OUTSIDE the daemon. An agent imported from another
 * client (e.g. a terminal pane running the provider CLI) keeps executing turns
 * in that external process; the daemon sees no session events for them, and
 * without this the timeline only advances on an explicit reload. The tailer
 * watches the provider-owned transcript, converts appended lines through the
 * same replay pipeline `streamHistory` uses, and hands them to the manager to
 * commit and broadcast — so external turns render live, like daemon-run turns.
 *
 * Providers opt in by implementing `externalTranscriptPath` and
 * `convertExternalTranscriptLines` on their session.
 */
export class TranscriptTailer {
  private readonly tailed = new Map<string, TailedTranscript>();
  private readonly logger: Logger;
  private readonly options: TranscriptTailerOptions;
  private readonly pollIntervalMs: number;

  constructor(options: TranscriptTailerOptions) {
    this.options = options;
    this.logger = options.logger.child({ component: "transcript-tailer" });
    this.pollIntervalMs = options.pollIntervalMs ?? TRANSCRIPT_TAILER_DEFAULT_POLL_MS;
  }

  /** Start (or refresh) tailing an agent's transcript. Skips content already
   * on disk: the session snapshot/import covered that. No-op for sessions
   * that do not expose a transcript. */
  arm(agentId: string, session: AgentSession): void {
    const path = session.externalTranscriptPath?.();
    if (!path || typeof session.convertExternalTranscriptLines !== "function") {
      this.disarm(agentId);
      return;
    }
    const existing = this.tailed.get(agentId);
    if (existing && existing.path === path && existing.session === session) {
      this.resync(agentId);
      return;
    }
    this.disarm(agentId);
    const state: TailedTranscript = {
      path,
      session,
      offset: statSize(path),
      remainder: Buffer.alloc(0),
      resyncTimer: null,
    };
    this.tailed.set(agentId, state);
    // Stat polling, not fs.watch: it tolerates the file not existing yet and
    // survives atomic replaces, at a latency that is fine for a chat timeline.
    fs.watchFile(path, { interval: this.pollIntervalMs }, () => {
      this.consume(agentId);
    });
  }

  disarm(agentId: string): void {
    const state = this.tailed.get(agentId);
    if (!state) {
      return;
    }
    fs.unwatchFile(state.path);
    if (state.resyncTimer) {
      clearTimeout(state.resyncTimer);
    }
    this.tailed.delete(agentId);
  }

  /** Skip everything currently on disk and resume tailing from the end. */
  resync(agentId: string): void {
    const state = this.tailed.get(agentId);
    if (!state) {
      return;
    }
    state.offset = statSize(state.path);
    state.remainder = Buffer.alloc(0);
  }

  /**
   * Resync now and once more shortly after. Called when a daemon-side run
   * settles: the provider process can flush its last transcript lines slightly
   * after the run's final event, and those lines were already broadcast live —
   * the delayed second resync keeps them from re-emerging through the tail.
   */
  resyncAfterRun(agentId: string): void {
    const state = this.tailed.get(agentId);
    if (!state) {
      return;
    }
    this.resync(agentId);
    if (state.resyncTimer) {
      clearTimeout(state.resyncTimer);
    }
    state.resyncTimer = setTimeout(() => {
      state.resyncTimer = null;
      this.resync(agentId);
    }, 2000);
  }

  dispose(): void {
    // Deleting during Map iteration is safe per the iteration protocol.
    for (const agentId of this.tailed.keys()) {
      this.disarm(agentId);
    }
  }

  private consume(agentId: string): void {
    const state = this.tailed.get(agentId);
    if (!state) {
      return;
    }
    let size: number;
    try {
      size = fs.statSync(state.path).size;
    } catch {
      return;
    }
    if (this.options.hasDaemonRun(agentId)) {
      // The daemon's own run is writing here and broadcasting live.
      state.offset = size;
      state.remainder = Buffer.alloc(0);
      return;
    }
    if (size < state.offset) {
      // Truncated or rewritten in place (compact, rewind). Re-emitting from
      // zero would duplicate the whole timeline; skip to the end and let an
      // explicit reload rebuild history if the user wants it.
      state.offset = size;
      state.remainder = Buffer.alloc(0);
      return;
    }
    if (size === state.offset) {
      return;
    }
    let chunk: Buffer;
    try {
      chunk = readRange(state.path, state.offset, size);
    } catch (error) {
      this.logger.warn({ err: error, agentId, path: state.path }, "transcript tail read failed");
      return;
    }
    state.offset += chunk.length;
    const buffered = Buffer.concat([state.remainder, chunk]);
    const lastNewline = buffered.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      state.remainder = buffered;
      return;
    }
    state.remainder = Buffer.from(buffered.subarray(lastNewline + 1));
    const content = buffered.subarray(0, lastNewline + 1).toString("utf8");
    let entries: ImportedTimelineEntry[];
    try {
      entries = state.session.convertExternalTranscriptLines?.(content) ?? [];
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "transcript tail conversion failed");
      return;
    }
    if (entries.length === 0) {
      return;
    }
    this.options.emitEntries(agentId, entries);
  }
}

function statSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function readRange(path: string, start: number, end: number): Buffer {
  const length = end - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    return read === length ? buffer : Buffer.from(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
}
