/**
 * Filesystem persistence. With `portraits.ts` beside it, the only code in the codebase that may
 * import `node:fs` (ARCHITECTURE.md §7); `src/index.ts` is the only other file allowed near a
 * path.
 *
 * Four properties, each answering a specific audit finding:
 *
 *  1. ATOMIC. A save writes a temp file in the same directory, fsyncs it, and renames it over
 *     the target. `rename(2)` within a filesystem is atomic, so a crash mid-write leaves either
 *     the old complete file or the new complete file and never a half-written one. Audit #98:
 *     the old bot wrote a snapshot with a plain `writeFile` and two mutually incompatible,
 *     unversioned files already sat on disk.
 *  2. VALIDATED IN. `load()` goes through the engine's `parseSnapshot()`, which is the typed
 *     boundary audit #98/#102 asked for. This file NEVER writes `raw as GameSnapshot`, and a
 *     foreign, truncated or version-skewed file comes back as a `GameError` with a real code
 *     (`snapshot_version_unsupported` / `snapshot_malformed` / `snapshot_card_census_mismatch`)
 *     rather than as a crash.
 *  3. SCOPED. One file per game id inside `config.autosave.directory`, and a game id is
 *     validated against a strict pattern before it is allowed anywhere near a path. Audit #124:
 *     `/resume` read an arbitrary caller-supplied filesystem path with no authorization at all.
 *  4. FREQUENT AND FLUSHABLE. `scheduleSave()` after EVERY changed dispatch, debounced by
 *     `autosave.debounceInterval`; `flushAll()` / `flushAllSync()` drain the queue on shutdown.
 *     Audit #60: the old bot saved only in `/end_turn`, so a crash lost the whole council.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { AutosaveConfig } from "../config.js";
import { serializeSnapshot } from "../engine/snapshot.js";
import { parseSnapshot } from "../engine/snapshot.js";
import type { GameError, GameId, GameSnapshot, Result } from "../engine/types.js";
import { asGameId, err, ok } from "../engine/types.js";
import { describeCause, type Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * A game id is a Discord channel snowflake. It is validated — not merely escaped — before it
 * touches a path, so `..`, an absolute path, a NUL byte and a Windows device name are all
 * rejected by construction rather than by a blocklist that has to stay ahead of attackers.
 * The looser `[A-Za-z0-9_-]` (rather than `[0-9]`) exists so tests can use readable ids.
 */
const GAME_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const CURRENT_SUFFIX = ".json";
/** History files: `<gameId>.<rotatedAtMs>.bak.json`. Sorts newest-last by name. */
const HISTORY_INFIX = ".bak";
const TEMP_SUFFIX = ".tmp";

export const isValidGameId = (raw: string): boolean => GAME_ID_PATTERN.test(raw);

/**
 * Carries a structured `GameError` out of the write path.
 *
 * `#write` used to collapse `#pathFor`'s Result into `throw new Error(message)`, which discarded
 * the error code and the `{gameId}` detail before the handler above could log either. A thrown
 * value has to be an Error to keep a stack; this one keeps the Result as well.
 */
class SaveWriteError extends Error {
  readonly detail: GameError;

  constructor(detail: GameError) {
    super(detail.message);
    this.name = "SaveWriteError";
    this.detail = detail;
  }
}

/** Whatever a write rejected with, as the `GameError` `flush()` promises to return. */
function writeFailure(cause: unknown, gameId: GameId): GameError {
  if (cause instanceof SaveWriteError) return cause.detail;
  return {
    code: "save_write_failed",
    message: `the save could not be written: ${describeCause(cause)}`,
    details: { gameId },
  };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One save on disk, as reported by `listSaves()`. */
export interface SaveSummary {
  readonly gameId: GameId;
  /** Absolute path to the current file. Ops-facing only; never given to a player. */
  readonly path: string;
  readonly bytes: number;
  /** From the snapshot envelope when it parsed, from the file mtime when it did not. */
  readonly savedAtMs: number;
  /** Null when the file parsed cleanly; the failure code otherwise. */
  readonly problem: string | null;
  readonly schemaVersion: number | null;
  readonly seq: number | null;
  readonly playerCount: number | null;
  readonly stage: string | null;
}

export interface SaveStoreOptions {
  readonly config: AutosaveConfig;
  readonly logger: Logger;
  /** Base directory for a relative `autosave.directory`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class SaveStore {
  readonly #config: AutosaveConfig;
  readonly #log: Logger;
  readonly #dir: string;

  /** Latest snapshot per game awaiting a write. A newer one simply replaces an older one. */
  readonly #queued = new Map<GameId, GameSnapshot>();
  readonly #timers = new Map<GameId, NodeJS.Timeout>();
  /** Serialises writes per game so two flushes cannot interleave their renames. */
  readonly #inFlight = new Map<GameId, Promise<void>>();
  #directoryReady = false;

  constructor(options: SaveStoreOptions) {
    this.#config = options.config;
    this.#log = options.logger.child({ component: "store" });
    const configured = this.#config.directory;
    this.#dir = isAbsolute(configured)
      ? configured
      : resolve(options.cwd ?? process.cwd(), configured);
  }

  /** Absolute path of the saves directory. Ops-facing; used by `ready.ts` in its boot line. */
  get directory(): string {
    return this.#dir;
  }

  get enabled(): boolean {
    return this.#config.enabled;
  }

  /** True while any game has an unwritten change. Shutdown drains until this is false. */
  get hasPendingWrites(): boolean {
    return this.#queued.size > 0 || this.#inFlight.size > 0;
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  /**
   * The single choke point between a game id and the filesystem. Everything that builds a path
   * goes through here, so the audit #124 guarantee ("restores are keyed by game id inside
   * `directory` and nothing else") holds by construction rather than by convention.
   */
  #pathFor(gameId: GameId): Result<string> {
    if (!isValidGameId(gameId)) {
      return err(
        "invalid_game_id",
        `refusing to build a save path from a game id that is not a plain identifier: ${JSON.stringify(gameId)}`,
        { gameId },
      );
    }
    const path = join(this.#dir, `${gameId}${CURRENT_SUFFIX}`);
    // Belt and braces: even a pattern-passing id must not escape the saves directory.
    if (!resolve(path).startsWith(resolve(this.#dir))) {
      return err("invalid_game_id", "save path escaped the saves directory", {
        gameId,
      });
    }
    return ok(path);
  }

  async #ensureDirectory(): Promise<void> {
    if (this.#directoryReady) return;
    await mkdir(this.#dir, { recursive: true });
    this.#directoryReady = true;
  }

  #ensureDirectorySync(): void {
    if (this.#directoryReady) return;
    mkdirSync(this.#dir, { recursive: true });
    this.#directoryReady = true;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Record a snapshot to be written. THE autosave entry point, called after every dispatch or
   * tick whose `DispatchOutcome.changed` is true — the one write rule from ARCHITECTURE.md §9.
   *
   * Returns immediately: a disk write must never be on the path between a player's click and
   * the reply to it.
   */
  scheduleSave(snapshot: GameSnapshot): void {
    if (!this.#config.enabled) return;
    const gameId = snapshot.state.gameId;
    this.#queued.set(gameId, snapshot);

    if (this.#timers.has(gameId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(gameId);
      void this.flush(gameId);
    }, this.#config.debounceInterval);
    // A queued save must not by itself hold the process open — every exit path flushes first.
    timer.unref();
    this.#timers.set(gameId, timer);
  }

  #clearTimer(gameId: GameId): void {
    const timer = this.#timers.get(gameId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(gameId);
    }
  }

  /**
   * Write one game's queued snapshot now, if it has one. Safe to call at any time.
   *
   * DRAIN TO QUIESCENCE, and that is the whole point of the loop. `GameSession.dispose()` and
   * `SessionRegistry.disposeAll()` both document a guarantee about the BYTES ON DISK once their
   * promise resolves, and a shutdown exits the process straight afterwards. The old shape read
   * `#inFlight` once at entry and awaited only that: with two flushes waiting on the same write
   * (the normal shape — a debounced autosave in flight and a second debounce already fired) the
   * first to resume took the queue and started a NEW write, and every later resumer found the
   * queue empty and returned `ok(null)` without awaiting the write it had just caused. The
   * dispose-shaped caller is exactly such a later resumer, so a shutdown could lose every
   * mutation since the last COMPLETED write — up to a whole Tribal Council.
   *
   * It also actually fails now. A rejected write used to be logged and swallowed, the snapshot
   * dropped from `#queued`, and `ok(null)` returned regardless: the declared `Result<null>` had
   * no failing path at all, so an ENOSPC mid-council reported a clean shutdown and lost the
   * game. On failure the snapshot goes BACK in the queue (unless a newer one has arrived), so
   * `hasPendingWrites` stays true, `flushAllSync` on the crash path still has something to
   * write, and the caller is told.
   */
  async flush(gameId: GameId): Promise<Result<null>> {
    for (;;) {
      // Someone else's write is in the air. Wait for it, then look again: it may have been
      // started by a flush that has already returned, and it may have taken OUR snapshot.
      const existing = this.#inFlight.get(gameId);
      if (existing) {
        await existing;
        continue;
      }

      const snapshot = this.#queued.get(gameId);
      if (snapshot === undefined) return ok(null);
      this.#queued.delete(gameId);
      this.#clearTimer(gameId);

      let caught: unknown = null;
      const work = this.#write(snapshot).then(
        () => undefined,
        (cause: unknown) => {
          caught = cause;
        },
      );
      this.#inFlight.set(gameId, work);
      try {
        await work;
      } finally {
        this.#inFlight.delete(gameId);
      }

      if (caught !== null) {
        this.#log.error("autosave write failed", caught, { gameId });
        // The bytes are still owed. A newer snapshot is a better answer than this one, so it
        // wins; otherwise this one goes back so nothing pretends the game is saved.
        if (!this.#queued.has(gameId)) this.#queued.set(gameId, snapshot);
        // Do not spin against a disk that is refusing: report, and let the caller decide.
        const failure = writeFailure(caught, gameId);
        return { ok: false, error: failure };
      }
    }
  }

  /**
   * Drain every queued write. Called by SIGINT/SIGTERM and after a game is abandoned.
   *
   * A failure here cannot be returned to a signal handler, so it is reported as the count of
   * games whose bytes did NOT reach the disk — which `index.ts` turns into a non-zero exit
   * rather than a cheerful "goodbye" over a lost council.
   */
  async flushAll(): Promise<number> {
    const results = await Promise.all(
      [...this.#queued.keys()].map((gameId) => this.flush(gameId)),
    );
    await Promise.all([...this.#inFlight.values()]);
    return results.filter((result) => !result.ok).length;
  }

  /**
   * Drain synchronously.
   *
   * `uncaughtException` and `unhandledRejection` handlers must not depend on the event loop
   * still turning — by definition something has already gone wrong — so shutdown from those
   * paths writes with the sync fs calls. ARCHITECTURE.md §9: "flush pending snapshot writes
   * synchronously, and exit non-zero".
   */
  flushAllSync(): number {
    let written = 0;
    for (const [gameId, snapshot] of [...this.#queued.entries()]) {
      this.#queued.delete(gameId);
      this.#clearTimer(gameId);
      try {
        this.#writeSync(snapshot);
        written += 1;
      } catch (cause) {
        this.#log.error("synchronous autosave failed", cause, { gameId });
      }
    }
    return written;
  }

  /** Drop a game's queued write without saving it. Used when the save file is about to go. */
  cancel(gameId: GameId): void {
    this.#queued.delete(gameId);
    this.#clearTimer(gameId);
  }

  /**
   * The atomic write, async path: temp file -> fsync -> rename.
   *
   * The fsync is the part people leave out. Without it `rename` can be durable while the data
   * blocks behind it are not, and a power cut leaves a correctly-named, zero-length save.
   */
  async #write(snapshot: GameSnapshot): Promise<void> {
    const pathResult = this.#pathFor(snapshot.state.gameId);
    if (!pathResult.ok) throw new SaveWriteError(pathResult.error);
    const target = pathResult.value;

    await this.#ensureDirectory();
    const body = `${JSON.stringify(serializeSnapshot(snapshot), null, 2)}\n`;
    const temp = `${target}${TEMP_SUFFIX}`;

    const handle = await open(temp, "w");
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await this.#rotate(snapshot.state.gameId, target);
    await rename(temp, target);
    this.#log.debug("snapshot written", {
      gameId: snapshot.state.gameId,
      seq: snapshot.state.seq,
      bytes: body.length,
    });
  }

  /** The same write, with the sync fs calls, for the crash/shutdown path. */
  #writeSync(snapshot: GameSnapshot): void {
    const pathResult = this.#pathFor(snapshot.state.gameId);
    if (!pathResult.ok) throw new SaveWriteError(pathResult.error);
    const target = pathResult.value;

    this.#ensureDirectorySync();
    const body = `${JSON.stringify(serializeSnapshot(snapshot), null, 2)}\n`;
    const temp = `${target}${TEMP_SUFFIX}`;

    const fd = openSync(temp, "w");
    try {
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#rotateSync(snapshot.state.gameId, target);
    renameSync(temp, target);
  }

  /**
   * Retain `keepSnapshots` generations. The current file is renamed aside before the new one
   * takes its place, so the previous save is never destroyed by the write that replaces it —
   * which also means a crash between the rotate and the rename leaves a recoverable history
   * file rather than nothing at all (see `load()`, which falls back to it).
   */
  async #rotate(gameId: GameId, target: string): Promise<void> {
    if (this.#config.keepSnapshots <= 1) return;
    try {
      await stat(target);
    } catch {
      return; // nothing to rotate on the first save
    }
    const archived = join(
      this.#dir,
      `${gameId}.${Date.now()}${HISTORY_INFIX}${CURRENT_SUFFIX}`,
    );
    await rename(target, archived);

    const history = await this.#historyFiles(gameId);
    for (const stale of history.slice(this.#config.keepSnapshots - 1)) {
      await rm(join(this.#dir, stale), { force: true });
    }
  }

  #rotateSync(gameId: GameId, target: string): void {
    if (this.#config.keepSnapshots <= 1) return;
    if (!existsSync(target)) return;
    const archived = join(
      this.#dir,
      `${gameId}.${Date.now()}${HISTORY_INFIX}${CURRENT_SUFFIX}`,
    );
    renameSync(target, archived);
    for (const stale of this.#historyFilesSync(gameId).slice(
      this.#config.keepSnapshots - 1,
    )) {
      rmSync(join(this.#dir, stale), { force: true });
    }
  }

  /** History file names for a game, newest first. */
  async #historyFiles(gameId: GameId): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.#dir);
      return SaveStore.#selectHistory(entries, gameId);
    } catch {
      return [];
    }
  }

  #historyFilesSync(gameId: GameId): readonly string[] {
    try {
      return SaveStore.#selectHistory(readdirSync(this.#dir), gameId);
    } catch {
      return [];
    }
  }

  static #selectHistory(entries: readonly string[], gameId: GameId): readonly string[] {
    const prefix = `${gameId}.`;
    const suffix = `${HISTORY_INFIX}${CURRENT_SUFFIX}`;
    return entries
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .sort()
      .reverse();
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Load a game's save.
   *
   * The only way in. `parseSnapshot` decides whether the bytes are a snapshot; a foreign file,
   * a truncated file or one written by a newer schema comes back as a clean `GameError` that
   * `/survivor resume` can turn into a sentence, not as a throw. Audit #102.
   */
  async load(gameId: GameId): Promise<Result<GameSnapshot>> {
    const pathResult = this.#pathFor(gameId);
    if (!pathResult.ok) return pathResult;

    const direct = await this.#loadFile(pathResult.value);
    if (direct.ok) return direct;
    if (direct.error.code !== "game_not_found") return direct;

    // The current file is missing. A crash between rotate and rename is the one way that
    // happens without the game having been deleted, and the history file is the state we had.
    const history = await this.#historyFiles(gameId);
    const newest = history[0];
    if (newest === undefined) return direct;
    this.#log.warn("current save missing; recovering from the rotated copy", {
      gameId,
      file: newest,
    });
    return this.#loadFile(join(this.#dir, newest));
  }

  async #loadFile(path: string): Promise<Result<GameSnapshot>> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if (isMissingFile(cause)) {
        return err("game_not_found", `no save file at ${path}`);
      }
      return err(
        "snapshot_malformed",
        `could not read the save file: ${describeCause(cause)}`,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (cause) {
      return err(
        "snapshot_malformed",
        `the save file is not valid JSON: ${describeCause(cause)}`,
      );
    }
    return parseSnapshot(parsedJson);
  }

  /**
   * Every current save in the directory, with enough metadata for `ready.ts` to report what it
   * restored and for an operator to see what is on disk. Files that do not parse are LISTED,
   * with their `problem` set — silently omitting them is how a corrupt save becomes a mystery.
   */
  async listSaves(): Promise<readonly SaveSummary[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.#dir);
    } catch (cause) {
      if (!isMissingFile(cause)) {
        this.#log.warn("could not read the saves directory", {
          directory: this.#dir,
          cause: describeCause(cause),
        });
      }
      return [];
    }

    const summaries: SaveSummary[] = [];
    for (const name of [...entries].sort()) {
      if (!name.endsWith(CURRENT_SUFFIX)) continue;
      if (name.endsWith(`${HISTORY_INFIX}${CURRENT_SUFFIX}`)) continue;
      if (name.endsWith(TEMP_SUFFIX)) continue;

      const gameId = name.slice(0, -CURRENT_SUFFIX.length);
      if (!isValidGameId(gameId)) continue;

      const path = join(this.#dir, name);
      const bytes = await fileSize(path);
      const loaded = await this.#loadFile(path);
      if (loaded.ok) {
        summaries.push({
          gameId: asGameId(gameId),
          path,
          bytes,
          savedAtMs: loaded.value.savedAtMs,
          problem: null,
          schemaVersion: loaded.value.schemaVersion,
          seq: loaded.value.state.seq,
          playerCount: loaded.value.state.players.length,
          stage: loaded.value.state.stage.kind,
        });
      } else {
        summaries.push({
          gameId: asGameId(gameId),
          path,
          bytes,
          savedAtMs: await fileMtime(path),
          problem: loaded.error.code,
          schemaVersion: null,
          seq: null,
          playerCount: null,
          stage: null,
        });
      }
    }
    return summaries;
  }

  // -------------------------------------------------------------------------
  // Deleting
  // -------------------------------------------------------------------------

  /**
   * Remove a game's save and its history. Called on `/survivor abandon` and when a finished
   * game is disposed, so the next `/survivor start` in that channel cannot resume a corpse
   * (ARCHITECTURE.md §1: "there is no in-place reset").
   */
  async delete(gameId: GameId): Promise<Result<null>> {
    const pathResult = this.#pathFor(gameId);
    if (!pathResult.ok) return pathResult;
    this.cancel(gameId);

    try {
      await rm(pathResult.value, { force: true });
      await rm(`${pathResult.value}${TEMP_SUFFIX}`, { force: true });
      for (const stale of await this.#historyFiles(gameId)) {
        await rm(join(this.#dir, stale), { force: true });
      }
    } catch (cause) {
      return err(
        "save_write_failed",
        `could not delete the save: ${describeCause(cause)}`,
        { gameId },
      );
    }
    this.#log.info("save deleted", { gameId });
    return ok(null);
  }
}

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function fileMtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Exposed for `/survivor resume` diagnostics: does this channel have a save at all? */
export function saveExists(directory: string, gameId: string): boolean {
  if (!isValidGameId(gameId)) return false;
  try {
    return statSync(join(directory, `${gameId}${CURRENT_SUFFIX}`)).isFile();
  } catch {
    return false;
  }
}
