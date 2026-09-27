/**
 * CASTAWAYS: WHO IS ON EACH SURVIVOR CHARACTER CARD
 *
 * Every player's two Survivor Character Cards are their lives. Each one carries a castaway — a
 * name the player picks in the lobby, or a legend dealt at random when the game begins — and the
 * castaways are lost in order: #1 is on the first card turned over, #2 is the last life.
 *
 * What is held here, and why each one matters:
 *
 *  - The names a table will print are safe to print: nothing that pings, formats or links.
 *  - The engine, not the layer that collected them, enforces every rule about names: count,
 *    form, no castaway twice at one table, no blank once the game is under way, and no renaming
 *    a castaway who has already been voted out.
 *  - Blanks are dealt as the game begins, deterministically, WITHOUT touching the game's own
 *    random stream — naming castaways must never change a shuffle or a steal.
 *  - The flip names the castaway it turned over, and the public view shows who is voted out.
 *  - A save from before castaways existed (schema 1) still loads.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  CASTAWAY_NAME_MAX_LENGTH,
  LEGENDARY_CASTAWAYS,
  castawayKey,
  dealCastaways,
  isValidCastawayName,
  sanitizeCastawayName,
} from "../src/engine/castaways.js";
import type { GameEvent } from "../src/engine/events.js";
import { createGame, restoreGame } from "../src/engine/game.js";
import {
  createSnapshot,
  parseSnapshot,
  serializeSnapshot,
} from "../src/engine/snapshot.js";
import {
  CardKind,
  SNAPSHOT_SCHEMA_VERSION,
  asGameId,
  asPendingId,
  asPlayerId,
  councilOf,
  type Action,
  type Game,
  type GameErrorCode,
  type PlayerId,
} from "../src/engine/types.js";

const SEED = 31_337;
const P: readonly PlayerId[] = ["p0", "p1", "p2", "p3"].map(asPlayerId);

let clock = 1_700_000_000_000;
const now = (): number => (clock += 1_000);

function lobby(players = 4, seed = SEED): Game {
  const game = createGame({
    gameId: asGameId("castaway-suite"),
    hostId: P[0]!,
    config: DEFAULT_CONFIG.engine,
    nowMs: now(),
    seed,
  });
  for (let i = 0; i < players; i += 1) {
    must(game, { type: "join_game", actor: P[i]!, displayName: `P${i}` });
  }
  return game;
}

function must(game: Game, action: Action): readonly GameEvent[] {
  const out = game.dispatch(action, now());
  if (!out.ok)
    throw new Error(`${action.type}: ${out.error.code} — ${out.error.message}`);
  return out.value.events;
}

function refused(game: Game, action: Action): GameErrorCode {
  const before = JSON.stringify(game.state());
  const out = game.dispatch(action, now());
  if (out.ok) throw new Error(`${action.type} was accepted`);
  // A refusal changes nothing.
  expect(JSON.stringify(game.state())).toBe(before);
  return out.error.code;
}

const name = (actor: PlayerId, castaways: readonly (string | null)[]): Action => ({
  type: "name_castaways",
  actor,
  castaways,
});

const castawaysOf = (game: Game, seat: number): readonly (string | null)[] =>
  game.state().players[seat]!.castaways;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("a castaway name", () => {
  it("keeps letters, numbers, spaces and simple punctuation, and nothing that pings or formats", () => {
    expect(sanitizeCastawayName("  Boston   Rob  ")).toBe("Boston Rob");
    expect(sanitizeCastawayName("Sandra Diaz-Twine")).toBe("Sandra Diaz-Twine");
    expect(sanitizeCastawayName("J.T. Thomas")).toBe("J.T. Thomas");
    expect(sanitizeCastawayName("Ricard Foyé")).toBe("Ricard Foyé");
    expect(sanitizeCastawayName("@everyone")).toBe("everyone");
    expect(sanitizeCastawayName("<@123456789012345678>")).toBe("123456789012345678");
    expect(sanitizeCastawayName("**Parvati** `x` ~~y~~ [z](https://e.x)")).toBe(
      "Parvati x y z(httpse.x)",
    );
    expect(sanitizeCastawayName("🔥🔥")).toBe("");
  });

  it("is at most CASTAWAY_NAME_MAX_LENGTH characters", () => {
    const long = "A".repeat(CASTAWAY_NAME_MAX_LENGTH + 10);
    expect(sanitizeCastawayName(long)).toHaveLength(CASTAWAY_NAME_MAX_LENGTH);
    expect(isValidCastawayName(long)).toBe(false);
  });

  it("is valid only if it is already in the form the table prints", () => {
    expect(isValidCastawayName("Parvati Shallow")).toBe(true);
    expect(isValidCastawayName("")).toBe(false);
    expect(isValidCastawayName(" Parvati")).toBe(false);
    expect(isValidCastawayName("<@1>")).toBe(false);
  });

  it("every legend on the roster is a valid, distinct castaway", () => {
    for (const legend of LEGENDARY_CASTAWAYS)
      expect(isValidCastawayName(legend)).toBe(true);
    const keys = LEGENDARY_CASTAWAYS.map(castawayKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// The lobby
// ---------------------------------------------------------------------------

describe("picking castaways in the lobby", () => {
  it("starts every player with one blank per Survivor Character Card", () => {
    const game = lobby();
    for (let seat = 0; seat < 4; seat += 1) {
      expect(castawaysOf(game, seat)).toEqual([null, null]);
    }
    expect(game.view().players[0]!.castaways).toEqual([
      { name: null, cardUid: null, votedOut: false, votedOutAtSeq: null },
      { name: null, cardUid: null, votedOut: false, votedOutAtSeq: null },
    ]);
  });

  it("records the pick, publicly, and a blank may be left for a legend", () => {
    const game = lobby();
    const events = must(game, name(P[1]!, ["Parvati Shallow", null]));
    expect(castawaysOf(game, 1)).toEqual(["Parvati Shallow", null]);
    const named = events.find((event) => event.type === "castaways_named");
    expect(named).toMatchObject({
      playerId: P[1],
      castaways: ["Parvati Shallow", null],
      reason: "picked",
      audience: { kind: "public" },
    });
  });

  it("is offered to everyone at the fire", () => {
    const game = lobby();
    for (const id of P) {
      expect(game.legalActions(id, now()).map((action) => action.kind)).toContain(
        "name_castaways",
      );
    }
  });

  it("treats sending the same names again as no change at all", () => {
    const game = lobby();
    must(game, name(P[1]!, ["Parvati Shallow", "Tony Vlachos"]));
    const again = game.dispatch(
      name(P[1]!, ["Parvati Shallow", "Tony Vlachos"]),
      now(),
    );
    if (!again.ok) throw new Error(`refused: ${again.error.code}`);
    expect(again.value.changed).toBe(false);
    expect(again.value.events).toEqual([]);
  });

  it("refuses the wrong number of castaways", () => {
    const game = lobby();
    expect(refused(game, name(P[1]!, ["Parvati Shallow"]))).toBe(
      "castaway_name_invalid",
    );
    expect(refused(game, name(P[1]!, ["A", "B", "C"]))).toBe("castaway_name_invalid");
  });

  it("refuses a name the table could not safely print", () => {
    const game = lobby();
    for (const bad of ["", "   ", "@everyone", "<@123>", "**Rob**", "A".repeat(41)]) {
      expect(refused(game, name(P[1]!, [bad, null]))).toBe("castaway_name_invalid");
    }
  });

  it("refuses the same castaway twice, in one hand or across the table, whatever the case", () => {
    const game = lobby();
    expect(refused(game, name(P[1]!, ["Tony Vlachos", "tony vlachos"]))).toBe(
      "castaway_name_taken",
    );
    must(game, name(P[2]!, ["Tony Vlachos", null]));
    expect(refused(game, name(P[1]!, ["TONY VLACHOS", null]))).toBe(
      "castaway_name_taken",
    );
    // Keeping your own castaway is not taking it from yourself.
    must(game, name(P[2]!, ["Tony Vlachos", "Sandra Diaz-Twine"]));
  });

  it("refuses somebody who is not at the table", () => {
    const game = lobby();
    expect(refused(game, name(asPlayerId("stranger"), ["A", "B"]))).toBe("not_in_game");
  });
});

// ---------------------------------------------------------------------------
// The deal
// ---------------------------------------------------------------------------

describe("the deal when the game begins", () => {
  it("fills every blank with a legend, keeps every pick, and repeats nobody", () => {
    const game = lobby();
    must(game, name(P[0]!, ["Sandra Diaz-Twine", null]));
    must(game, name(P[2]!, ["My Cousin Vinny", "Parvati Shallow"]));
    const events = must(game, { type: "start_game", actor: P[0]!, firstPlayer: P[0]! });

    const all = game.state().players.map((player) => player.castaways);
    expect(all[0]![0]).toBe("Sandra Diaz-Twine");
    expect(all[2]).toEqual(["My Cousin Vinny", "Parvati Shallow"]);
    const names = all.flat();
    expect(names.every((castaway) => typeof castaway === "string")).toBe(true);
    const keys = names.map((castaway) => castawayKey(castaway!));
    expect(new Set(keys).size).toBe(names.length);
    for (const dealt of [all[0]![1], ...all[1]!, ...all[3]!]) {
      expect(LEGENDARY_CASTAWAYS).toContain(dealt);
    }

    const deals = events.filter((event) => event.type === "castaways_named");
    expect(deals.map((event) => event.playerId)).toEqual(P);
    expect(deals.every((event) => event.reason === "dealt")).toBe(true);
  });

  it("deals the same legends from the same seed", () => {
    const deal = (): readonly (readonly (string | null)[])[] => {
      const game = lobby();
      must(game, { type: "start_game", actor: P[0]!, firstPlayer: P[0]! });
      return game.state().players.map((player) => player.castaways);
    };
    expect(deal()).toEqual(deal());
  });

  it("never touches the game's own random stream: picking castaways changes no shuffle", () => {
    const picked = lobby();
    must(picked, name(P[1]!, ["Parvati Shallow", "Tony Vlachos"]));
    must(picked, { type: "start_game", actor: P[0]! });
    const blank = lobby();
    must(blank, { type: "start_game", actor: P[0]! });

    expect(picked.state().rng).toEqual(blank.state().rng);
    expect(picked.state().zones.drawPile).toEqual(blank.state().zones.drawPile);
    expect(picked.view().turn?.playerId).toBe(blank.view().turn?.playerId);
  });

  it("is total even when a table outnumbers the roster", () => {
    const blanks = Array.from({ length: 80 }, () => [null, null]);
    const dealt = dealCastaways(blanks, SEED).flat();
    expect(new Set(dealt.map(castawayKey)).size).toBe(dealt.length);
    expect(dealt).toContain("Castaway 1");
  });
});

// ---------------------------------------------------------------------------
// During the game
// ---------------------------------------------------------------------------

/**
 * A 4-player game whose next draw is a Single Elimination Tribal Council, driven through the
 * public surface only: the council card is moved to the top of the draw pile through the
 * snapshot boundary, exactly as the elimination suite rigs its deals.
 */
function councilGame(): Game {
  const game = lobby();
  must(game, name(P[1]!, ["Sandra Diaz-Twine", "Tony Vlachos"]));
  must(game, { type: "start_game", actor: P[0]!, firstPlayer: P[0]! });

  const raw = JSON.parse(
    JSON.stringify(serializeSnapshot(createSnapshot(game.state(), now()))),
  ) as {
    state: {
      cards: { uid: string; kind: string }[];
      zones: { drawPile: string[]; discardPile: string[] };
    };
  };
  const pile = raw.state.zones.drawPile;
  const at = pile.findIndex(
    (uid) =>
      raw.state.cards.find((card) => card.uid === uid)?.kind ===
      CardKind.TribalCouncilSingle,
  );
  if (at < 0) throw new Error("no single-elimination council card in the pile");
  pile.unshift(...pile.splice(at, 1));
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const restored = restoreGame(parsed.value);
  if (!restored.ok) throw new Error(restored.error.message);
  return restored.value;
}

/** P0 steals from P3 (let through), skips, and draws the council card. Everyone votes P1. */
function voteOutP1(game: Game): readonly GameEvent[] {
  must(game, { type: "steal_random", actor: P[0]!, target: P[3]! });
  const take = game.state().pending.find((pending) => pending.kind === "take");
  if (take) {
    must(game, {
      type: "decline_reaction",
      actor: P[3]!,
      pendingId: asPendingId(take.id),
    });
  }
  must(game, { type: "skip_play_step", actor: P[0]! });
  must(game, { type: "draw_card", actor: P[0]! });
  const events: GameEvent[] = [];
  const advance = (): void => {
    const council = councilOf(game.state().stage);
    if (!council) throw new Error("no council");
    events.push(
      ...must(game, {
        type: "advance_council",
        actor: council.leaderId,
        from: council.phase,
      }),
    );
  };
  while (councilOf(game.state().stage)?.phase !== "voting") advance();
  for (const player of game.state().players) {
    const card = player.voteCards[0];
    if (!card) continue;
    const target = player.id === P[1]! ? P[0]! : P[1]!;
    events.push(
      ...must(game, { type: "cast_vote", actor: player.id, cardUid: card, target }),
    );
  }
  for (const player of game.state().players) {
    events.push(...must(game, { type: "finish_voting", actor: player.id }));
  }
  while (
    councilOf(game.state().stage) &&
    councilOf(game.state().stage)?.phase !== "cleanup"
  )
    advance();
  return events;
}

describe("castaways during the game", () => {
  it("loses castaway #1 first, names it on the flip, and shows it voted out", () => {
    const game = councilGame();
    const events = voteOutP1(game);

    const flip = events.find((event) => event.type === "character_card_flipped");
    expect(flip).toMatchObject({ playerId: P[1], castaway: "Sandra Diaz-Twine" });
    const [first, second] = game.view().players[1]!.castaways;
    expect(first).toMatchObject({ name: "Sandra Diaz-Twine", votedOut: true });
    expect(first?.votedOutAtSeq).not.toBeNull();
    // The flip names the very card the view shows turned over.
    expect(flip?.type === "character_card_flipped" && flip.cardUid).toBe(
      first?.cardUid,
    );
    expect(second).toMatchObject({
      name: "Tony Vlachos",
      votedOut: false,
      votedOutAtSeq: null,
    });
    expect(second?.cardUid).not.toBeNull();
  });

  it("may rename a castaway still in the game, but not one already voted out, and not to a blank", () => {
    const game = councilGame();
    voteOutP1(game);

    expect(refused(game, name(P[1]!, ["Sandra Diaz-Twine", null]))).toBe(
      "castaway_name_invalid",
    );
    expect(refused(game, name(P[1]!, ["Somebody Else", "Tony Vlachos"]))).toBe(
      "castaway_voted_out",
    );
    const events = must(game, name(P[1]!, ["Sandra Diaz-Twine", "Q Burdette"]));
    expect(events.find((event) => event.type === "castaways_named")).toMatchObject({
      reason: "renamed",
      castaways: ["Sandra Diaz-Twine", "Q Burdette"],
    });
  });
});

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

describe("castaways in a save", () => {
  const wire = (game: Game): Record<string, unknown> =>
    JSON.parse(JSON.stringify(serializeSnapshot(game.snapshot()))) as Record<
      string,
      unknown
    >;

  /** The same save as a schema-1 file would have held it: no castaways anywhere. */
  function asVersion1(game: Game): Record<string, unknown> {
    const raw = wire(game);
    const state = raw.state as { players: Record<string, unknown>[] };
    for (const player of state.players) delete player.castaways;
    return { ...raw, schemaVersion: 1 };
  }

  it("round-trips every castaway", () => {
    const game = lobby();
    must(game, name(P[1]!, ["Parvati Shallow", null]));
    const parsed = parseSnapshot(wire(game));
    expect(parsed.ok && parsed.value.state.players[1]!.castaways).toEqual([
      "Parvati Shallow",
      null,
    ]);
  });

  it("refuses a current-version save whose castaways do not line up with its cards", () => {
    const game = lobby();
    must(game, { type: "start_game", actor: P[0]! });
    const raw = wire(game);
    const state = raw.state as { players: { castaways: unknown }[] };
    state.players[0]!.castaways = ["Only One"];
    const parsed = parseSnapshot(raw);
    expect(!parsed.ok && parsed.error.code).toBe("snapshot_malformed");
    state.players[0]!.castaways = [7, null];
    const again = parseSnapshot(raw);
    expect(!again.ok && again.error.code).toBe("snapshot_malformed");
  });

  it("upgrades a version-1 lobby with blanks, to be dealt when the game begins", () => {
    const parsed = parseSnapshot(asVersion1(lobby()));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    for (const player of parsed.value.state.players) {
      expect(player.castaways).toEqual([null, null]);
    }
    const restored = restoreGame(parsed.value);
    expect(restored.ok).toBe(true);
  });

  it("upgrades a version-1 game in progress with legends, the same ones every time", () => {
    const game = lobby();
    must(game, { type: "start_game", actor: P[0]! });
    const first = parseSnapshot(asVersion1(game));
    const second = parseSnapshot(asVersion1(game));
    if (!first.ok || !second.ok) throw new Error("a version-1 save did not load");
    const names = first.value.state.players.flatMap((player) => player.castaways);
    expect(names.every((castaway) => typeof castaway === "string")).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(second.value.state.players.map((player) => player.castaways)).toEqual(
      first.value.state.players.map((player) => player.castaways),
    );
    const restored = restoreGame(first.value);
    expect(restored.ok && restored.value.view().players[0]!.castaways[0]?.name).toBe(
      names[0],
    );
  });
});
