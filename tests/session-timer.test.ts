/**
 * SESSION LIFECYCLE, THE TICK/DEADLINE PATH, AND PERSISTENCE
 *
 * `src/discord/registry.ts` and `src/persistence/store.ts` are the two files that stand between
 * a pure engine and a process that has to survive real time and a real disk. Everything the
 * integration harness covers, it covers by pressing a button inside every window — so the whole
 * DEADLINE EXPIRY path (the one that runs when nobody presses anything) had no coverage at all.
 *
 * What is asserted here, and the promise each assertion is holding the code to:
 *
 *  - registry.ts header, point 4: "THE TICK TIMER — exactly one, always armed at
 *    `nextDeadline()`, re-armed after every state change, cleared on dispose, and `unref`'d so a
 *    finished game can never hold the process open (#29, #44)."
 *  - registry.ts `create()`: "Exactly one game per channel: a second is an error, not a silent
 *    replacement. That is audit #48 stated as a postcondition rather than as a hope."
 *  - store.ts header, point 1: "ATOMIC. A save writes a temp file in the same directory, fsyncs
 *    it, and renames it over the target … a crash mid-write leaves either the old complete file
 *    or the new complete file and never a half-written one." (audit #98)
 *  - store.ts header, point 2: "VALIDATED IN … a foreign, truncated or version-skewed file comes
 *    back as a `GameError` with a real code … rather than as a crash." (audit #98/#102)
 *  - store.ts header, point 3: "SCOPED. One file per game id … a game id is validated against a
 *    strict pattern before it is allowed anywhere near a path." (audit #124)
 *  - store.ts `#rotate`: "a crash between the rotate and the rename leaves a recoverable history
 *    file rather than nothing at all".
 *  - store.ts `#inFlight`: "Serialises writes per game so two flushes cannot interleave their
 *    renames."
 *
 * HOW TIME IS FAKED. `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })`.
 * Only the three the code under test actually uses are faked, so real filesystem I/O still
 * completes on a real event loop and an `await` on an fs promise resolves normally. Every game
 * is built with ONE fixed seed, so the deck, the steals and the council are identical run to run.
 *
 * HOW A CRASH IS SIMULATED. `node:fs/promises` is mocked with a pass-through that can be told to
 * throw on the Nth `rename` — the exact instant a power cut is interesting, since `rename(2)` is
 * the operation the atomicity guarantee rests on. The same mock logs `open`/`rename` order so
 * two overlapping writes to one temp file would be visible rather than merely improbable.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client, GuildTextBasedChannel } from "discord.js";

import { DEFAULT_CONFIG, withOverrides, type SurvivorConfig } from "../src/config.js";
import { SessionRegistry, type GameSession } from "../src/discord/registry.js";
import type { OutgoingMessage } from "../src/discord/render.js";
import { createGame, restoreGame } from "../src/engine/game.js";
import { parseSnapshot, serializeSnapshot } from "../src/engine/snapshot.js";
import {
  SNAPSHOT_SCHEMA_VERSION,
  asGameId,
  asPlayerId,
  isOk,
  type Action,
  type CardUid,
  type DispatchOutcome,
  type Game,
  type GameSnapshot,
  type GameState,
  type PlayerId,
  type Result,
} from "../src/engine/types.js";
import type { LogFields, Logger } from "../src/logger.js";
import { SaveStore } from "../src/persistence/store.js";

// ---------------------------------------------------------------------------
// The crash simulator
// ---------------------------------------------------------------------------

/**
 * Mutable knobs shared with the `node:fs/promises` mock below. `vi.hoisted` because `vi.mock`
 * factories are hoisted above the imports and may not close over an ordinary `const`.
 */
const fsHooks = vi.hoisted(() => ({
  /** Every `rename` this store has attempted, counted since the last `reset`. */
  renameCalls: 0,
  /** Throw an EIO on this rename call number and every one after it. Null disables. */
  failRenameAtCall: null as number | null,
  /** Ordered log of `open(<temp>)` / `rename` so an overlapped write would be visible. */
  log: [] as string[],
  /** Widen the window between opening the temp file and renaming it over the target. */
  slowTempWrites: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: async (path: string, flags?: string) => {
      if (path.endsWith(".tmp")) {
        fsHooks.log.push("open");
        if (fsHooks.slowTempWrites) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      return actual.open(path, flags);
    },
    rename: async (from: string, to: string) => {
      fsHooks.renameCalls += 1;
      fsHooks.log.push("rename");
      if (
        fsHooks.failRenameAtCall !== null &&
        fsHooks.renameCalls >= fsHooks.failRenameAtCall
      ) {
        throw Object.assign(new Error("simulated power loss before rename"), {
          code: "EIO",
        });
      }
      return actual.rename(from, to);
    },
  };
});

function resetFsHooks(): void {
  fsHooks.renameCalls = 0;
  fsHooks.failRenameAtCall = null;
  fsHooks.log = [];
  fsHooks.slowTempWrites = false;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One fixed seed for every game in this file. */
const SEED = 20250909;
/** Frozen wall clock. Every engine timestamp in this file is relative to it. */
const NOW = 1_700_000_000_000;

const TAKE_WINDOW = DEFAULT_CONFIG.engine.timings.pendingWindows.take; // 20_000
const TURN_BACKSTOP = DEFAULT_CONFIG.engine.timings.turnSafetyTimeout; // 600_000
/** Autosave debounce used by every store in this file. Short, so a test can step over it. */
const DEBOUNCE = 50;

interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly cause: unknown;
}

/** A logger that records instead of printing, so "was this reported?" is assertable. */
function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    debug: (message: string, _fields?: LogFields) => {
      lines.push({ level: "debug", message, cause: undefined });
    },
    info: (message: string, _fields?: LogFields) => {
      lines.push({ level: "info", message, cause: undefined });
    },
    warn: (message: string, _fields?: LogFields) => {
      lines.push({ level: "warn", message, cause: undefined });
    },
    error: (message: string, cause?: unknown, _fields?: LogFields) => {
      lines.push({ level: "error", message, cause });
    },
    child: () => make(),
  });
  return make();
}

/** A text channel that keeps everything it was told to send. */
class FakeChannel {
  readonly sent: OutgoingMessage[] = [];
  constructor(readonly id: string) {}

  send(payload: OutgoingMessage): Promise<void> {
    this.sent.push(payload);
    return Promise.resolve();
  }

  isDMBased(): boolean {
    return false;
  }

  isTextBased(): boolean {
    return true;
  }

  /** Everything said in this channel, as one blob: content plus every embed's text. */
  transcript(): string {
    return this.sent
      .map((message) => {
        const embeds = (message.embeds ?? []).map((embed) => {
          const data = embed.toJSON();
          const fields = (data.fields ?? [])
            .map((field) => `${field.name} ${field.value}`)
            .join(" ");
          return `${data.title ?? ""} ${data.description ?? ""} ${fields}`;
        });
        return [message.content ?? "", ...embeds].join(" ");
      })
      .join("\n");
  }

  as(): GuildTextBasedChannel {
    return this as unknown as GuildTextBasedChannel;
  }
}

/** A client that can hand out a DM-able user and nothing else. */
function fakeClient(channels: readonly FakeChannel[]): Client {
  const dmTarget = {
    send: (): Promise<void> => Promise.resolve(),
  };
  return {
    users: { fetch: () => Promise.resolve(dmTarget) },
    channels: {
      fetch: (id: string) => {
        const found = channels.find((channel) => channel.id === id);
        return found ? Promise.resolve(found.as()) : Promise.resolve(null);
      },
    },
  } as unknown as Client;
}

const pid = (raw: string): PlayerId => asPlayerId(raw);

function expectOk<T>(result: Result<T>, what: string): T {
  if (!isOk(result)) {
    throw new Error(
      `${what}: expected ok, got ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.value;
}

function expectErrCode<T>(result: Result<T>, what: string): string {
  if (isOk(result)) throw new Error(`${what}: expected an error, got ok`);
  return result.error.code;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let saveDir: string;
let logLines: LogLine[];

function makeConfig(
  overrides: { autosave?: boolean; keepSnapshots?: number } = {},
): SurvivorConfig {
  return withOverrides(DEFAULT_CONFIG, {
    autosave: {
      enabled: overrides.autosave ?? true,
      directory: saveDir,
      debounceInterval: DEBOUNCE,
      keepSnapshots: overrides.keepSnapshots ?? 3,
    },
    engine: { deck: { rngSeed: SEED } },
  });
}

interface Harness {
  readonly config: SurvivorConfig;
  readonly store: SaveStore;
  readonly registry: SessionRegistry;
  readonly channels: FakeChannel[];
}

function harness(
  channelIds: readonly string[],
  overrides: { autosave?: boolean; keepSnapshots?: number } = {},
): Harness {
  const config = makeConfig(overrides);
  const logger = recordingLogger(logLines);
  const store = new SaveStore({ config: config.autosave, logger });
  const channels = channelIds.map((id) => new FakeChannel(id));
  const registry = new SessionRegistry({
    config,
    store,
    logger,
    client: fakeClient(channels),
  });
  return { config, store, registry, channels };
}

function apply(session: GameSession, action: Action): DispatchOutcome {
  return expectOk(session.apply(action), action.type);
}

/** Join `names` and start. The engine seats them in join order; p0 is host. */
function startGame(session: GameSession, names: readonly string[]): void {
  for (const name of names) {
    apply(session, {
      type: "join_game",
      actor: pid(name),
      displayName: name.toUpperCase(),
    });
  }
  const host = names[0];
  if (host === undefined) throw new Error("startGame needs at least one player");
  apply(session, { type: "start_game", actor: pid(host) });
}

/** The id of whoever is on turn, from the PUBLIC view. */
function onTurn(session: GameSession): PlayerId {
  const turn = session.view().turn;
  if (!turn) throw new Error(`no turn in stage ${session.view().stage}`);
  return turn.playerId;
}

function legalOf(session: GameSession, player: PlayerId, kind: Action["type"]) {
  const found = session.legalActions(player).find((action) => action.kind === kind);
  if (!found) {
    throw new Error(
      `${player} may not ${kind}; only [${session
        .legalActions(player)
        .map((a) => a.kind)
        .join(", ")}]`,
    );
  }
  return found;
}

function firstTarget(
  session: GameSession,
  player: PlayerId,
  kind: Action["type"],
): PlayerId {
  const target = legalOf(session, player, kind).legalTargets?.[0];
  if (target === undefined) throw new Error(`${kind} offered no legal target`);
  return target;
}

function firstPlayable(
  session: GameSession,
  player: PlayerId,
  kind: Action["type"],
): CardUid {
  const uid = legalOf(session, player, kind).playableCardUids?.[0];
  if (uid === undefined) throw new Error(`${kind} offered no playable card`);
  return uid;
}

/**
 * Let every currently-open pending window expire, by moving the fake clock to each deadline in
 * turn. This is the session's own timer doing the work — nothing here calls `tick` directly.
 */
function expirePendings(session: GameSession): void {
  for (let guard = 0; guard < 20; guard += 1) {
    const next = session.game.nextDeadline();
    if (!next || next.pendingId === null) return;
    vi.advanceTimersByTime(Math.max(1, next.atMs - Date.now()) + 1);
  }
  throw new Error("pending windows would not drain");
}

/**
 * Play whole turns (mandatory steal, skip the play step, draw) until a Tribal Council card comes
 * off the deck. With the fixed seed this takes 15 turns and is identical every run.
 */
function driveToCouncil(session: GameSession): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const view = session.view();
    if (view.stage === "council") return;
    if (view.stage !== "turn")
      throw new Error(`stage went to ${view.stage}, not council`);
    const actor = onTurn(session);
    const phase = view.turn?.phase;
    if (phase === "steal") {
      apply(session, {
        type: "steal_random",
        actor,
        target: firstTarget(session, actor, "steal_random"),
      });
    } else if (phase === "play") {
      apply(session, { type: "skip_play_step", actor });
    } else if (phase === "draw") {
      apply(session, { type: "draw_card", actor });
    } else {
      throw new Error(`unexpected turn phase ${String(phase)}`);
    }
    expirePendings(session);
  }
  throw new Error("never reached a Tribal Council");
}

/** Advance the council to `voting` through the Leader, the way the UI would. */
function openVoting(session: GameSession): void {
  const leader = session.view().council?.leaderId;
  if (leader === undefined) throw new Error("no council leader");
  apply(session, { type: "advance_council", actor: leader, from: "advantages" });
  apply(session, { type: "advance_council", actor: leader, from: "discussion" });
}

/** A structural clone of a snapshot, through the JSON the disk would have held. */
/**
 * Every absolute deadline in a state, in a stable order.
 *
 * `registry.restore()` deliberately REBASES these by however long the bot was away, so a deploy
 * longer than a 20-second `take` window does not forfeit every open window the instant the game
 * comes back (a player holding an Immunity Idol used to watch the whole council resolve in three
 * seconds). Everything else about a restored state must still come back byte for byte, so the
 * round-trip assertions compare the state with its deadlines lifted out and check the rebase
 * separately with `expectDeadlinesRebasedBy`.
 */
function deadlinesOf(state: GameState): number[] {
  const out: number[] = [];
  for (const pending of state.pending) out.push(pending.deadlineMs);
  const stage = state.stage;
  if (stage.kind === "turn" || stage.kind === "council") {
    if (stage.turn.deadlineMs !== null) out.push(stage.turn.deadlineMs);
  }
  if (stage.kind === "council" && stage.council.phaseDeadlineMs !== null) {
    out.push(stage.council.phaseDeadlineMs);
  }
  if (stage.kind === "final_council" && stage.finalCouncil.phaseDeadlineMs !== null) {
    out.push(stage.finalCouncil.phaseDeadlineMs);
  }
  return out;
}

/** The same state with every deadline blanked, for a deep equality that ignores the rebase. */
function withoutDeadlines(state: GameState): unknown {
  return JSON.parse(
    JSON.stringify(state, (key, value: unknown) =>
      key === "deadlineMs" || key === "phaseDeadlineMs" ? null : value,
    ),
  );
}

/**
 * Every open window came back OPEN, shifted by one constant amount.
 *
 * The two properties that matter, and neither of them re-implements the engine's arithmetic:
 * no window that had time left is already expired at the moment of the restore, and every
 * deadline moved by the SAME amount, so the order windows close in is unchanged.
 */
function expectWindowsSurvivedTheRestore(
  restored: GameState,
  original: GameState,
  atMs: number,
): void {
  const after = deadlinesOf(restored);
  const before = deadlinesOf(original);
  expect(after).toHaveLength(before.length);
  const shifts = new Set(after.map((deadline, i) => deadline - (before[i] ?? 0)));
  expect(shifts.size, "deadlines were not all shifted by the same amount").toBeLessThan(
    2,
  );
  for (const [i, deadline] of after.entries()) {
    expect(
      deadline,
      `window[${i}] came back already expired, which is the whole defect`,
    ).toBeGreaterThan(atMs);
  }
}

function cloneThroughJson(snapshot: GameSnapshot): GameSnapshot {
  const raw: unknown = JSON.parse(JSON.stringify(serializeSnapshot(snapshot)));
  return expectOk(parseSnapshot(raw), "clone through JSON");
}

function saveFile(gameId: string): string {
  return join(saveDir, `${gameId}.json`);
}

function readSave(gameId: string): string {
  return readFileSync(saveFile(gameId), "utf8");
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  saveDir = mkdtempSync(join(tmpdir(), "survivor-session-"));
  logLines = [];
  resetFsHooks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  // Real timers first: any timer this test left armed dies with the fake clock, which is exactly
  // what we want even for the tests that deliberately leave a session live.
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(saveDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The tick timer
// ---------------------------------------------------------------------------

describe("the session tick timer", () => {
  it("arms no timer at all while a lobby has no deadline to wait for", () => {
    const { registry, channels } = harness(["chan-lobby"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );

    apply(session, { type: "join_game", actor: pid("a"), displayName: "A" });

    expect(session.game.nextDeadline()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms exactly one timer, at the engine's next deadline, and does not fire early", () => {
    const { registry, channels } = harness(["chan-turn"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);

    expect(session.game.nextDeadline()).toEqual({
      atMs: NOW + TURN_BACKSTOP,
      reason: "turn",
      pendingId: null,
    });
    expect(vi.getTimerCount()).toBe(1);

    const seqBefore = session.seq;
    vi.advanceTimersByTime(TURN_BACKSTOP - 1);
    expect(session.seq).toBe(seqBefore);

    vi.advanceTimersByTime(2);
    expect(session.seq).toBeGreaterThan(seqBefore);
    // Still exactly one timer: the tick re-armed rather than stacking a second one.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("re-arms the single timer onto a nearer deadline when a window opens", () => {
    const { registry, channels } = harness(["chan-window"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    expect(session.game.nextDeadline()?.atMs).toBe(NOW + TURN_BACKSTOP);

    const actor = onTurn(session);
    apply(session, {
      type: "steal_random",
      actor,
      target: firstTarget(session, actor, "steal_random"),
    });

    expect(session.game.nextDeadline()?.reason).toBe("take");
    expect(session.game.nextDeadline()?.atMs).toBe(NOW + TAKE_WINDOW);
    expect(vi.getTimerCount()).toBe(1);

    const seqBefore = session.seq;
    vi.advanceTimersByTime(TAKE_WINDOW - 1);
    expect(session.seq).toBe(seqBefore);

    vi.advanceTimersByTime(2);
    // The nearer deadline fired; the turn backstop is still hours away and did not.
    expect(session.view().openPending).toHaveLength(0);
    expect(session.view().turn?.phase).toBe("play");
  });

  it("ticks, resolves and narrates an expired window with nobody pressing a button", async () => {
    const { registry, channels } = harness(["chan-expiry"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    const actor = onTurn(session);
    const victim = firstTarget(session, actor, "steal_random");
    apply(session, { type: "steal_random", actor, target: victim });
    await session.drain();

    const beforeExpiry = channel.transcript();
    expect(beforeExpiry).not.toContain("Nobody played Sorry For You");

    vi.advanceTimersByTime(TAKE_WINDOW + 1);
    await session.drain();

    const after = channel.transcript();
    expect(after).toContain("Nobody played Sorry For You. The cards moved.");
    expect(after).toContain(`moved from <@${victim}>`);
    expect(session.view().turn?.stealResolved).toBe(true);
  });

  it("unrefs its tick timer so a waiting deadline cannot hold the process open", () => {
    const unrefedDelays: number[] = [];
    const underlying = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler: () => void, ms?: number) => {
        const handle = underlying(handler, ms);
        const originalUnref = handle.unref.bind(handle);
        handle.unref = () => {
          unrefedDelays.push(ms ?? 0);
          return originalUnref();
        };
        return handle;
      });

    const { registry, channels } = harness(["chan-unref"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    spy.mockRestore();

    expect(session.game.nextDeadline()?.atMs).toBe(NOW + TURN_BACKSTOP);
    expect(unrefedDelays).toContain(TURN_BACKSTOP);
  });

  it("clears the tick timer on dispose so it can never fire against a dead session", async () => {
    const { registry, channels } = harness(["chan-dispose"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    const actor = onTurn(session);
    apply(session, {
      type: "steal_random",
      actor,
      target: firstTarget(session, actor, "steal_random"),
    });
    await session.drain();

    const seqAtDispose = session.seq;
    const saidAtDispose = channel.sent.length;
    await session.dispose();

    expect(vi.getTimerCount()).toBe(0);

    // Long past both the take window and the turn backstop.
    vi.advanceTimersByTime(TURN_BACKSTOP * 3);
    await Promise.resolve();

    expect(session.seq).toBe(seqAtDispose);
    expect(channel.sent.length).toBe(saidAtDispose);
    expect(session.view().openPending).toHaveLength(1);
  });

  it("refuses every action once the session has been disposed", async () => {
    const { registry, channels } = harness(["chan-dead"], { autosave: false });
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    await session.dispose();

    expect(session.retired).toBe(true);
    expect(
      expectErrCode(
        session.apply({ type: "skip_play_step", actor: pid("b") }),
        "apply",
      ),
    ).toBe("game_not_found");
    expect(expectErrCode(session.tick(NOW + TURN_BACKSTOP * 2), "tick")).toBe(
      "game_not_found",
    );
  });

  it("drops the session, clears the timer and deletes the save when a game is abandoned", async () => {
    const { registry, store, channels } = harness(["chan-abandon"]);
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    await store.flushAll();
    expect(existsSync(saveFile("chan-abandon"))).toBe(true);

    apply(session, { type: "abandon_game", actor: pid("a") });
    await session.drain();

    expect(registry.size).toBe(0);
    expect(registry.get("chan-abandon")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(saveFile("chan-abandon"))).toBe(false);
    expect(
      readdirSync(saveDir).filter((name) => name.startsWith("chan-abandon")),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One game per channel
// ---------------------------------------------------------------------------

describe("one game per channel", () => {
  it("refuses a second game in a channel that already has one and leaves the first untouched", () => {
    const { registry, channels } = harness(["chan-one"], { autosave: false });
    const channel = channels[0]!;
    const first = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(first, ["a", "b", "c"]);
    const seqBefore = first.seq;
    const incarnationBefore = first.incarnation;

    const second = registry.create({
      channel: channel.as(),
      hostId: pid("z"),
      seed: SEED + 1,
    });

    expect(expectErrCode(second, "second create")).toBe("game_already_started");
    expect(registry.size).toBe(1);
    expect(registry.get("chan-one")).toBe(first);
    expect(first.seq).toBe(seqBefore);
    expect(first.incarnation).toBe(incarnationBefore);
    expect(first.hasPlayer(pid("z"))).toBe(false);
  });

  it("refuses to restore over a channel that already has a live game", async () => {
    const { registry, store, channels } = harness(["chan-live"]);
    const channel = channels[0]!;
    const live = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(live, ["a", "b", "c"]);
    await store.flushAll();

    const restored = await registry.restore(channel.as());

    expect(expectErrCode(restored, "restore over live")).toBe("game_already_started");
    expect(registry.get("chan-live")).toBe(live);
    expect(registry.size).toBe(1);
  });

  it("runs two channels as independent games that cannot see or corrupt each other", async () => {
    const { registry, store, channels } = harness(["chan-a", "chan-b"]);
    const [chanA, chanB] = channels as [FakeChannel, FakeChannel];

    const a = expectOk(
      registry.create({ channel: chanA.as(), hostId: pid("a1"), seed: SEED }),
      "create a",
    );
    const b = expectOk(
      registry.create({ channel: chanB.as(), hostId: pid("b1"), seed: SEED + 7 }),
      "create b",
    );
    startGame(a, ["a1", "a2", "a3"]);
    startGame(b, ["b1", "b2", "b3"]);
    await a.drain();
    await b.drain();

    expect(registry.size).toBe(2);
    expect(registry.get("chan-a")).toBe(a);
    expect(registry.get("chan-b")).toBe(b);
    expect(a.gameId).not.toBe(b.gameId);

    const bSeqBefore = b.seq;
    const bSaidBefore = chanB.sent.length;
    const bStateBefore = JSON.stringify(b.snapshot().state);

    // A whole steal + expiry cycle in channel A.
    const actor = onTurn(a);
    apply(a, {
      type: "steal_random",
      actor,
      target: firstTarget(a, actor, "steal_random"),
    });
    vi.advanceTimersByTime(TAKE_WINDOW + 1);
    await a.drain();
    await b.drain();

    // B did not move, was not spoken to, and holds none of A's players.
    expect(b.seq).toBe(bSeqBefore);
    expect(chanB.sent.length).toBe(bSaidBefore);
    expect(JSON.stringify(b.snapshot().state)).toBe(bStateBefore);
    for (const player of ["a1", "a2", "a3"]) {
      expect(b.hasPlayer(pid(player))).toBe(false);
      expect(chanB.transcript()).not.toContain(player);
    }
    for (const player of ["b1", "b2", "b3"]) {
      expect(a.hasPlayer(pid(player))).toBe(false);
      expect(chanA.transcript()).not.toContain(player);
    }

    // And on disk they are two files, each holding its own game.
    await store.flushAll();
    const savedA = expectOk(await store.load(asGameId("chan-a")), "load a");
    const savedB = expectOk(await store.load(asGameId("chan-b")), "load b");
    expect(savedA.state.gameId).toBe("chan-a");
    expect(savedB.state.gameId).toBe("chan-b");
    expect(savedA.state.players.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(savedB.state.players.map((p) => p.id)).toEqual(["b1", "b2", "b3"]);
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

/** A tiny standalone game, used where a full session would only be noise. */
function loneGame(gameId: string, players: readonly string[]): Game {
  const game = createGame({
    gameId: asGameId(gameId),
    hostId: pid(players[0] ?? "a"),
    config: DEFAULT_CONFIG.engine,
    nowMs: NOW,
    seed: SEED,
  });
  for (const name of players) {
    expectOk(
      game.dispatch({ type: "join_game", actor: pid(name), displayName: name }, NOW),
      "join",
    );
  }
  return game;
}

describe("SaveStore atomicity", () => {
  it("leaves the previous save byte-for-byte intact when the write crashes before the rename", async () => {
    const config = makeConfig({ keepSnapshots: 1 });
    const store = new SaveStore({
      config: config.autosave,
      logger: recordingLogger(logLines),
    });
    const game = loneGame("chan-atomic", ["a", "b", "c"]);

    store.scheduleSave(game.snapshot());
    await store.flushAll();
    const generationOne = readSave("chan-atomic");
    const seqOne = game.state().seq;

    // Move the game on, then lose power at the instant of the rename.
    expectOk(game.dispatch({ type: "start_game", actor: pid("a") }, NOW), "start");
    expect(game.state().seq).toBeGreaterThan(seqOne);
    fsHooks.renameCalls = 0;
    fsHooks.failRenameAtCall = 1;
    store.scheduleSave(game.snapshot());
    await store.flushAll();
    fsHooks.failRenameAtCall = null;

    // The old, complete save is still exactly what it was.
    expect(readSave("chan-atomic")).toBe(generationOne);
    const loaded = expectOk(
      await store.load(asGameId("chan-atomic")),
      "load after crash",
    );
    expect(loaded.state.seq).toBe(seqOne);
    expect(loaded.state.stage.kind).toBe("lobby");
  });

  it("recovers the previous save from the rotated copy when the crash lands between rotate and rename", async () => {
    const config = makeConfig({ keepSnapshots: 3 });
    const store = new SaveStore({
      config: config.autosave,
      logger: recordingLogger(logLines),
    });
    const game = loneGame("chan-rotate", ["a", "b", "c"]);

    store.scheduleSave(game.snapshot());
    await store.flushAll();
    const seqOne = game.state().seq;

    expectOk(game.dispatch({ type: "start_game", actor: pid("a") }, NOW), "start");
    // rename #1 is the rotate (current -> .bak); rename #2 is temp -> current. Die on #2.
    fsHooks.renameCalls = 0;
    fsHooks.failRenameAtCall = 2;
    store.scheduleSave(game.snapshot());
    await store.flushAll();
    fsHooks.failRenameAtCall = null;

    // The current file is gone — that is the whole point of the scenario.
    expect(existsSync(saveFile("chan-rotate"))).toBe(false);

    const loaded = expectOk(
      await store.load(asGameId("chan-rotate")),
      "load after rotate crash",
    );
    expect(loaded.state.seq).toBe(seqOne);
    expect(loaded.state.stage.kind).toBe("lobby");
    // And it said so, rather than silently handing back a file from somewhere else.
    expect(
      logLines.some((line) =>
        line.message.includes("recovering from the rotated copy"),
      ),
    ).toBe(true);
  });

  it("reports a failed write as an err, and keeps owing the bytes, instead of throwing", async () => {
    // Two properties, and the second one is the one that matters on a shutdown. A failed write
    // must NOT throw at the caller — the game state is already committed and a save is not a
    // rule. But it must not be reported as success either: `flush()` used to log the failure,
    // DROP the snapshot from its queue and return `ok(null)` unconditionally, so an ENOSPC
    // mid-council left `hasPendingWrites` false, gave `flushAllSync()` nothing to write on the
    // crash path, and let the SIGINT handler print "goodbye" over a lost Tribal Council.
    const config = makeConfig({ keepSnapshots: 1 });
    const store = new SaveStore({
      config: config.autosave,
      logger: recordingLogger(logLines),
    });
    const game = loneGame("chan-report", ["a", "b", "c"]);

    fsHooks.failRenameAtCall = 1;
    store.scheduleSave(game.snapshot());
    const result = await store.flush(asGameId("chan-report"));
    expect(result.ok, "a failed write must not be reported as a success").toBe(false);
    if (!result.ok) expect(result.error.code).toBe("save_write_failed");

    expect(
      logLines.some(
        (line) => line.level === "error" && line.message === "autosave write failed",
      ),
    ).toBe(true);

    // Still owed: the snapshot went back in the queue, so a retry — including the synchronous
    // one on the crash path — still has the bytes to write.
    expect(store.hasPendingWrites).toBe(true);
    expect(store.flushAllSync()).toBe(1);
    expect(store.hasPendingWrites).toBe(false);
    const reloaded = await store.load(asGameId("chan-report"));
    expect(expectOk(reloaded, "reload after the retry").state.seq).toBe(
      game.state().seq,
    );
  });

  it("never overlaps two writes to one game's temp file, however they are interleaved", async () => {
    const config = makeConfig({ keepSnapshots: 1 });
    const store = new SaveStore({
      config: config.autosave,
      logger: recordingLogger(logLines),
    });
    const game = loneGame("chan-race", []);
    fsHooks.slowTempWrites = true;
    fsHooks.log = [];

    // A save queued and flushed for every join, without ever awaiting in between.
    const pending: Promise<unknown>[] = [];
    const seqs: number[] = [];
    for (let i = 0; i < DEFAULT_CONFIG.engine.limits.maxPlayers; i += 1) {
      expectOk(
        game.dispatch(
          { type: "join_game", actor: pid(`x${i}`), displayName: `X${i}` },
          NOW,
        ),
        "join",
      );
      seqs.push(game.state().seq);
      store.scheduleSave(game.snapshot());
      pending.push(store.flush(asGameId("chan-race")));
    }
    await Promise.all(pending);
    await store.flushAll();

    // With keepSnapshots = 1 a write is exactly one open followed by one rename. Any interleave
    // would show up as two opens in a row — i.e. two writers sharing `chan-race.json.tmp`.
    // The length guard is there so an empty log can never pass this vacuously.
    expect(fsHooks.log.length).toBeGreaterThanOrEqual(4);
    expect(fsHooks.log.length % 2).toBe(0);
    expect(fsHooks.log.join(",")).toBe(
      Array.from({ length: fsHooks.log.length / 2 }, () => "open,rename").join(","),
    );

    // And the file that survives is a complete, parseable, newest-wins save.
    const loaded = expectOk(await store.load(asGameId("chan-race")), "load after race");
    expect(loaded.state.seq).toBe(seqs[seqs.length - 1]);
    expect(JSON.parse(readSave("chan-race"))).toMatchObject({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    });
  });
});

// ---------------------------------------------------------------------------
// Rejecting bad files
// ---------------------------------------------------------------------------

describe("SaveStore rejects a save it cannot trust", () => {
  function storeOnly(): SaveStore {
    const config = makeConfig();
    return new SaveStore({
      config: config.autosave,
      logger: recordingLogger(logLines),
    });
  }

  /** A real, valid save file for `gameId`, so the corruption cases have a baseline. */
  async function writeRealSave(
    store: SaveStore,
    gameId: string,
  ): Promise<GameSnapshot> {
    const game = loneGame(gameId, ["a", "b", "c"]);
    expectOk(game.dispatch({ type: "start_game", actor: pid("a") }, NOW), "start");
    store.scheduleSave(game.snapshot());
    await store.flushAll();
    return game.snapshot();
  }

  it("rejects a corrupt save file with a clean error instead of throwing", async () => {
    const store = storeOnly();
    await writeRealSave(store, "chan-corrupt");
    writeFileSync(saveFile("chan-corrupt"), "}{ this is not json at all", "utf8");

    const loaded = await store.load(asGameId("chan-corrupt"));
    expect(expectErrCode(loaded, "corrupt")).toBe("snapshot_malformed");
  });

  it("rejects a truncated save file rather than restoring half a game", async () => {
    const store = storeOnly();
    await writeRealSave(store, "chan-trunc");
    const whole = readSave("chan-trunc");
    writeFileSync(
      saveFile("chan-trunc"),
      whole.slice(0, Math.floor(whole.length / 2)),
      "utf8",
    );

    expect(expectErrCode(await store.load(asGameId("chan-trunc")), "truncated")).toBe(
      "snapshot_malformed",
    );
  });

  it("rejects an empty save file", async () => {
    const store = storeOnly();
    await writeRealSave(store, "chan-empty");
    writeFileSync(saveFile("chan-empty"), "", "utf8");

    expect(expectErrCode(await store.load(asGameId("chan-empty")), "empty")).toBe(
      "snapshot_malformed",
    );
  });

  it("rejects a save written by a schema version it does not speak", async () => {
    const store = storeOnly();
    const snapshot = await writeRealSave(store, "chan-future");
    const raw = JSON.parse(readSave("chan-future")) as Record<string, unknown>;
    raw.schemaVersion = SNAPSHOT_SCHEMA_VERSION + 1;
    writeFileSync(saveFile("chan-future"), JSON.stringify(raw), "utf8");

    const loaded = await store.load(asGameId("chan-future"));
    expect(expectErrCode(loaded, "future schema")).toBe("snapshot_version_unsupported");
    // Belt and braces: the rejection is about the version, not about the game being broken.
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  });

  it("rejects a foreign JSON document that merely happens to sit in the saves directory", async () => {
    const store = storeOnly();
    writeFileSync(
      saveFile("chan-foreign"),
      JSON.stringify({ hello: "world", players: ["nope"] }),
      "utf8",
    );

    expect(expectErrCode(await store.load(asGameId("chan-foreign")), "foreign")).toBe(
      "snapshot_malformed",
    );
  });

  it("refuses to build a save path from a game id that is not a plain identifier", async () => {
    // `invalid_game_id`, NOT `snapshot_malformed`. A rejected game id has nothing to do with a
    // snapshot, and while the two shared a code the one grep an operator runs to find a corrupt
    // save also returned every rejected id and every stale button press.
    const store = storeOnly();
    for (const nasty of [
      "../../etc/passwd",
      "/absolute",
      "chan/../..",
      "with space",
      "",
    ]) {
      const loaded = await store.load(asGameId(nasty));
      expect(expectErrCode(loaded, `load ${nasty}`)).toBe("invalid_game_id");
      const deleted = await store.delete(asGameId(nasty));
      expect(expectErrCode(deleted, `delete ${nasty}`)).toBe("invalid_game_id");
    }
  });

  it("lists a corrupt save with its problem and skips it at boot without creating a session", async () => {
    const { registry, store, channels } = harness(["chan-good", "chan-bad"]);
    const [good, bad] = channels as [FakeChannel, FakeChannel];

    const live = expectOk(
      registry.create({ channel: good.as(), hostId: pid("a"), seed: SEED }),
      "create good",
    );
    startGame(live, ["a", "b", "c"]);
    await store.flushAll();
    await registry.disposeAll();

    writeFileSync(saveFile("chan-bad"), "not a snapshot", "utf8");

    const listed = await store.listSaves();
    const badRow = listed.find((row) => row.gameId === "chan-bad");
    const goodRow = listed.find((row) => row.gameId === "chan-good");
    expect(badRow?.problem).toBe("snapshot_malformed");
    expect(goodRow?.problem).toBeNull();

    const report = await registry.restoreAll();
    expect(report.restored).toEqual(["chan-good"]);
    expect(report.skipped).toEqual([
      { gameId: "chan-bad", reason: "snapshot_malformed" },
    ]);
    expect(registry.get("chan-bad")).toBeNull();
    expect(registry.get("chan-good")).not.toBeNull();
    expect(bad.sent).toHaveLength(0);
  });

  it("refuses to resume a save whose game had already ended, and deletes it", async () => {
    const { registry, store, channels } = harness(["chan-corpse"]);
    const channel = channels[0]!;
    const game = loneGame("chan-corpse", ["a", "b", "c"]);
    expectOk(game.dispatch({ type: "start_game", actor: pid("a") }, NOW), "start");
    expectOk(game.dispatch({ type: "abandon_game", actor: pid("a") }, NOW), "abandon");
    store.scheduleSave(game.snapshot());
    await store.flushAll();
    expect(existsSync(saveFile("chan-corpse"))).toBe(true);

    const restored = await registry.restore(channel.as());

    expect(expectErrCode(restored, "restore corpse")).toBe("game_finished");
    expect(registry.size).toBe(0);
    expect(existsSync(saveFile("chan-corpse"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("a save round-trips a live game", () => {
  it("restores a mid-council game that then keeps playing identically", async () => {
    const { registry, store, channels } = harness(["chan-council"]);
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    driveToCouncil(session);
    openVoting(session);

    // One vote already in the box: a mid-council save has to carry it.
    const firstVoter = pid("b");
    apply(session, {
      type: "cast_vote",
      actor: firstVoter,
      target: pid("a"),
      cardUid: firstPlayable(session, firstVoter, "cast_vote"),
    });
    expect(session.view().council?.phase).toBe("voting");

    const before = session.snapshot();
    const control = expectOk(restoreGame(cloneThroughJson(before)), "control restore");

    // The shutdown path: drain every write, drop the session, come back off the disk.
    await store.flushAll();
    await registry.disposeAll();
    expect(registry.size).toBe(0);
    expect(existsSync(saveFile("chan-council"))).toBe(true);

    const downAtMs = Date.now();
    const resumed = expectOk(await registry.restore(channel.as()), "restore");
    expect(withoutDeadlines(resumed.snapshot().state)).toEqual(
      withoutDeadlines(before.state),
    );
    expectWindowsSurvivedTheRestore(resumed.snapshot().state, before.state, downAtMs);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    // Now play on, the same moves in both, and demand the same state out of each.
    const remaining: readonly PlayerId[] = [pid("c"), pid("a")];
    for (const voter of remaining) {
      const uid = firstPlayable(resumed, voter, "cast_vote");
      apply(resumed, {
        type: "cast_vote",
        actor: voter,
        target: pid("a"),
        cardUid: uid,
      });
      expectOk(
        control.dispatch(
          { type: "cast_vote", actor: voter, target: pid("a"), cardUid: uid },
          Date.now(),
        ),
        "control vote",
      );
    }

    expect(resumed.snapshot().state).toEqual(control.state());
    expect(resumed.view()).toEqual(control.view());
    expect(resumed.view().council?.voteCount).toBe(3);
    // The box is still shut: a restored council must not leak who voted for whom.
    expect(resumed.view().council?.revealedVotes).toBeNull();
    // Hands, vote cards and "what I have been shown" all came back with it.
    for (const player of ["a", "b", "c"]) {
      expect(resumed.privateView(pid(player))).toEqual(
        control.privateView(pid(player)),
      );
    }

    await store.flushAll();
    const onDisk = expectOk(await store.load(asGameId("chan-council")), "reload");
    expect(onDisk.state).toEqual(resumed.snapshot().state);
  });

  it("leaves the NEWEST snapshot on disk when dispose races an in-flight write", async () => {
    // `GameSession.dispose()` promises "the save is flushed, not deleted, so `/survivor resume`
    // can pick it up", and `SessionRegistry.disposeAll()` promises the game "comes back exactly
    // where it was". Both of those are promises about the bytes on disk once the returned
    // promise has resolved — a shutdown exits the process immediately afterwards.
    //
    // The shape below is what a real shutdown looks like on a slow disk: one autosave write is
    // still in flight, a second debounced flush is queued behind it, and THEN the signal lands.
    const { registry, store, channels } = harness(["chan-shutdown"]);
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);

    // First debounced flush fires: its write is now in flight (nothing has awaited yet).
    vi.advanceTimersByTime(DEBOUNCE);

    // The game moves on, so a newer snapshot is queued behind that write...
    const actor = onTurn(session);
    apply(session, {
      type: "steal_random",
      actor,
      target: firstTarget(session, actor, "steal_random"),
    });
    const newest = session.snapshot().state;
    // ...and its debounce fires too, so two flushes are now waiting on the same write.
    vi.advanceTimersByTime(DEBOUNCE);

    await registry.disposeAll();

    const onDisk = expectOk(
      await store.load(asGameId("chan-shutdown")),
      "load after shutdown",
    );
    expect(onDisk.state).toEqual(newest);
    expect(store.hasPendingWrites).toBe(false);
  });

  it("flushes rather than deletes on disposeAll, so the channel's game survives a restart", async () => {
    const { registry, store, channels } = harness(["chan-restart"]);
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    const actor = onTurn(session);
    apply(session, {
      type: "steal_random",
      actor,
      target: firstTarget(session, actor, "steal_random"),
    });
    vi.advanceTimersByTime(TAKE_WINDOW + 1);
    await session.drain();
    const before = session.snapshot().state;

    await registry.disposeAll();

    expect(registry.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(saveFile("chan-restart"))).toBe(true);
    expect(store.hasPendingWrites).toBe(false);

    const downAtMs = Date.now();
    const resumed = expectOk(await registry.restore(channel.as()), "restore");
    expect(withoutDeadlines(resumed.snapshot().state)).toEqual(
      withoutDeadlines(before),
    );
    expectWindowsSurvivedTheRestore(resumed.snapshot().state, before, downAtMs);
    expect(resumed.view().turn?.phase).toBe("play");
    // The restored session is armed again, and its timer still expires things.
    expect(resumed.game.nextDeadline()?.reason).toBe("turn");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not forfeit an open window because the bot was redeployed", async () => {
    // Deadlines are absolute epoch milliseconds. A restore that rebased none of them expired
    // EVERY open window the moment the game came back — and every window in the game is shorter
    // than a deploy: a `take` is 20s, a `challenge`/`discard`/`card_choice` is 60s, the idol
    // window is 45s. The victim of a steal never got to answer it; a player holding an Immunity
    // Idol watched the council resolve in three seconds without ever being shown a button.
    const { registry, store, channels } = harness(["chan-deploy"]);
    const channel = channels[0]!;
    const session = expectOk(
      registry.create({ channel: channel.as(), hostId: pid("a"), seed: SEED }),
      "create",
    );
    startGame(session, ["a", "b", "c"]);
    const actor = onTurn(session);
    apply(session, {
      type: "steal_random",
      actor,
      target: firstTarget(session, actor, "steal_random"),
    });

    // The victim's Sorry For You! window is open with its full 20 seconds to run.
    const open = session.view().openPending;
    expect(open, "the steal must open a take window").toHaveLength(1);
    await store.flushAll();
    await registry.disposeAll();

    // The bot is away for ten minutes: thirty times the length of that window.
    const downtime = 10 * 60_000;
    vi.advanceTimersByTime(downtime);
    const backAtMs = Date.now();

    const resumed = expectOk(await registry.restore(channel.as()), "restore");
    const reopened = resumed.view().openPending;
    expect(reopened, "the window must come back, not be forfeited").toHaveLength(1);
    expect(reopened[0]?.kind).toBe("take");
    expect(reopened[0]?.deadlineMs ?? 0).toBeGreaterThan(backAtMs);
    // …and with no more than its own configured length, so a restart is not a free extension.
    expect((reopened[0]?.deadlineMs ?? 0) - backAtMs).toBeLessThanOrEqual(TAKE_WINDOW);

    // A tick at the moment of the restore must not close it.
    resumed.tick(backAtMs);
    expect(resumed.view().openPending).toHaveLength(1);

    // It still expires on its own schedule afterwards.
    vi.advanceTimersByTime(TAKE_WINDOW + 1);
    expect(resumed.view().openPending).toHaveLength(0);
  });
});
