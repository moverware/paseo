import * as fs from "node:fs";
import type { Logger } from "pino";
import type { AgentSession } from "./agent-sdk-types.js";

export const TRANSCRIPT_TAILER_DEFAULT_POLL_MS = 1000;
/** How long after a daemon-side run settles its own transcript flush may still
 * land. Lines appended in this window were already broadcast live. */
export const TRANSCRIPT_TAILER_SETTLE_MS = 2000;
/**
 * An external turn ends on its process's own idle report. When that report
 * never arrives — the pane was killed mid-turn, its hooks are not wired, the
 * daemon restarted across the turn — nothing else closes the turn and the
 * agent reads `running` forever (measured 2026-08-13: four agents stuck,
 * one for 9h). The transcript is the evidence: the external process appends
 * to it continuously while it works, so a transcript that has not grown in
 * this long means the turn is over. Generous, because a single long tool
 * call writes nothing while it runs.
 */
export const TRANSCRIPT_IDLE_AFTER_MS = 5 * 60_000;
const TRANSCRIPT_IDLE_SWEEP_MS = 30_000;

export interface TranscriptTailerOptions {
  logger: Logger;
  /** True while the DAEMON itself is running a turn for this agent. Its own
   * stream pump broadcasts those events, so tailed lines written by that run
   * are skipped instead of emitted twice. An external turn is an in-flight run
   * too, and must NOT count here — those lines exist only in the transcript. */
  hasDaemonRun: (agentId: string) => boolean;
  pollIntervalMs?: number;
  /** How long a transcript may sit unchanged before an open external turn is
   * treated as finished. Defaults to TRANSCRIPT_IDLE_AFTER_MS. */
  idleAfterMs?: number;
  /** How often to check for quiescent transcripts. */
  idleSweepIntervalMs?: number;
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
  /** Until this wall-clock time, appended lines belong to a daemon-side run
   * that just settled (the provider flushes its transcript after the run's
   * final event) and are skipped rather than re-emitted. */
  settleUntil: number;
}

/**
 * Streams turns that run OUTSIDE the daemon. An agent imported from another
 * client (e.g. a terminal pane running the provider CLI) keeps executing turns
 * in that external process; the daemon sees no session events for them, and
 * without this the timeline only advances on an explicit reload. The tailer
 * watches the provider-owned transcript and hands appended lines back to the
 * session, which converts them through the same replay pipeline
 * `streamHistory` uses and emits them to its subscribers — so external turns
 * reach clients down the path every other turn takes.
 *
 * Providers opt in by implementing `externalTranscriptPath` and
 * `ingestExternalTranscriptLines` on their session.
 */
export class TranscriptTailer {
  private readonly tailed = new Map<string, TailedTranscript>();
  private readonly logger: Logger;
  private readonly options: TranscriptTailerOptions;
  private readonly pollIntervalMs: number;
  private readonly idleAfterMs: number;
  private readonly idleSweep: ReturnType<typeof setInterval>;

  constructor(options: TranscriptTailerOptions) {
    this.options = options;
    this.logger = options.logger.child({ component: "transcript-tailer" });
    this.pollIntervalMs = options.pollIntervalMs ?? TRANSCRIPT_TAILER_DEFAULT_POLL_MS;
    this.idleAfterMs = options.idleAfterMs ?? TRANSCRIPT_IDLE_AFTER_MS;
    this.idleSweep = setInterval(
      () => this.closeQuiescentTurns(),
      options.idleSweepIntervalMs ?? TRANSCRIPT_IDLE_SWEEP_MS,
    );
    this.idleSweep.unref?.();
  }

  /**
   * Close external turns whose transcript has gone quiet. See
   * TRANSCRIPT_IDLE_AFTER_MS — this is the backstop for an idle report that
   * never arrives, and it never fires while the daemon runs the turn itself.
   */
  closeQuiescentTurns(now: number = Date.now()): void {
    for (const [agentId, state] of this.tailed) {
      if (state.session.isExternalTurnActive?.() !== true) {
        continue;
      }
      if (this.options.hasDaemonRun(agentId)) {
        continue;
      }
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(state.path).mtimeMs;
      } catch {
        // The transcript is gone; nothing can finish this turn but us.
        mtimeMs = 0;
      }
      if (now - mtimeMs < this.idleAfterMs) {
        continue;
      }
      this.logger.info(
        { agentId, quietForMs: now - mtimeMs },
        "closing external turn — transcript quiescent",
      );
      try {
        state.session.noteExternalTurn?.("idle");
      } catch (error) {
        this.logger.warn({ err: error, agentId }, "failed to close quiescent external turn");
      }
    }
  }

  /** Start (or refresh) tailing an agent's transcript. Skips content already
   * on disk: the session snapshot/import covered that. No-op for sessions
   * that do not expose a transcript. */
  arm(agentId: string, session: AgentSession): void {
    const path = session.externalTranscriptPath?.();
    if (!path || typeof session.ingestExternalTranscriptLines !== "function") {
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
      settleUntil: 0,
    };
    this.tailed.set(agentId, state);
    this.logger.info({ agentId, path, offset: state.offset }, "transcript tail armed");
    // Stat polling, not fs.watch: it tolerates the file not existing yet and
    // survives atomic replaces, at a latency that is fine for a chat timeline.
    fs.watchFile(path, { interval: this.pollIntervalMs }, () => {
      this.consume(agentId);
    });
  }

  /** Arm only if this agent is not already tailing the session's current
   * transcript. Unlike `arm`, an already-armed agent is left alone — no
   * resync — so this is safe to call on every stream event that might have
   * revealed a transcript path for the first time. */
  ensureArmed(agentId: string, session: AgentSession): void {
    const path = session.externalTranscriptPath?.();
    if (!path) {
      return;
    }
    const existing = this.tailed.get(agentId);
    if (existing && existing.path === path && existing.session === session) {
      return;
    }
    this.arm(agentId, session);
  }

  /** Bytes of the transcript this tailer has already consumed. Tests wait on
   * this instead of a wall-clock guess about when the file poll fired. */
  observedOffset(agentId: string): number | null {
    return this.tailed.get(agentId)?.offset ?? null;
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
   * Called when a daemon-side run settles. The provider process flushes its
   * last transcript lines slightly AFTER the run's final event, and those
   * lines were already broadcast live, so for a settling window every append
   * is skipped, not just whatever is on disk at two fixed instants. Two
   * point-in-time resyncs left a gap: a flush landing between the poll that
   * follows the first resync and the second resync was read as external work,
   * re-emitting the final assistant message and opening a phantom external
   * turn (measured 2026-09-04: every reply double-posted and the agent never
   * read idle).
   */
  resyncAfterRun(agentId: string): void {
    const state = this.tailed.get(agentId);
    if (!state) {
      return;
    }
    this.resync(agentId);
    state.settleUntil = Date.now() + TRANSCRIPT_TAILER_SETTLE_MS;
    if (state.resyncTimer) {
      clearTimeout(state.resyncTimer);
    }
    state.resyncTimer = setTimeout(() => {
      state.resyncTimer = null;
      this.resync(agentId);
    }, TRANSCRIPT_TAILER_SETTLE_MS);
  }

  dispose(): void {
    clearInterval(this.idleSweep);
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
    if (this.options.hasDaemonRun(agentId) || Date.now() < state.settleUntil) {
      // The daemon's own run is writing here and broadcasting live, or has
      // just finished and is still flushing what it already broadcast.
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
    try {
      state.session.ingestExternalTranscriptLines?.(content);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "transcript tail ingest failed");
    }
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
