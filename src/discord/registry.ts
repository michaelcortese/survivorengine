/**
 * One game per Discord channel, and the lifecycle that keeps it honest.
 *
 * Audit #48 is the reason this file exists: the old bot held a module-level singleton `Game`, so
 * the bot could host exactly ONE game per process and a second Discord server silently corrupted
 * the first. Games are keyed by channel here, they are created and disposed explicitly, and
 * there is no module-level mutable game anywhere in the codebase.
 *
 * A `GameSession` owns four things and is the only object that owns them together:
 *
 *   1. THE ENGINE `Game`     — reached only through the facade in `engine/types.ts`.
 *   2. THE CHANNEL           — every public message is a fresh `channel.send`, never a followUp
 *                              on an interaction token that dies after fifteen minutes (#44).
 *   3. THE AUTOSAVE          — `if (outcome.changed) scheduleSave(...)`, after EVERY dispatch and
 *                              every tick, not just at end of turn (#60).
 *   4. THE TICK TIMER        — exactly one, always armed at `nextDeadline()`, re-armed after
 *                              every state change, cleared on dispose, and `unref`'d so a
 *                              finished game can never hold the process open (#29, #44).
 *
 * `apply()` is the single path from an action to the table. It dispatches (synchronously — the
 * engine is pure), then saves, then re-arms the timer, then ENQUEUES the rendering. Rendering is
 * an ordered async queue and is never on the path between a player's click and the reply to it,
 * which is what lets the council's dramatic pauses exist at all without blocking anything.
 */

import type { Client, GuildTextBasedChannel } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { createGame, restoreGame } from "../engine/game.js";
import type { GameEvent } from "../engine/events.js";
import type {
  Action,
  DispatchOutcome,
  Game,
  GameId,
  GameSnapshot,
  GameView,
  LegalAction,
  PlayerId,
  PrivateView,
  Result,
} from "../engine/types.js";
import { asGameId, err, ok, statusOf } from "../engine/types.js";
import { describeCause, type Logger } from "../logger.js";
import type { SaveStore } from "../persistence/store.js";
import {
  renderEvents,
  type OutgoingMessage,
  type RenderContext,
  type RenderSink,
} from "./render.js";
import { randomSeed } from "./seed.js";
import type { LegalActionRenderOptions } from "./ui.js";

// ---------------------------------------------------------------------------
// Private delivery
// ---------------------------------------------------------------------------

/**
 * How an `audience: players[…]` event reaches those players and nobody else.
 *
 * An interface rather than a concrete channel because the right answer depends on who is
 * listening: the player who just clicked can be told ephemerally on their own interaction, and
 * anyone else has to be DM'd. `interactionCreate.ts` supplies the ephemeral-first courier;
 * everything else falls back to `DirectMessageCourier`.
 *
 * Returns false when the message could not be delivered, so the session can say so out loud
 * rather than silently swallowing a player's private information.
 */
export interface PrivateCourier {
  deliver(playerIds: readonly PlayerId[], payload: OutgoingMessage): Promise<boolean>;
}

/** The always-available fallback: a direct message. */
export class DirectMessageCourier implements PrivateCourier {
  readonly #client: Client;
  readonly #log: Logger;

  constructor(client: Client, log: Logger) {
    this.#client = client;
    this.#log = log;
  }

  async deliver(
    playerIds: readonly PlayerId[],
    payload: OutgoingMessage,
  ): Promise<boolean> {
    let delivered = true;
    for (const playerId of playerIds) {
      try {
        const user = await this.#client.users.fetch(playerId);
        await user.send({
          content: payload.content,
          embeds: [...(payload.embeds ?? [])],
        });
      } catch (cause) {
        // 50007 "Cannot send messages to this user" is a setting, not a bug. Everything else is
        // logged and also treated as undelivered — and the CODE is what tells them apart, which
        // is why this goes through `describeCause` (it appends `code=<n>`) rather than through a
        // hand-rolled `.message` that strips the only field the distinction rests on.
        this.#log.warn("could not deliver a private message", {
          playerId,
          cause: describeCause(cause),
        });
        delivered = false;
      }
    }
    return delivered;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionDeps {
  readonly channel: GuildTextBasedChannel;
  readonly game: Game;
  readonly config: SurvivorConfig;
  readonly store: SaveStore;
  readonly logger: Logger;
  readonly fallbackCourier: PrivateCourier;
  /** Called once, when the game reaches a terminal stage and the entry should be dropped. */
  readonly onRetire: (session: GameSession) => void;
  /**
   * Called once when the channel has stopped accepting messages. The GAME is not over — the
   * registry drops the session and flushes the save, so `/survivor resume` can pick it up.
   */
  readonly onChannelLost: (session: GameSession) => void;
}

/** Options for a single `apply()`. */
export interface ApplyOptions {
  /** Prefer this courier for private events — normally "ephemeral to whoever just clicked". */
  readonly courier?: PrivateCourier;
  /** Override the clock. Tests only; production always uses `Date.now()`. */
  readonly nowMs?: number;
}

export class GameSession {
  readonly channel: GuildTextBasedChannel;
  readonly #game: Game;
  readonly #config: SurvivorConfig;
  readonly #store: SaveStore;
  readonly #log: Logger;
  readonly #fallbackCourier: PrivateCourier;
  readonly #onRetire: (session: GameSession) => void;
  readonly #onChannelLost: (session: GameSession) => void;

  #timer: NodeJS.Timeout | null = null;
  /** The FIFO that keeps messages in order without ever blocking a dispatch. */
  #renderQueue: Promise<void> = Promise.resolve();
  #retired = false;
  /**
   * Players whose CURRENT outage we have already announced.
   *
   * An entry is removed the moment a later delivery to that player succeeds, so this means "we
   * have already told you about this" rather than "we will never tell you again". It was
   * add-only, and the justification for the whole mechanism — "the alternative is a player
   * silently missing the fact that they are holding an Immunity Idol" — was then exactly what
   * happened from the second failure onward, including when the first failure was a transient
   * 500 or an expired interaction token rather than a closed inbox.
   */
  readonly #undeliverable = new Set<PlayerId>();
  /** Consecutive `channel.send` failures. Past the configured ceiling the channel is gone. */
  #publishFailures = 0;
  #channelLost = false;

  constructor(deps: SessionDeps) {
    this.channel = deps.channel;
    this.#game = deps.game;
    this.#config = deps.config;
    this.#store = deps.store;
    this.#fallbackCourier = deps.fallbackCourier;
    this.#onRetire = deps.onRetire;
    this.#onChannelLost = deps.onChannelLost;
    this.#log = deps.logger.child({ gameId: deps.game.id, channel: deps.channel.id });
    this.#armTimer();
  }

  // -------------------------------------------------------------------------
  // Identity and read-only access
  // -------------------------------------------------------------------------

  get gameId(): GameId {
    return this.#game.id;
  }

  /** `GameState.createdAtMs`. Survives a restore, and distinguishes this game from the last
   *  one in the same channel — which is what stops a stale button from a finished game being
   *  applied to its replacement (audit #78). */
  get incarnation(): number {
    return this.#game.state().createdAtMs;
  }

  /** The engine's monotonic mutation counter, stamped into every custom_id at render time. */
  get seq(): number {
    return this.#game.state().seq;
  }

  get retired(): boolean {
    return this.#retired;
  }

  view(): GameView {
    return this.#game.view();
  }

  privateView(viewer: PlayerId): PrivateView | null {
    return this.#game.privateView(viewer);
  }

  legalActions(player: PlayerId, nowMs: number = Date.now()): readonly LegalAction[] {
    return this.#game.legalActions(player, nowMs);
  }

  snapshot(): GameSnapshot {
    return this.#game.snapshot();
  }

  /** The engine facade. Read-only use only — mutate through `apply()` so nothing is skipped. */
  get game(): Game {
    return this.#game;
  }

  /** Exactly the four fields `ui.componentsForLegalActions` needs. */
  uiContext(
    actor: PlayerId,
  ): Omit<LegalActionRenderOptions, "only" | "showUnavailable" | "primary" | "danger"> {
    return {
      gameId: this.gameId,
      actor,
      incarnation: this.incarnation,
      seq: this.seq,
    };
  }

  /** Is this player at this table at all? Used by every "that prompt isn't yours" guard. */
  hasPlayer(playerId: PlayerId): boolean {
    return this.#game.state().players.some((player) => player.id === playerId);
  }

  // -------------------------------------------------------------------------
  // The one mutation path
  // -------------------------------------------------------------------------

  /**
   * Dispatch an action, then save, re-arm and render.
   *
   * Returns the engine's `Result` unchanged: a rule violation comes back as `err` having changed
   * NOTHING (audit #49 — the old validator mutated hands while validating, so every rejected
   * command permanently destroyed a card), and the caller turns it into a sentence with
   * `describeGameError` in `interactions.ts`.
   */
  apply(action: Action, options: ApplyOptions = {}): Result<DispatchOutcome> {
    if (this.#retired) {
      return err("game_not_found", "this game has already ended");
    }
    const nowMs = options.nowMs ?? Date.now();
    const outcome = this.#game.dispatch(action, nowMs);
    if (!outcome.ok) {
      this.#log.debug("action refused", {
        action: action.type,
        code: outcome.error.code,
      });
      return outcome;
    }
    this.#commit(outcome.value, options.courier ?? null, action.type);
    return outcome;
  }

  /**
   * Advance any deadline that has passed. Called by the tick timer and by anything that wants to
   * be sure the board is current before rendering it.
   */
  tick(nowMs: number = Date.now()): Result<DispatchOutcome> {
    if (this.#retired) return err("game_not_found", "this game has already ended");
    const outcome = this.#game.tick(nowMs);
    if (outcome.ok) this.#commit(outcome.value, null, "tick");
    else {
      this.#log.error("tick failed", undefined, { code: outcome.error.code });
    }
    return outcome;
  }

  /**
   * The three things that must happen together after every successful mutation, in this order.
   * Doing any of them at a call site is how one of them gets forgotten — audit #60 is exactly
   * "only /end_turn ever saved".
   */
  #commit(
    outcome: DispatchOutcome,
    courier: PrivateCourier | null,
    cause: string,
  ): void {
    if (outcome.changed) {
      // THE write rule (ARCHITECTURE.md §9). `events.length > 0` is not a proxy for it.
      this.#store.scheduleSave(this.#game.snapshot());
    }
    this.#armTimer();
    this.enqueueRender(outcome.events, courier);

    this.#log.debug("applied", {
      cause,
      seq: this.#game.state().seq,
      events: outcome.events.length,
      changed: outcome.changed,
    });

    const status = statusOf(this.#game.state().stage);
    if (status === "finished" || status === "abandoned") this.#retire(status);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Queue events for rendering. Ordered, never concurrent, and never awaited by a dispatch.
   *
   * This is what makes the council's paced vote reveal possible without the audit #44 disaster:
   * the pauses happen out here, after `dispatch()` has already returned, on a fresh
   * `channel.send` each time rather than against an interaction token with fifteen minutes to
   * live.
   */
  enqueueRender(events: readonly GameEvent[], courier: PrivateCourier | null): void {
    if (events.length === 0) return;
    const ctx: RenderContext = {
      view: this.#game.view(),
      config: this.#config,
      card: (uid) => this.#game.card(uid),
    };
    const sink = this.#sink(courier);
    this.#renderQueue = this.#renderQueue
      .then(() => renderEvents(events, ctx, sink, { logger: this.#log }))
      .catch((cause: unknown) => {
        // One dead webhook must not take the game with it (audit #22/#46). The state is already
        // committed and saved; only the words are lost.
        this.#log.error("rendering failed", cause);
      });
  }

  /** Wait for every queued message to be sent. Shutdown and tests use this; handlers do not. */
  async drain(): Promise<void> {
    await this.#renderQueue;
  }

  #sink(courier: PrivateCourier | null): RenderSink {
    return {
      publish: async (payload) => {
        try {
          await this.channel.send({
            content: payload.content,
            embeds: [...(payload.embeds ?? [])],
          });
          this.#publishFailures = 0;
        } catch (cause) {
          // The whisper path has been defensive at every level since it was written; `publish`
          // was bare, so one 50013 after a permissions change — or a deleted channel, or an
          // archived thread — propagated out of `renderEvents` and abandoned every remaining
          // event in the batch, including the private deliveries queued behind it. The table
          // was told nothing at all and the game silently moved on without them.
          this.#publishFailures += 1;
          this.#log.error("could not publish a message to the channel", cause, {
            consecutiveFailures: this.#publishFailures,
          });
          if (
            this.#publishFailures >= this.#config.discord.maxConsecutivePublishFailures
          ) {
            this.#loseChannel();
          }
          throw cause;
        }
      },
      whisper: async (playerIds, payload) => {
        const primary = courier ?? this.#fallbackCourier;
        const delivered = await primary.deliver(playerIds, payload);
        if (delivered || courier === null) {
          if (delivered) this.#clearUndeliverable(playerIds);
          else await this.#reportUndeliverable(playerIds);
          return;
        }
        // The ephemeral route failed (a dead interaction token, usually). Fall back to a DM
        // rather than dropping a player's private information on the floor.
        const viaDm = await this.#fallbackCourier.deliver(playerIds, payload);
        if (viaDm) this.#clearUndeliverable(playerIds);
        else await this.#reportUndeliverable(playerIds);
      },
      pause: (ms) => sleep(Math.max(0, ms)),
    };
  }

  /**
   * Say out loud that someone did not get their private message. Nothing secret is revealed —
   * only that a message exists — and the alternative is a player silently missing the fact that
   * they are holding an Immunity Idol.
   */
  /**
   * The channel has stopped taking messages: deleted, archived, or the bot was removed.
   *
   * Detached on purpose — this runs from inside the render queue, and the registry's handler
   * flushes the save and drops the entry. The GAME is not ended and the save is not deleted:
   * `/survivor resume` brings it straight back if the channel comes back.
   */
  #loseChannel(): void {
    if (this.#channelLost || this.#retired) return;
    this.#channelLost = true;
    this.#clearTimer();
    this.#log.error(
      "channel is no longer reachable; dropping the session and keeping the save",
      undefined,
      { consecutiveFailures: this.#publishFailures },
    );
    this.#onChannelLost(this);
  }

  /** A delivery landed: this player's outage is over, so the next one is worth announcing. */
  #clearUndeliverable(playerIds: readonly PlayerId[]): void {
    for (const playerId of playerIds) this.#undeliverable.delete(playerId);
  }

  async #reportUndeliverable(playerIds: readonly PlayerId[]): Promise<void> {
    const fresh = playerIds.filter((playerId) => !this.#undeliverable.has(playerId));
    if (fresh.length === 0) return;
    for (const playerId of fresh) this.#undeliverable.add(playerId);
    try {
      await this.channel.send({
        content: `${fresh.map((id) => `<@${id}>`).join(" ")} — I could not send you a private message. Turn on direct messages from server members, then use \`/hand\` to catch up.`,
      });
    } catch (cause) {
      this.#log.error("could not report an undeliverable private message", cause);
    }
  }

  // -------------------------------------------------------------------------
  // The tick timer
  // -------------------------------------------------------------------------

  /**
   * Arm the single timer at `nextDeadline()`.
   *
   * Called after EVERY state change, because the next deadline moves whenever a pending opens,
   * resolves, or a phase advances. Anything less and a window either never expires or expires
   * against a deadline that no longer exists — audit #29: "a 15s timer that was never cleared
   * and later clobbered an unrelated interruption".
   */
  #armTimer(): void {
    this.#clearTimer();
    if (this.#retired) return;

    const next = this.#game.nextDeadline();
    if (!next) return;

    const timings = this.#config.engine.timings;
    const remaining = next.atMs - Date.now();
    // The floor keeps an already-passed deadline from becoming a tight loop; the ceiling exists
    // because Node clamps a delay above 2^31-1 ms to 1 ms, which would do exactly that forever.
    const delay = Math.min(
      this.#config.discord.maxTimerDelay,
      Math.max(timings.tickInterval, remaining),
    );

    const timer = setTimeout(() => {
      this.#timer = null;
      if (this.#retired) return;
      const now = Date.now();
      if (now < next.atMs) {
        // We woke early only because the deadline was further out than one timer hop.
        this.#armTimer();
        return;
      }
      this.tick(now);
      // `tick` re-arms through `#commit`, but a tick that changed nothing still needs the next
      // hop scheduled, so arm again unconditionally. `#armTimer` clears first, so this is safe.
      this.#armTimer();
    }, delay);
    // A pending deadline must never be the reason the process is still alive.
    timer.unref();
    this.#timer = timer;

    this.#log.debug("timer armed", { reason: next.reason, inMs: delay });
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  // -------------------------------------------------------------------------
  // End of life
  // -------------------------------------------------------------------------

  /**
   * The game reached `finished` or `abandoned`.
   *
   * ARCHITECTURE.md §1: the registry DROPS the entry and the next `/survivor start` in this
   * channel builds a brand-new `Game`. There is no in-place reset, so no partially-cleared state
   * from a previous game can survive into the next one (audit #78). The save goes with it: a
   * finished game holds every player's hand and real Discord snowflakes, and resuming a corpse
   * is never what anyone wants.
   */
  #retire(status: "finished" | "abandoned"): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#clearTimer();
    this.#log.info("game retired", { status });

    // Drain the render queue FIRST so the winner announcement still goes out, then drop the save.
    this.#renderQueue = this.#renderQueue
      .then(async () => {
        this.#store.cancel(this.gameId);
        await this.#store.delete(this.gameId);
        this.#onRetire(this);
      })
      .catch((cause: unknown) => {
        this.#log.error("could not retire cleanly", cause);
        this.#onRetire(this);
      });
  }

  /**
   * Shut the session down without ending the GAME: process shutdown, or a channel that has gone
   * away. The save is flushed, not deleted, so `/survivor resume` can pick it up.
   */
  async dispose(): Promise<void> {
    this.#clearTimer();
    this.#retired = true;
    await this.#store.flush(this.gameId);
    await this.drain();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryDeps {
  readonly config: SurvivorConfig;
  readonly store: SaveStore;
  readonly logger: Logger;
  readonly client: Client;
}

export interface CreateSessionParams {
  readonly channel: GuildTextBasedChannel;
  readonly hostId: PlayerId;
  /** Tests pin this; production lets `Date.now()` and `randomSeed()` decide. */
  readonly nowMs?: number;
  readonly seed?: number;
}

export interface RestoreReport {
  readonly restored: readonly GameId[];
  readonly skipped: readonly { readonly gameId: GameId; readonly reason: string }[];
}

/**
 * The map from channel to game. THE reason `Game` has no module-level instance anywhere.
 */
export class SessionRegistry {
  readonly #sessions = new Map<GameId, GameSession>();
  readonly #config: SurvivorConfig;
  readonly #store: SaveStore;
  readonly #log: Logger;
  readonly #client: Client;
  readonly #fallbackCourier: PrivateCourier;

  constructor(deps: RegistryDeps) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#log = deps.logger.child({ component: "registry" });
    this.#client = deps.client;
    this.#fallbackCourier = new DirectMessageCourier(deps.client, this.#log);
  }

  get size(): number {
    return this.#sessions.size;
  }

  list(): readonly GameSession[] {
    return [...this.#sessions.values()];
  }

  get(channelId: string): GameSession | null {
    return this.#sessions.get(asGameId(channelId)) ?? null;
  }

  /** `get`, as a `Result`, for the many commands whose first line is "is there a game here?". */
  require(channelId: string): Result<GameSession> {
    const session = this.get(channelId);
    return session
      ? ok(session)
      : err("game_not_found", "there is no game in this channel", { channelId });
  }

  /**
   * Start a new game in a channel.
   *
   * Exactly one game per channel: a second is an error, not a silent replacement. That is audit
   * #48 stated as a postcondition rather than as a hope.
   */
  create(params: CreateSessionParams): Result<GameSession> {
    const gameId = asGameId(params.channel.id);
    if (this.#sessions.has(gameId)) {
      return err("game_already_started", "a game is already running in this channel", {
        channelId: params.channel.id,
      });
    }
    const game = createGame({
      gameId,
      hostId: params.hostId,
      config: this.#config.engine,
      nowMs: params.nowMs ?? Date.now(),
      // `config.deck.rngSeed` pins the shuffle for reproducible testing; otherwise the one
      // nondeterministic call in the codebase supplies it (engine/types.ts, CreateGameParams).
      seed: params.seed ?? this.#config.engine.deck.rngSeed ?? randomSeed(),
    });
    return ok(this.#adopt(params.channel, game));
  }

  /**
   * Restore this channel's autosaved game.
   *
   * Keyed by channel id inside the configured saves directory and nothing else — audit #124:
   * `/resume` read an arbitrary caller-supplied filesystem path with no authorization at all.
   */
  async restore(
    channel: GuildTextBasedChannel,
    nowMs: number = Date.now(),
  ): Promise<Result<GameSession>> {
    const gameId = asGameId(channel.id);
    if (this.#sessions.has(gameId)) {
      return err("game_already_started", "a game is already running in this channel");
    }
    const snapshot = await this.#store.load(gameId);
    if (!snapshot.ok) return snapshot;

    const status = statusOf(snapshot.value.state.stage);
    if (status === "finished" || status === "abandoned") {
      await this.#store.delete(gameId);
      return err("game_finished", "the saved game in this channel had already ended");
    }

    // WITH the clock: every open window is rebased by the downtime, so a deploy longer than a
    // 20-second `take` does not forfeit every window the instant the game comes back.
    const game = restoreGame(snapshot.value, nowMs);
    if (!game.ok) return game;

    const session = this.#adopt(channel, game.value);
    // `restoreGame` QUEUES a `snapshot_restored` event inside the `Game`, and the engine flushes
    // its queue onto the front of the next dispatch's events — exactly as `createGame` does with
    // `game_created`. There is nothing for the session to flush here, and the line that used to
    // sit here (`enqueueRender(game.dispatch === undefined ? [] : [], null)`) was unconditionally
    // `[]` and read as if it did something. `/survivor resume` posts the board itself, and the
    // restore narration rides out with the first real move.
    this.#log.info("game restored", { gameId, seq: snapshot.value.state.seq });
    return ok(session);
  }

  /**
   * Restore everything on disk at boot. Reported by `ready.ts`.
   *
   * A save whose channel has vanished is KEPT, not deleted: the channel may come back, and
   * throwing away a game because a fetch failed once is not recoverable.
   */
  async restoreAll(): Promise<RestoreReport> {
    const restored: GameId[] = [];
    const skipped: { gameId: GameId; reason: string }[] = [];

    for (const save of await this.#store.listSaves()) {
      if (save.problem !== null) {
        skipped.push({ gameId: save.gameId, reason: save.problem });
        continue;
      }
      const channel = await this.#fetchChannel(save.gameId);
      if (!channel) {
        skipped.push({ gameId: save.gameId, reason: "channel_unavailable" });
        continue;
      }
      const session = await this.restore(channel);
      if (session.ok) restored.push(save.gameId);
      else skipped.push({ gameId: save.gameId, reason: session.error.code });
    }
    return { restored, skipped };
  }

  async #fetchChannel(gameId: GameId): Promise<GuildTextBasedChannel | null> {
    try {
      const channel = await this.#client.channels.fetch(gameId);
      if (!channel || channel.isDMBased() || !channel.isTextBased()) return null;
      return channel;
    } catch {
      return null;
    }
  }

  #adopt(channel: GuildTextBasedChannel, game: Game): GameSession {
    const session = new GameSession({
      channel,
      game,
      config: this.#config,
      store: this.#store,
      logger: this.#log,
      fallbackCourier: this.#fallbackCourier,
      onRetire: (retired) => {
        if (this.#sessions.get(retired.gameId) === retired) {
          this.#sessions.delete(retired.gameId);
          this.#log.info("session dropped", {
            gameId: retired.gameId,
            live: this.#sessions.size,
          });
        }
      },
      onChannelLost: (lost) => {
        void this.dispose(lost.gameId);
      },
    });
    this.#sessions.set(game.id, session);
    this.#log.info("session created", { gameId: game.id, live: this.#sessions.size });
    return session;
  }

  /**
   * Drop ONE session without ending its game.
   *
   * The counterpart to `disposeAll`, and the reason `GameSession.dispose()`'s promise about "a
   * channel that has gone away" is now reachable: until this existed, `dispose()` had exactly
   * one caller (the SIGINT path), so a deleted channel left a live, ticking, autosaving session
   * playing itself out against a channel nobody could see.
   */
  async dispose(gameId: GameId): Promise<Result<null>> {
    const session = this.#sessions.get(gameId);
    if (!session) return err("game_not_found", "no session for this game", { gameId });
    this.#sessions.delete(gameId);
    await session.dispose();
    this.#log.info("session dropped", { gameId, live: this.#sessions.size });
    return ok(null);
  }

  /**
   * Drop a session WITHOUT ending its game — the shutdown path. The save is flushed so the game
   * comes back exactly where it was, and every timer is cleared so nothing keeps the process up.
   */
  async disposeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.dispose()));
    this.#log.info("all sessions disposed", { count: sessions.length });
  }
}
