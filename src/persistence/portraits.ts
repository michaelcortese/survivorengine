/**
 * Castaway portraits: the photos players upload with `/castaways`, kept beside the saves so a
 * restart does not lose them.
 *
 * NOT in the snapshot, on purpose. A snapshot is JSON the engine validates field by field and
 * rewrites after every mutation; a dozen photos would make every autosave megabytes, and none
 * of them is game state — a portrait is decoration on a castaway whose NAME is the state.
 *
 * What is stored is never what was uploaded: `preparePortrait` decodes the upload, crops it to
 * the card's shape and re-encodes a small JPEG, and only that is written here.
 *
 * Layout: `<autosave.directory>/portraits/<gameId>/<playerId>-<index>.jpg`. The game id and the
 * player id are validated against the same strict pattern as a save's before either is allowed
 * into a path (audit #124), and the index is a small integer. `listSaves` only reads `*.json` at
 * the top of the directory, so the `portraits/` folder is invisible to it. With autosave off,
 * nothing touches the disk and portraits live only as long as the session.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { AutosaveConfig } from "../config.js";
import type { GameId, PlayerId } from "../engine/types.js";
import { asPlayerId } from "../engine/types.js";
import { describeCause, type Logger } from "../logger.js";
import { isValidGameId } from "./store.js";

/** The key a portrait is filed under in memory: one per castaway. */
export const portraitKey = (playerId: PlayerId, index: number): string =>
  `${playerId}:${index}`;

/** Castaway indices a file name may carry. Far more than any table has. */
const MAX_INDEX = 9;

const FILE_PATTERN = /^([A-Za-z0-9_-]{1,64})-([0-9])\.jpg$/;

export interface PortraitStoreOptions {
  readonly config: AutosaveConfig;
  readonly logger: Logger;
  /** Base directory for a relative `autosave.directory`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

export class PortraitStore {
  readonly #enabled: boolean;
  readonly #root: string;
  readonly #log: Logger;

  constructor(options: PortraitStoreOptions) {
    this.#enabled = options.config.enabled;
    const configured = options.config.directory;
    const base = isAbsolute(configured)
      ? configured
      : resolve(options.cwd ?? process.cwd(), configured);
    this.#root = join(base, "portraits");
    this.#log = options.logger.child({ component: "portraits" });
  }

  /** The folder for one game, or null for an id that may not become a path. */
  #dirFor(gameId: GameId): string | null {
    return isValidGameId(gameId) ? join(this.#root, gameId) : null;
  }

  #fileFor(gameId: GameId, playerId: PlayerId, index: number): string | null {
    const dir = this.#dirFor(gameId);
    if (dir === null || !isValidGameId(playerId)) return null;
    if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) return null;
    return join(dir, `${playerId}-${index}.jpg`);
  }

  /** Every portrait saved for this game, keyed by `portraitKey`. Empty on any problem. */
  async load(gameId: GameId): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    const dir = this.#enabled ? this.#dirFor(gameId) : null;
    if (dir === null) return out;
    let names: readonly string[];
    try {
      names = await readdir(dir);
    } catch {
      return out; // No folder is simply no portraits.
    }
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (!match?.[1] || !match[2]) continue;
      try {
        out.set(
          portraitKey(asPlayerId(match[1]), Number(match[2])),
          await readFile(join(dir, name)),
        );
      } catch (cause) {
        this.#log.warn("could not read a portrait", {
          gameId,
          name,
          cause: describeCause(cause),
        });
      }
    }
    return out;
  }

  /** Write one portrait: to a temp file, then renamed over the old one. */
  async save(
    gameId: GameId,
    playerId: PlayerId,
    index: number,
    bytes: Buffer,
  ): Promise<boolean> {
    if (!this.#enabled) return true;
    const file = this.#fileFor(gameId, playerId, index);
    if (file === null) return false;
    try {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, file);
      return true;
    } catch (cause) {
      this.#log.warn("could not save a portrait", {
        gameId,
        cause: describeCause(cause),
      });
      return false;
    }
  }

  async remove(gameId: GameId, playerId: PlayerId, index: number): Promise<void> {
    if (!this.#enabled) return;
    const file = this.#fileFor(gameId, playerId, index);
    if (file === null) return;
    await rm(file, { force: true }).catch((cause: unknown) => {
      this.#log.warn("could not remove a portrait", {
        gameId,
        cause: describeCause(cause),
      });
    });
  }

  /** Forget every portrait of a game that has ended. */
  async deleteGame(gameId: GameId): Promise<void> {
    if (!this.#enabled) return;
    const dir = this.#dirFor(gameId);
    if (dir === null) return;
    await rm(dir, { recursive: true, force: true }).catch((cause: unknown) => {
      this.#log.warn("could not remove a game's portraits", {
        gameId,
        cause: describeCause(cause),
      });
    });
  }
}
