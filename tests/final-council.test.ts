/**
 * THE FINAL TRIBAL COUNCIL.
 *
 * docs/RULES.md:134 — "The moment there are only 2 players left in the game, regardless of how
 * many Survivor Character Cards they have left, it's time to IMMEDIATELY start the Final Tribal
 * Council to determine the winner of the game." Sidebar: "This could happen when you get to the
 * bottom of the Draw Pile, at a Single Elimination Tribal Council, or at a Double Elimination
 * Tribal Council after just the first player is voted out."
 *
 * Every test drives the REAL reducer through REAL actions. Scenarios are set up by taking a
 * genuine post-`start_game` snapshot, adjusting only things a real game could have produced
 * (which Tribal Council card is on top of the pile, how many torches a player has left, which
 * cards are in a hand, how much of the pile is gone) and restoring it through `parseSnapshot` +
 * `restoreGame`, which re-validate the card census. Nothing is stubbed and nothing is mocked.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import type { GameEvent } from "../src/engine/events.js";
import { censusOf, createGame, restoreGame } from "../src/engine/game.js";
import { parseSnapshot } from "../src/engine/snapshot.js";
import {
  asGameId,
  asPlayerId,
  isOk,
  type Action,
  type CardUid,
  type DispatchOutcome,
  type FinalCouncilView,
  type Game,
  type PlayerId,
  type Result,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Fixed clock and fixed seed: every test in this file is deterministic. */
const T0 = 1_700_000_000_000;
const SEED = 20250909;
const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eve", "Fay"] as const;

const pid = (name: string): PlayerId => asPlayerId(`u-${name}`);

/** The parts of a serialized snapshot these tests reshape. */
interface MutableState {
  seq: number;
  cards: { uid: string; kind: string; color?: string }[];
  players: {
    id: string;
    displayName: string;
    color: string;
    seat: number;
    hand: string[];
    voteCards: string[];
    grantedVotes: string[];
    characterCards: { uid: string; flipped: boolean; flippedAtSeq: number | null }[];
  }[];
  zones: Record<
    | "drawPile"
    | "discardPile"
    | "removedFromGame"
    | "voteCardBank"
    | "votingBox"
    | "inPlay",
    string[]
  >;
}

interface Table {
  game: Game;
  now: number;
  /** Every event produced by every dispatch/tick, in order. */
  log: GameEvent[];
}

function unwrap<T>(result: Result<T>, what: string): T {
  if (!isOk(result)) {
    throw new Error(
      `${what} was refused: ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.value;
}

function newTable(playerCount: number): Table {
  const ids = NAMES.slice(0, playerCount).map((n) => pid(n));
  const game = createGame({
    gameId: asGameId("final-council-test"),
    hostId: ids[0] as PlayerId,
    config: DEFAULT_CONFIG.engine,
    nowMs: T0,
    seed: SEED,
  });
  const table: Table = { game, now: T0, log: [] };
  ids.forEach((id, i) => {
    act(table, { type: "join_game", actor: id, displayName: NAMES[i] as string });
  });
  act(table, {
    type: "start_game",
    actor: ids[0] as PlayerId,
    firstPlayer: ids[0] as PlayerId,
  });
  return table;
}

/** Dispatch and require success. */
function act(table: Table, action: Action): DispatchOutcome {
  table.now += 1000;
  const outcome = unwrap(table.game.dispatch(action, table.now), action.type);
  table.log.push(...outcome.events);
  return outcome;
}

/** Dispatch and return the Result untouched, for the rejection tests. */
function attempt(table: Table, action: Action): Result<DispatchOutcome> {
  table.now += 1000;
  const result = table.game.dispatch(action, table.now);
  if (isOk(result)) table.log.push(...result.value.events);
  return result;
}

function tick(table: Table, atMs: number): DispatchOutcome {
  table.now = atMs;
  const outcome = unwrap(table.game.tick(atMs), "tick");
  table.log.push(...outcome.events);
  return outcome;
}

const events = (table: Table, type: GameEvent["type"]): GameEvent[] =>
  table.log.filter((e) => e.type === type);

const lastEvent = <T extends GameEvent["type"]>(
  table: Table,
  type: T,
): Extract<GameEvent, { type: T }> => {
  const found = [...table.log].reverse().find((e) => e.type === type);
  if (!found) throw new Error(`no ${type} event was ever emitted`);
  return found as Extract<GameEvent, { type: T }>;
};

const kindOf = (table: Table, uid: CardUid): string =>
  table.game.card(uid)?.kind ?? "unknown";

const playerOf = (table: Table, name: string) => {
  const found = table.game.state().players.find((p) => p.id === pid(name));
  if (!found) throw new Error(`no player ${name}`);
  return found;
};

const voteCardOf = (table: Table, name: string): CardUid => {
  const uid = playerOf(table, name).voteCards[0];
  if (!uid) throw new Error(`${name} has no Vote Card`);
  return uid;
};

const finalCouncil = (table: Table): FinalCouncilView => {
  const view = table.game.view().finalCouncil;
  if (!view)
    throw new Error(`no Final Tribal Council (stage=${table.game.view().stage})`);
  return view;
};

/**
 * Rebuild the table from an adjusted snapshot. Everything goes back through `parseSnapshot`
 * and `restoreGame`, so a scenario that does not balance the card census fails here rather
 * than producing a nonsense test.
 */
function craft(
  table: Table,
  mutate: (state: MutableState, helpers: Helpers) => void,
): void {
  const raw = JSON.parse(JSON.stringify(table.game.snapshot())) as {
    state: MutableState;
  };
  const state = raw.state;
  const kind = (uid: string): string =>
    state.cards.find((c) => c.uid === uid)?.kind ?? "unknown";
  const find = (name: string): MutableState["players"][number] => {
    const player = state.players.find((p) => p.id === `u-${name}`);
    if (!player) throw new Error(`no player ${name}`);
    return player;
  };

  const helpers: Helpers = {
    color: (name) => find(name).color,
    /** Turn over `count` Survivor Character Cards, exactly as a previous council would have. */
    flip(name, count) {
      let done = 0;
      for (const card of find(name).characterCards) {
        if (done >= count) break;
        if (card.flipped) continue;
        card.flipped = true;
        card.flippedAtSeq = state.seq;
        done += 1;
      }
      if (done < count) throw new Error(`${name} has no torch left to flip`);
    },
    /** Bring a Tribal Council card of this kind to the top of the draw pile. */
    councilOnTop(which) {
      const want = `tribal_council_${which}`;
      const inPile = state.zones.drawPile.findIndex((u) => kind(u) === want);
      if (inPile >= 0) {
        const [uid] = state.zones.drawPile.splice(inPile, 1);
        state.zones.drawPile.unshift(uid as string);
        return;
      }
      // At 3 and 4 players some council cards are "put away" at setup; swap one in for one out
      // so the number of councils in the pile is unchanged.
      const spare = state.zones.removedFromGame.findIndex((u) => kind(u) === want);
      if (spare < 0) throw new Error(`no ${want} anywhere`);
      const [uid] = state.zones.removedFromGame.splice(spare, 1);
      const other = state.zones.drawPile.findIndex((u) =>
        kind(u).startsWith("tribal_council"),
      );
      if (other >= 0) {
        const [swapped] = state.zones.drawPile.splice(other, 1);
        state.zones.removedFromGame.push(swapped as string);
      }
      state.zones.drawPile.unshift(uid as string);
    },
    /** Move a card of this kind out of the draw pile and into a hand. */
    deal(name, cardKind) {
      const at = state.zones.drawPile.findIndex((u) => kind(u) === cardKind);
      if (at < 0) throw new Error(`no ${cardKind} left in the draw pile`);
      const [uid] = state.zones.drawPile.splice(at, 1);
      find(name).hand.push(uid as string);
    },
    /** Take a player's Vote Card away, as Control the Vote or an elimination would. */
    removeVoteCard(name) {
      const player = find(name);
      state.zones.voteCardBank.push(...player.voteCards);
      player.voteCards = [];
    },
    /** Send this colour's Inheritance card to the discard pile so no window can open for it. */
    burnInheritance(color) {
      for (const player of state.players) {
        player.hand = player.hand.filter((uid) => {
          const card = state.cards.find((c) => c.uid === uid);
          if (card?.kind === "inheritance" && card.color === color) {
            state.zones.discardPile.push(uid);
            return false;
          }
          return true;
        });
      }
    },
    emptyDrawPile() {
      state.zones.removedFromGame.push(...state.zones.drawPile);
      state.zones.drawPile = [];
    },
  };

  mutate(state, helpers);

  const parsed = parseSnapshot(raw);
  if (!isOk(parsed)) {
    throw new Error(
      `crafted snapshot is invalid: ${parsed.error.code} ${parsed.error.message}`,
    );
  }
  const restored = restoreGame(parsed.value);
  if (!isOk(restored)) {
    throw new Error(`crafted snapshot did not restore: ${restored.error.code}`);
  }
  table.game = restored.value;
}

interface Helpers {
  color(name: string): string;
  flip(name: string, count: number): void;
  councilOnTop(which: "single" | "double"): void;
  deal(name: string, cardKind: string): void;
  removeVoteCard(name: string): void;
  burnInheritance(color: string): void;
  emptyDrawPile(): void;
}

/**
 * Close every window a mid-turn or mid-council action left open, the way the table would:
 * the victim of a take declines Sorry For You, the holder of a matching Inheritance card
 * declines the inheritance. Nothing here uses the clock.
 */
function settle(table: Table): void {
  for (let guard = 0; guard < 16; guard += 1) {
    const state = table.game.state();
    const open = state.pending.filter(
      (p) => p.kind === "take" || p.kind === "inheritance",
    );
    if (open.length === 0) return;
    for (const pending of open) {
      if (pending.kind === "take") {
        act(table, {
          type: "decline_reaction",
          actor: pending.victimId,
          pendingId: pending.id,
        });
        continue;
      }
      if (pending.kind !== "inheritance") continue;
      const holder = state.players.find(
        (p) =>
          p.eliminatedAtSeq === null &&
          p.leftAtSeq === null &&
          p.hand.some((uid) => {
            const card = table.game.card(uid);
            return (
              card?.kind === "inheritance" &&
              "color" in card &&
              card.color === pending.color
            );
          }),
      );
      if (!holder)
        throw new Error(`nobody holds the ${pending.color} Inheritance card`);
      act(table, {
        type: "decline_reaction",
        actor: holder.id,
        pendingId: pending.id,
      });
    }
  }
  throw new Error("windows would not close");
}

/** Steal, skip the play step, draw. The three steps of a turn, in order. */
function takeTurn(table: Table, actorName: string, stealFrom: string): void {
  act(table, { type: "steal_random", actor: pid(actorName), target: pid(stealFrom) });
  settle(table);
  act(table, { type: "skip_play_step", actor: pid(actorName) });
  act(table, { type: "draw_card", actor: pid(actorName) });
  settle(table);
}

/** Run a council from the advantages phase to the tally, casting the votes given. */
function runCouncil(
  table: Table,
  leaderName: string,
  votes: readonly (readonly [string, string])[],
): void {
  const leader = pid(leaderName);
  act(table, { type: "advance_council", actor: leader, from: "advantages" });
  act(table, { type: "advance_council", actor: leader, from: "discussion" });
  for (const [voter, target] of votes) {
    act(table, {
      type: "cast_vote",
      actor: pid(voter),
      cardUid: voteCardOf(table, voter),
      target: pid(target),
    });
  }
  act(table, { type: "advance_council", actor: leader, from: "voting" });
  act(table, { type: "advance_council", actor: leader, from: "idols" });
  settle(table);
}

// ---------------------------------------------------------------------------
// Scenario builders — one per route to two players
// ---------------------------------------------------------------------------

/** 3 players, Single Elimination, Cyd on one torch and voted out. Ari draws and leads. */
function singleEliminationToTwo(): Table {
  const table = newTable(3);
  craft(table, (_state, h) => {
    h.councilOnTop("single");
    h.flip("Cyd", 1);
  });
  takeTurn(table, "Ari", "Bex");
  runCouncil(table, "Ari", [
    ["Ari", "Cyd"],
    ["Bex", "Cyd"],
    ["Cyd", "Ari"],
  ]);
  return table;
}

/**
 * 3 players, Double Elimination, one clear top vote-getter on one torch. The rulebook's
 * "at a Double Elimination Tribal Council after just the first player is voted out".
 */
function doubleEliminationPartialToTwo(): Table {
  const table = newTable(3);
  craft(table, (_state, h) => {
    h.councilOnTop("double");
    h.flip("Bex", 1);
  });
  takeTurn(table, "Ari", "Bex");
  runCouncil(table, "Ari", [
    ["Ari", "Bex"],
    ["Cyd", "Bex"],
    ["Bex", "Ari"],
  ]);
  return table;
}

/**
 * 3 players, Double Elimination, Bex and Cyd both on one torch and tied for most votes — so
 * two players "would be eliminated at the same time (leaving you with only 1 player left)".
 * Ari holds no Vote Card, which is how the vote comes out exactly tied at three players.
 * Leaves the Leader decision OPEN; the caller names who goes.
 */
function threePlayerDoubleOverride(options: { burnInheritance: boolean }): Table {
  const table = newTable(3);
  craft(table, (_state, h) => {
    h.councilOnTop("double");
    h.flip("Bex", 1);
    h.flip("Cyd", 1);
    h.removeVoteCard("Ari");
    if (options.burnInheritance) h.burnInheritance(h.color("Bex"));
  });
  takeTurn(table, "Ari", "Bex");
  runCouncil(table, "Ari", [
    ["Bex", "Cyd"],
    ["Cyd", "Bex"],
  ]);
  return table;
}

/** 4 players, empty draw pile, Ari draws from it. */
function drawPileExhaustedToTwo(deal?: readonly (readonly [string, string])[]): Table {
  const table = newTable(4);
  craft(table, (_state, h) => {
    for (const [name, cardKind] of deal ?? []) h.deal(name, cardKind);
    h.emptyDrawPile();
  });
  act(table, { type: "steal_random", actor: pid("Ari"), target: pid("Bex") });
  settle(table);
  act(table, { type: "skip_play_step", actor: pid("Ari") });
  act(table, { type: "draw_card", actor: pid("Ari") });
  settle(table);
  return table;
}

/** 5 players, empty draw pile: three jurors, so a Jury majority is possible. */
function fivePlayerDrawPileExhausted(): Table {
  const table = newTable(5);
  craft(table, (_state, h) => {
    h.emptyDrawPile();
  });
  act(table, { type: "steal_random", actor: pid("Ari"), target: pid("Bex") });
  settle(table);
  act(table, { type: "skip_play_step", actor: pid("Ari") });
  act(table, { type: "draw_card", actor: pid("Ari") });
  settle(table);
  return table;
}

/** Every juror raises a finger, which opens the Jury vote. */
function openJuryVote(table: Table): FinalCouncilView {
  for (const juror of finalCouncil(table).jury) {
    act(table, { type: "juror_ready", actor: juror });
  }
  return finalCouncil(table);
}

// ---------------------------------------------------------------------------
// 1. Every route to two players starts the Final Tribal Council
// ---------------------------------------------------------------------------

describe("the Final Tribal Council begins the moment two players remain", () => {
  it("starts immediately when a Single Elimination Tribal Council takes the table from 3 players to 2", () => {
    const table = singleEliminationToTwo();

    expect(table.game.view().stage).toBe("final_council");
    const final = finalCouncil(table);
    expect([...final.finalists].sort()).toEqual([pid("Ari"), pid("Bex")].sort());
    expect(final.jury).toEqual([pid("Cyd")]);
    expect(lastEvent(table, "final_council_started").trigger).toBe(
      "single_elimination",
    );
    // The council it interrupted is over: no council view survives alongside the final one.
    expect(table.game.view().council).toBeNull();
  });

  it("interrupts a Double Elimination after just the first player is voted out", () => {
    const table = doubleEliminationPartialToTwo();

    expect(table.game.view().stage).toBe("final_council");
    const final = finalCouncil(table);
    expect([...final.finalists].sort()).toEqual([pid("Ari"), pid("Cyd")].sort());
    expect(final.jury).toEqual([pid("Bex")]);
    expect(lastEvent(table, "final_council_started").trigger).toBe(
      "double_elimination_partial",
    );
    // The second elimination of the double NEVER happens: only one player went home.
    expect(events(table, "player_eliminated")).toHaveLength(1);
    expect(playerOf(table, "Cyd").eliminatedAtSeq).toBeNull();
  });

  it("eliminates only ONE of the tied players when 3 remain and a Double Elimination would leave 1", () => {
    const table = threePlayerDoubleOverride({ burnInheritance: false });

    const decision = table.game
      .state()
      .pending.find((p) => p.kind === "leader_decision");
    expect(decision).toBeDefined();
    if (!decision || decision.kind !== "leader_decision")
      throw new Error("no decision");
    expect(decision.reason).toBe("three_player_double_override");
    expect(decision.leaderId).toBe(pid("Ari"));
    // "the Tribal Council Leader decides which of the TIED players is eliminated"
    expect([...decision.candidates].sort()).toEqual([pid("Bex"), pid("Cyd")].sort());
    expect(decision.choose).toBe(1);

    act(table, {
      type: "leader_choose_eliminations",
      actor: pid("Ari"),
      pendingId: decision.id,
      targets: [pid("Bex")],
    });
    settle(table);

    // "Immediately begin The Final Tribal Council" — with ONE player eliminated, not two.
    expect(table.game.view().stage).toBe("final_council");
    expect(events(table, "player_eliminated")).toHaveLength(1);
    const final = finalCouncil(table);
    expect([...final.finalists].sort()).toEqual([pid("Ari"), pid("Cyd")].sort());
    expect(final.jury).toEqual([pid("Bex")]);
  });

  it("narrates the three-player override as three_player_override even when an Inheritance window intervenes", () => {
    // Same council twice, differing only in whether anyone holds the dead player's colour.
    // The rulebook's special case is the same case either way, so the narration must be too.
    const withoutWindow = threePlayerDoubleOverride({ burnInheritance: true });
    const decisionA = withoutWindow.game
      .state()
      .pending.find((p) => p.kind === "leader_decision");
    if (!decisionA) throw new Error("no decision");
    act(withoutWindow, {
      type: "leader_choose_eliminations",
      actor: pid("Ari"),
      pendingId: decisionA.id,
      targets: [pid("Bex")],
    });
    settle(withoutWindow);
    expect(lastEvent(withoutWindow, "final_council_started").trigger).toBe(
      "three_player_override",
    );

    const withWindow = threePlayerDoubleOverride({ burnInheritance: false });
    const decisionB = withWindow.game
      .state()
      .pending.find((p) => p.kind === "leader_decision");
    if (!decisionB) throw new Error("no decision");
    act(withWindow, {
      type: "leader_choose_eliminations",
      actor: pid("Ari"),
      pendingId: decisionB.id,
      targets: [pid("Bex")],
    });
    settle(withWindow);
    expect(lastEvent(withWindow, "final_council_started").trigger).toBe(
      "three_player_override",
    );
  });

  it("starts when the draw pile runs out, with every non-finalist fully eliminated onto the Jury", () => {
    const table = drawPileExhaustedToTwo();

    expect(table.game.view().stage).toBe("final_council");
    expect(lastEvent(table, "final_council_started").trigger).toBe("draw_pile_empty");
    const final = finalCouncil(table);
    expect(final.jury).toHaveLength(2);
    // Force-eliminated players are FULLY eliminated, so they reach the Jury by the normal path.
    for (const juror of final.jury) {
      const player = table.game.state().players.find((p) => p.id === juror);
      expect(player?.eliminatedAtSeq).not.toBeNull();
      expect(player?.characterCards.every((c) => c.flipped)).toBe(true);
    }
    expect(events(table, "player_eliminated")).toHaveLength(2);
  });

  it("starts when a Double Elimination takes 4 players down to 2", () => {
    const table = newTable(4);
    craft(table, (_state, h) => {
      h.councilOnTop("double");
      h.flip("Bex", 1);
      h.flip("Cyd", 1);
    });
    takeTurn(table, "Ari", "Bex");
    runCouncil(table, "Ari", [
      ["Ari", "Bex"],
      ["Dov", "Cyd"],
      ["Bex", "Cyd"],
      ["Cyd", "Bex"],
    ]);

    expect(table.game.view().stage).toBe("final_council");
    expect(lastEvent(table, "final_council_started").trigger).toBe(
      "double_elimination_complete",
    );
    const final = finalCouncil(table);
    expect([...final.finalists].sort()).toEqual([pid("Ari"), pid("Dov")].sort());
    expect(final.jury).toHaveLength(2);
  });

  it("triggers on player count alone: a finalist may reach the final two on a single torch", () => {
    const table = newTable(3);
    craft(table, (_state, h) => {
      h.councilOnTop("single");
      h.flip("Cyd", 1);
      h.flip("Bex", 1); // Bex survives to the final two with one torch left
    });
    takeTurn(table, "Ari", "Bex");
    runCouncil(table, "Ari", [
      ["Ari", "Cyd"],
      ["Bex", "Cyd"],
      ["Cyd", "Ari"],
    ]);

    expect(table.game.view().stage).toBe("final_council");
    const bex = playerOf(table, "Bex");
    expect(bex.characterCards.filter((c) => !c.flipped)).toHaveLength(1);
    expect(finalCouncil(table).finalists).toContain(pid("Bex"));
    const ari = playerOf(table, "Ari");
    expect(ari.characterCards.filter((c) => !c.flipped)).toHaveLength(2);
  });

  it("leaves every card in the game accounted for when it interrupts a council", () => {
    const table = doubleEliminationPartialToTwo();

    expect(censusOf(table.game.state())).toHaveLength(0);
    // The Tribal Council card and every vote cast are off the table.
    expect(table.game.state().zones.votingBox).toHaveLength(0);
    const snapshot = table.game.snapshot();
    const round = parseSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown);
    expect(isOk(round)).toBe(true);
    if (isOk(round)) expect(round.value.state).toEqual(table.game.state());
  });
});

// ---------------------------------------------------------------------------
// 2. The Jury and the Leader
// ---------------------------------------------------------------------------

describe("the Jury is every fully-eliminated player and its most recent member leads", () => {
  it("seats every fully-eliminated player on the Jury, in elimination order", () => {
    const table = fivePlayerDrawPileExhausted();

    const final = finalCouncil(table);
    const eliminated = table.game
      .state()
      .players.filter((p) => p.eliminatedAtSeq !== null)
      .sort((a, b) => (a.eliminatedAtSeq ?? 0) - (b.eliminatedAtSeq ?? 0))
      .map((p) => p.id);
    expect(eliminated).toHaveLength(3);
    expect(final.jury).toEqual(eliminated);
    // Neither finalist is on the Jury.
    for (const finalist of final.finalists) expect(final.jury).not.toContain(finalist);
  });

  it("makes the most recently eliminated player BOTH a member of the Jury and the Leader", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = finalCouncil(table);

    const mostRecent = table.game
      .state()
      .players.filter((p) => p.eliminatedAtSeq !== null)
      .reduce((latest, p) =>
        (p.eliminatedAtSeq ?? 0) > (latest.eliminatedAtSeq ?? 0) ? p : latest,
      );
    expect(final.leaderId).toBe(mostRecent.id);
    expect(final.jury).toContain(final.leaderId);

    // And the Leader votes like any other juror.
    openJuryVote(table);
    act(table, {
      type: "cast_jury_vote",
      actor: final.leaderId,
      finalist: final.finalists[0],
    });
    expect(finalCouncil(table).castCount).toBe(1);
  });

  it("does not seat a player who left the table on the Jury", () => {
    const table = newTable(4);
    craft(table, (_state, h) => {
      h.councilOnTop("single");
      h.flip("Cyd", 1);
    });
    act(table, { type: "leave_game", actor: pid("Dov") });
    takeTurn(table, "Ari", "Bex");
    runCouncil(table, "Ari", [
      ["Ari", "Cyd"],
      ["Bex", "Cyd"],
      ["Cyd", "Ari"],
    ]);

    const final = finalCouncil(table);
    expect(final.jury).toEqual([pid("Cyd")]);
    expect(final.jury).not.toContain(pid("Dov"));
    expect(final.leaderId).toBe(pid("Cyd"));
    // A departed player has nothing to do at the Final Tribal Council.
    expect(table.game.legalActions(pid("Dov"), table.now)).toEqual([]);
    expect(attempt(table, { type: "juror_ready", actor: pid("Dov") })).toMatchObject({
      ok: false,
      error: { code: "not_a_juror" },
    });
  });

  it("does not seat a player who has lost only one Survivor Character Card on the Jury", () => {
    const table = newTable(3);
    craft(table, (_state, h) => {
      h.councilOnTop("single");
      h.flip("Cyd", 1);
      h.flip("Bex", 1);
    });
    takeTurn(table, "Ari", "Bex");
    runCouncil(table, "Ari", [
      ["Ari", "Cyd"],
      ["Bex", "Cyd"],
      ["Cyd", "Ari"],
    ]);

    expect(finalCouncil(table).jury).toEqual([pid("Cyd")]);
    expect(playerOf(table, "Bex").eliminatedAtSeq).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Finalists: no cards, but they may reveal their hands
// ---------------------------------------------------------------------------

describe("the final two can't play any cards, but they can reveal their hands", () => {
  const withIdolAndExtraVote = (): Table =>
    drawPileExhaustedToTwo([
      ["Ari", "immunity_idol"],
      ["Ari", "extra_vote"],
    ]);

  it("makes an Immunity Idol inert in a finalist's hand", () => {
    const table = withIdolAndExtraVote();
    const idol = playerOf(table, "Ari").hand.find(
      (uid) => kindOf(table, uid) === "immunity_idol",
    );
    expect(idol).toBeDefined();
    const before = table.game.state();

    const result = attempt(table, {
      type: "play_immunity_idol",
      actor: pid("Ari"),
      cardUid: idol as CardUid,
      protects: pid("Ari"),
    });

    expect(isOk(result)).toBe(false);
    // Inert means inert: the card is still in hand and nothing about the game moved.
    expect(table.game.state()).toBe(before);
    expect(playerOf(table, "Ari").hand).toContain(idol);
    expect(table.game.view().stage).toBe("final_council");
  });

  it("makes an Extra Vote inert in a finalist's hand", () => {
    const table = withIdolAndExtraVote();
    const extra = playerOf(table, "Ari").hand.find(
      (uid) => kindOf(table, uid) === "extra_vote",
    );
    expect(extra).toBeDefined();
    const before = table.game.state();

    const result = attempt(table, {
      type: "cast_vote",
      actor: pid("Ari"),
      cardUid: extra as CardUid,
      target: pid("Bex"),
    });

    expect(isOk(result)).toBe(false);
    expect(table.game.state()).toBe(before);
    expect(playerOf(table, "Ari").hand).toContain(extra);
  });

  it("offers a finalist no card play at all — only the reveal", () => {
    const table = withIdolAndExtraVote();

    const offered = table.game
      .legalActions(pid("Ari"), table.now)
      .map((a) => a.kind)
      // Host housekeeping — ending the game, handing the role on — is not a card play.
      .filter((kind) => kind !== "abandon_game" && kind !== "transfer_host");

    expect(offered).toEqual(["reveal_hand"]);
    expect(offered.some((k) => k.startsWith("play_"))).toBe(false);
  });

  it("lets a finalist reveal their whole hand as evidence, publicly", () => {
    const table = withIdolAndExtraVote();
    const hand = [...playerOf(table, "Ari").hand];

    act(table, { type: "reveal_hand", actor: pid("Ari") });

    const revealed = lastEvent(table, "finalist_hand_revealed");
    expect(revealed.playerId).toBe(pid("Ari"));
    expect(revealed.cards.map((c) => c.uid)).toEqual(hand);
    // "Making it to the final two with an unused Immunity Idol … takes a lot of skill"
    expect(revealed.cards.map((c) => c.kind)).toContain("immunity_idol");
    expect(revealed.audience.kind).toBe("public");
    expect(finalCouncil(table).revealedHands).toEqual([pid("Ari")]);
    // Revealing is not playing: every card is still in the finalist's hand.
    expect(playerOf(table, "Ari").hand).toEqual(hand);
  });

  it("shows a revealed finalist hand to the jurors who have to judge it", () => {
    const table = withIdolAndExtraVote();
    const hand = [...playerOf(table, "Ari").hand];

    act(table, { type: "reveal_hand", actor: pid("Ari") });

    const juror = finalCouncil(table).jury[0] as PlayerId;
    const seen = table.game.privateView(juror)?.revealedToMe ?? [];
    const fromAri = seen.find((r) => r.ownerId === pid("Ari"));
    expect(fromAri).toBeDefined();
    expect(fromAri?.cards.map((c) => c.uid)).toEqual(hand);
  });

  it("lets only the final two reveal a hand", () => {
    const table = withIdolAndExtraVote();
    const juror = finalCouncil(table).jury[0] as PlayerId;

    expect(attempt(table, { type: "reveal_hand", actor: juror })).toMatchObject({
      ok: false,
      error: { code: "not_a_finalist" },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The Jury vote
// ---------------------------------------------------------------------------

describe("the Jury votes FOR a winner, and the most votes wins", () => {
  it("opens the vote once every member of the Jury has raised a finger", () => {
    const table = fivePlayerDrawPileExhausted();
    const jury = finalCouncil(table).jury;
    expect(finalCouncil(table).phase).toBe("opening");

    for (const [i, juror] of jury.entries()) {
      act(table, { type: "juror_ready", actor: juror });
      const expected = i === jury.length - 1 ? "jury_vote" : "opening";
      expect(finalCouncil(table).phase).toBe(expected);
    }
    expect(finalCouncil(table).readyJurors).toEqual([...jury]);
  });

  it("refuses a Jury vote before the vote has opened", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = finalCouncil(table);

    expect(
      attempt(table, {
        type: "cast_jury_vote",
        actor: final.jury[0] as PlayerId,
        finalist: final.finalists[0],
      }),
    ).toMatchObject({ ok: false, error: { code: "voting_not_open" } });
  });

  it("refuses a vote from a finalist: only Jury members vote", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);

    expect(
      attempt(table, {
        type: "cast_jury_vote",
        actor: final.finalists[0],
        finalist: final.finalists[1],
      }),
    ).toMatchObject({ ok: false, error: { code: "not_a_juror" } });
    expect(finalCouncil(table).castCount).toBe(0);
  });

  it("only accepts a vote FOR one of the final two", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);

    expect(
      attempt(table, {
        type: "cast_jury_vote",
        actor: final.jury[0] as PlayerId,
        finalist: final.jury[1] as PlayerId,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_target" } });
  });

  it("gives each juror exactly one vote", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);
    const juror = final.jury[0] as PlayerId;

    act(table, { type: "cast_jury_vote", actor: juror, finalist: final.finalists[0] });
    expect(
      attempt(table, {
        type: "cast_jury_vote",
        actor: juror,
        finalist: final.finalists[1],
      }),
    ).toMatchObject({ ok: false, error: { code: "jury_vote_already_cast" } });
    expect(finalCouncil(table).castCount).toBe(1);
  });

  it("keeps each Jury vote secret until the simultaneous reveal", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);

    const outcome = act(table, {
      type: "cast_jury_vote",
      actor: final.jury[0] as PlayerId,
      finalist: final.finalists[0],
    });

    // The public view knows THAT a vote is in, never for whom.
    expect(finalCouncil(table).castCount).toBe(1);
    expect(finalCouncil(table).juryVotes).toBeNull();
    const cast = outcome.events.find((e) => e.type === "jury_vote_cast");
    expect(cast?.audience).toEqual({ kind: "players", playerIds: [final.jury[0]] });
    const registered = outcome.events.find((e) => e.type === "jury_vote_registered");
    expect(registered?.audience.kind).toBe("public");
    expect(JSON.stringify(registered)).not.toContain("finalistId");
    // Nobody has been declared anything yet.
    expect(table.game.view().winnerId).toBeNull();
  });

  it("declares the finalist with the most Jury votes the winner", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);
    const [alpha, beta] = final.finalists;

    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[0] as PlayerId,
      finalist: alpha,
    });
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[1] as PlayerId,
      finalist: beta,
    });
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[2] as PlayerId,
      finalist: alpha,
    });

    const revealed = lastEvent(table, "jury_votes_revealed");
    expect(revealed.votes).toHaveLength(3);
    expect(revealed.tallies).toEqual(
      expect.arrayContaining([
        { finalistId: alpha, votes: 2 },
        { finalistId: beta, votes: 1 },
      ]),
    );
    const declared = lastEvent(table, "winner_declared");
    expect(declared.winnerId).toBe(alpha);
    expect(declared.method).toBe("jury_majority");
    expect(declared.votes).toBe(2);
    expect(declared.votesAgainst).toBe(1);
    expect(declared.juryCount).toBe(3);
    expect(table.game.view().winnerId).toBe(alpha);
  });

  it("counts a juror who never voted for nobody when the backstop closes the vote", () => {
    // Announcing "2–1" when one juror simply never voted puts a vote in the loser's column that
    // nobody cast. The event carries both columns so the narration never has to guess.
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);
    const [alpha] = final.finalists;
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[0] as PlayerId,
      finalist: alpha,
    });
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[1] as PlayerId,
      finalist: alpha,
    });

    const deadline = finalCouncil(table).phaseDeadlineMs;
    expect(deadline).not.toBeNull();
    tick(table, (deadline as number) + 1);

    const declared = lastEvent(table, "winner_declared");
    expect(declared.winnerId).toBe(alpha);
    expect(declared.votes).toBe(2);
    expect(declared.votesAgainst).toBe(0);
    expect(declared.juryCount).toBe(3);
  });

  it("decides a one-juror Jury on that juror's single vote", () => {
    const table = singleEliminationToTwo();
    const final = openJuryVote(table);
    expect(final.jury).toHaveLength(1);

    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[0] as PlayerId,
      finalist: final.finalists[1],
    });

    const declared = lastEvent(table, "winner_declared");
    expect(declared.winnerId).toBe(final.finalists[1]);
    expect(declared.method).toBe("jury_majority");
    expect(table.game.view().status).toBe("finished");
  });
});

// ---------------------------------------------------------------------------
// 5. Breaking a tie
// ---------------------------------------------------------------------------

describe("on a tie the Final Tribal Council Leader picks the winner", () => {
  /** Two jurors, one vote each way. Returns the table sitting in `tie_break`. */
  function tiedJury(): { table: Table; final: FinalCouncilView } {
    const table = drawPileExhaustedToTwo();
    const final = openJuryVote(table);
    expect(final.jury).toHaveLength(2);
    // The LEADER votes for finalists[1]; the other juror votes for finalists[0].
    act(table, {
      type: "cast_jury_vote",
      actor: final.leaderId,
      finalist: final.finalists[1],
    });
    const other = final.jury.find((j) => j !== final.leaderId) as PlayerId;
    act(table, { type: "cast_jury_vote", actor: other, finalist: final.finalists[0] });
    return { table, final };
  }

  it("asks the Leader to break an even split, after revealing the tied votes", () => {
    const { table, final } = tiedJury();

    expect(finalCouncil(table).phase).toBe("tie_break");
    const revealed = lastEvent(table, "jury_votes_revealed");
    expect(revealed.tallies.map((t) => t.votes)).toEqual([1, 1]);
    const required = lastEvent(table, "final_tie_break_required");
    expect(required.leaderId).toBe(final.leaderId);
    expect(table.game.view().winnerId).toBeNull();
    expect(table.game.view().status).toBe("active");
  });

  it("lets the Leader crown the finalist they did NOT vote for", () => {
    const { table, final } = tiedJury();
    const leaderVotedFor = final.finalists[1];
    const theOtherOne = final.finalists[0];

    act(table, {
      type: "final_leader_break_tie",
      actor: final.leaderId,
      winner: theOtherOne,
    });

    const declared = lastEvent(table, "winner_declared");
    expect(declared.winnerId).toBe(theOtherOne);
    expect(declared.winnerId).not.toBe(leaderVotedFor);
    expect(declared.method).toBe("leader_tie_break");
    expect(table.game.view().winnerId).toBe(theOtherOne);
  });

  it("lets nobody but the Leader break the tie", () => {
    const { table, final } = tiedJury();
    const other = final.jury.find((j) => j !== final.leaderId) as PlayerId;

    expect(
      attempt(table, {
        type: "final_leader_break_tie",
        actor: other,
        winner: final.finalists[0],
      }),
    ).toMatchObject({ ok: false, error: { code: "not_council_leader" } });
    expect(
      attempt(table, {
        type: "final_leader_break_tie",
        actor: final.finalists[0],
        winner: final.finalists[0],
      }),
    ).toMatchObject({ ok: false, error: { code: "not_council_leader" } });
    expect(table.game.view().status).toBe("active");
  });

  it("does not leave the game wedged when the Leader never breaks the tie", () => {
    const { table } = tiedJury();
    const deadline = finalCouncil(table).phaseDeadlineMs;
    expect(deadline).not.toBeNull();

    // Every phase deadline in this engine is a backstop "so a disconnected player cannot wedge
    // a game forever" (config.ts, TimingConfig). Run the clock a day past it.
    tick(table, (deadline as number) + 24 * 60 * 60 * 1000);
    tick(table, (deadline as number) + 48 * 60 * 60 * 1000);

    const stillWaiting = table.game.nextDeadline();
    expect(
      table.game.view().status === "finished" ||
        stillWaiting === null ||
        stillWaiting.atMs > table.now,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. A winner, and a terminal state
// ---------------------------------------------------------------------------

describe("the Final Tribal Council ends the game", () => {
  it("declares a Sole Survivor and moves the game to a terminal finished stage", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);
    for (const juror of final.jury) {
      act(table, {
        type: "cast_jury_vote",
        actor: juror,
        finalist: final.finalists[0],
      });
    }

    const stage = table.game.state().stage;
    expect(stage.kind).toBe("finished");
    if (stage.kind !== "finished") throw new Error("not finished");
    expect(stage.winnerId).toBe(final.finalists[0]);
    expect(table.game.view().status).toBe("finished");
    expect(table.game.view().winnerId).toBe(final.finalists[0]);
    expect(table.game.view().finalCouncil).toBeNull();
    expect(lastEvent(table, "game_finished").winnerId).toBe(final.finalists[0]);
    // Nothing is left waiting on a clock, and every card is still accounted for.
    expect(table.game.nextDeadline()).toBeNull();
    expect(censusOf(table.game.state())).toHaveLength(0);
  });

  it("accepts no further action once a winner has been declared", () => {
    const table = fivePlayerDrawPileExhausted();
    const final = openJuryVote(table);
    for (const juror of final.jury) {
      act(table, {
        type: "cast_jury_vote",
        actor: juror,
        finalist: final.finalists[0],
      });
    }
    const finished = table.game.state();

    for (const juror of final.jury) {
      expect(table.game.legalActions(juror, table.now)).toEqual([]);
    }
    expect(
      attempt(table, { type: "reveal_hand", actor: final.finalists[1] }),
    ).toMatchObject({ ok: false });
    expect(
      attempt(table, {
        type: "cast_jury_vote",
        actor: final.jury[0] as PlayerId,
        finalist: final.finalists[1],
      }),
    ).toMatchObject({ ok: false });
    expect(table.game.state()).toBe(finished);
  });

  it("survives a snapshot round trip at every step of the Final Tribal Council", () => {
    const table = fivePlayerDrawPileExhausted();
    const roundTrips = (): void => {
      const parsed = parseSnapshot(
        JSON.parse(JSON.stringify(table.game.snapshot())) as unknown,
      );
      expect(isOk(parsed)).toBe(true);
      if (!isOk(parsed)) return;
      expect(parsed.value.state).toEqual(table.game.state());
      const restored = restoreGame(parsed.value);
      expect(isOk(restored)).toBe(true);
    };

    roundTrips();
    const final = openJuryVote(table);
    roundTrips();
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[0] as PlayerId,
      finalist: final.finalists[0],
    });
    roundTrips();
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[1] as PlayerId,
      finalist: final.finalists[0],
    });
    act(table, {
      type: "cast_jury_vote",
      actor: final.jury[2] as PlayerId,
      finalist: final.finalists[1],
    });
    roundTrips();
    expect(table.game.view().status).toBe("finished");
  });
});
