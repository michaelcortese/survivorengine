/**
 * DOUBLE ELIMINATION TRIBAL COUNCIL — the four printed resolution branches.
 *
 * docs/RULES.md, "TIES — DOUBLE ELIMINATION TRIBAL COUNCIL", verbatim:
 *   • "If 3 or more players are tied with the most votes, the Tribal Council Leader gets to
 *      decide which 2 of the tied players are voted out."
 *   • "If 2 players are tied with the most votes, both are voted out."
 *   • "If 1 player gets the most votes, and 2 or more are tied with the second most, the player
 *      with the most votes is voted out first. Then, the Tribal Council Leader decides which of
 *      the tied players is also voted out."
 *   • "If there are only 3 players left and 2 players would be eliminated at the same time
 *      (leaving you with only 1 player left in the game), the Tribal Council Leader decides
 *      which of the tied players is eliminated. Immediately begin The Final Tribal Council."
 * plus "The 2 different players with the most votes must each turn over one of their Survivor
 * Character Cards" — one player can never lose both cards at a single Double Elimination.
 *
 * Every test is deterministic: one fixed RNG seed, and the few situations a shuffle will not
 * hand you (a Double Elimination card on top of the pile, a table already down to three
 * players) are built by editing a SNAPSHOT and restoring it through the public
 * `serializeSnapshot -> parseSnapshot -> restoreGame` boundary, which re-validates the card
 * census. No engine internals are touched.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import type { GameEvent } from "../src/engine/events.js";
import { censusOf, createGame, restoreGame } from "../src/engine/game.js";
import { parseSnapshot, serializeSnapshot } from "../src/engine/snapshot.js";
import {
  CardKind,
  asGameId,
  asPlayerId,
  type Action,
  type CardUid,
  type Game,
  type PlayerId,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED = 20250909;
const CLOCK_START = 1_700_000_000_000;

const P: readonly PlayerId[] = ["a", "b", "c", "d", "e", "f"].map((c) =>
  asPlayerId(`u-${c}`),
);

/** The plain-JSON shape of the bits of `GameState` these tests rewrite. */
interface WireCharacter {
  uid: string;
  flipped: boolean;
  flippedAtSeq: number | null;
}
interface WirePlayer {
  id: string;
  hand: string[];
  voteCards: string[];
  grantedVotes: string[];
  characterCards: WireCharacter[];
  eliminatedAtSeq: number | null;
  leftAtSeq: number | null;
}
interface WireZones {
  drawPile: string[];
  discardPile: string[];
  removedFromGame: string[];
  voteCardBank: string[];
  votingBox: string[];
  inPlay: string[];
}
interface WireState {
  players: WirePlayer[];
  zones: WireZones;
  cards: { uid: string; kind: string; color?: string }[];
}
interface WireSnapshot {
  state: WireState;
}

class Table {
  game: Game;
  /** Every event the table has ever seen, in order. */
  readonly log: GameEvent[] = [];
  private clock = CLOCK_START;

  constructor(game: Game) {
    this.game = game;
  }

  now(): number {
    this.clock += 1000;
    return this.clock;
  }

  /** Dispatch, or throw with the engine's own error. Records events and audits the census. */
  do(action: Action): readonly GameEvent[] {
    const out = this.game.dispatch(action, this.now());
    if (!out.ok) {
      throw new Error(`${action.type} rejected: ${JSON.stringify(out.error)}`);
    }
    this.log.push(...out.value.events);
    expect(censusOf(this.game.state())).toEqual([]);
    return out.value.events;
  }

  attempt(action: Action): ReturnType<Game["dispatch"]> {
    return this.game.dispatch(action, this.now());
  }

  /** Events emitted since a mark taken with `this.log.length`. */
  since(mark: number): readonly GameEvent[] {
    return this.log.slice(mark);
  }

  player(id: PlayerId) {
    const found = this.game.state().players.find((p) => p.id === id);
    if (!found) throw new Error(`no such player ${id}`);
    return found;
  }

  inPlay(): readonly PlayerId[] {
    return this.game
      .state()
      .players.filter((p) => p.eliminatedAtSeq === null && p.leftAtSeq === null)
      .map((p) => p.id);
  }

  charactersLeft(id: PlayerId): number {
    return this.player(id).characterCards.filter((c) => !c.flipped).length;
  }

  council() {
    const stage = this.game.state().stage;
    return stage.kind === "council" ? stage.council : null;
  }

  leaderDecision() {
    return this.game.state().pending.find((p) => p.kind === "leader_decision") ?? null;
  }

  /** Rewrite the snapshot and restore it. The census is revalidated on the way back in. */
  edit(mutate: (state: WireState) => void): void {
    const wire = JSON.parse(
      JSON.stringify(serializeSnapshot(this.game.snapshot())),
    ) as WireSnapshot;
    mutate(wire.state);
    const parsed = parseSnapshot(wire);
    if (!parsed.ok)
      throw new Error(`snapshot rejected: ${JSON.stringify(parsed.error)}`);
    const restored = restoreGame(parsed.value);
    if (!restored.ok)
      throw new Error(`restore failed: ${JSON.stringify(restored.error)}`);
    this.game = restored.value;
  }
}

function newTable(playerCount: number, seed = SEED): Table {
  const game = createGame({
    gameId: asGameId("double-elim"),
    hostId: P[0]!,
    config: DEFAULT_CONFIG.engine,
    nowMs: CLOCK_START,
    seed,
  });
  const table = new Table(game);
  for (let i = 0; i < playerCount; i += 1) {
    table.do({ type: "join_game", actor: P[i]!, displayName: `P${i}` });
  }
  table.do({ type: "start_game", actor: P[0]!, firstPlayer: P[0]! });
  return table;
}

// --- snapshot edits --------------------------------------------------------

const kindOfUid = (state: WireState, uid: string): string =>
  state.cards.find((c) => c.uid === uid)?.kind ?? "?";

const wirePlayer = (state: WireState, id: PlayerId): WirePlayer => {
  const found = state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no such player ${id}`);
  return found;
};

/** Put a Double Elimination Tribal Council card on TOP of the draw pile (index 0 is the top). */
function stackDoubleCouncil(state: WireState): void {
  const at = state.zones.drawPile.findIndex(
    (uid) => kindOfUid(state, uid) === CardKind.TribalCouncilDouble,
  );
  if (at < 0) throw new Error("no Double Elimination card in the draw pile");
  const [uid] = state.zones.drawPile.splice(at, 1);
  state.zones.drawPile.unshift(uid!);
}

/** Empty every hand into the discard pile, so no reaction or Inheritance can interfere. */
function clearHands(state: WireState): void {
  for (const player of state.players) {
    state.zones.discardPile.push(...player.hand);
    player.hand = [];
  }
}

/** Move one card of `kind` out of the draw pile and into a player's hand. */
function dealFromDeck(state: WireState, id: PlayerId, kind: string): string {
  const at = state.zones.drawPile.findIndex((uid) => kindOfUid(state, uid) === kind);
  if (at < 0) throw new Error(`no ${kind} left in the draw pile`);
  const [uid] = state.zones.drawPile.splice(at, 1);
  wirePlayer(state, id).hand.push(uid!);
  return uid!;
}

/** Pull a specific card out of wherever it is and put it into a player's hand. */
function moveToHand(state: WireState, id: PlayerId, uid: string): void {
  // `Object.values` on an interface with no index signature falls back to `any[]`, so the zone
  // keys are named instead — `WireZones` then keeps every one of them `string[]`.
  for (const key of Object.keys(state.zones) as (keyof WireZones)[]) {
    const zone = state.zones[key];
    const at = zone.indexOf(uid);
    if (at >= 0) zone.splice(at, 1);
  }
  for (const player of state.players) {
    for (const slot of [player.hand, player.voteCards, player.grantedVotes]) {
      const at = slot.indexOf(uid);
      if (at >= 0) slot.splice(at, 1);
    }
  }
  wirePlayer(state, id).hand.push(uid);
}

/** The Inheritance card printed in a given player's colour. */
function inheritanceCardFor(state: WireState, color: string): string {
  const card = state.cards.find(
    (c) => c.kind === CardKind.Inheritance && c.color === color,
  );
  if (!card) throw new Error(`no Inheritance card for ${color}`);
  return card.uid;
}

/** Turn over `count` of a player's Survivor Character Cards, as an earlier council would have. */
function flipCharacters(state: WireState, id: PlayerId, count: number): void {
  const player = wirePlayer(state, id);
  let done = 0;
  for (const card of player.characterCards) {
    if (done >= count) break;
    if (card.flipped) continue;
    card.flipped = true;
    card.flippedAtSeq = 2 + done;
    done += 1;
  }
  if (done < count)
    throw new Error(`${id} has fewer than ${count} character cards left`);
}

/** Fully eliminate a player: both cards over, hand discarded, Vote Card back to the bank. */
function eliminateOutright(state: WireState, id: PlayerId, atSeq: number): void {
  const player = wirePlayer(state, id);
  flipCharacters(state, id, player.characterCards.filter((c) => !c.flipped).length);
  player.eliminatedAtSeq = atSeq;
  state.zones.discardPile.push(...player.hand);
  player.hand = [];
  state.zones.voteCardBank.push(...player.voteCards);
  player.voteCards = [];
  state.zones.discardPile.push(...player.grantedVotes);
  player.grantedVotes = [];
}

// --- playing the turn ------------------------------------------------------

/** Steal, decline the reaction, skip the play step, draw — the drawn card starts the council. */
function drawIntoCouncil(t: Table, stealFrom?: PlayerId): void {
  const stage = t.game.state().stage;
  if (stage.kind !== "turn") throw new Error(`expected a turn, got ${stage.kind}`);
  const actor = stage.turn.playerId;
  const victim = stealFrom ?? t.inPlay().find((id) => id !== actor)!;
  t.do({ type: "steal_random", actor, target: victim });
  const take = t.game.state().pending.find((p) => p.kind === "take");
  if (take) t.do({ type: "decline_reaction", actor: victim, pendingId: take.id });
  t.do({ type: "skip_play_step", actor });
  t.do({ type: "draw_card", actor });
}

/** Advance to the vote, cast exactly the given ballots, and close the box. */
function voteAs(t: Table, ballots: ReadonlyArray<readonly [PlayerId, PlayerId]>): void {
  const council = t.council();
  if (!council) throw new Error("no council in progress");
  const leader = council.leaderId;
  t.do({ type: "advance_council", actor: leader, from: "advantages" });
  t.do({ type: "advance_council", actor: leader, from: "discussion" });

  const used = new Map<PlayerId, number>();
  for (const [voter, target] of ballots) {
    const player = t.player(voter);
    const spent = used.get(voter) ?? 0;
    // A player's own Vote Card first, then any Extra Vote sitting in their hand.
    const card: CardUid | undefined =
      spent === 0
        ? player.voteCards[0]
        : player.hand.find((uid) => t.game.card(uid)?.kind === CardKind.ExtraVote);
    if (!card)
      throw new Error(`${voter} has no card left to cast (ballot #${spent + 1})`);
    used.set(voter, spent + 1);
    t.do({ type: "cast_vote", actor: voter, cardUid: card, target });
  }
  for (const id of t.inPlay()) {
    t.do({ type: "finish_voting", actor: id });
  }
}

/** No idols were played, so the Leader takes the council straight from the idol window to tally. */
function tally(t: Table): void {
  const council = t.council();
  if (!council) throw new Error("no council in progress");
  expect(council.phase).toBe("idols");
  t.do({ type: "advance_council", actor: council.leaderId, from: "idols" });
}

// --- assertions ------------------------------------------------------------

const typed = (events: readonly GameEvent[], type: string): readonly GameEvent[] =>
  events.filter((e) => e.type === type);

const flipsOf = (events: readonly GameEvent[], id: PlayerId): number =>
  events.filter((e) => e.type === "character_card_flipped" && e.playerId === id).length;

/**
 * "The 2 different players with the most votes must each turn over ONE of their Survivor
 * Character Cards." One flip per elimination, no more: the old code decremented lives twice on
 * the tie path (docs/AUDIT.md), so this is asserted on every branch.
 */
function expectOneFlipPerElimination(
  t: Table,
  events: readonly GameEvent[],
  before: ReadonlyMap<PlayerId, number>,
): void {
  for (const [id, had] of before) {
    const lost = had - t.charactersLeft(id);
    expect(
      lost,
      `${id} lost ${lost} Survivor Character Cards but ${flipsOf(events, id)} flips were announced`,
    ).toBe(flipsOf(events, id));
    expect(
      lost,
      `${id} lost more than one card at a single Double Elimination`,
    ).toBeLessThanOrEqual(1);
  }
}

const livesBefore = (t: Table): ReadonlyMap<PlayerId, number> =>
  new Map(t.inPlay().map((id) => [id, t.charactersLeft(id)]));

/** A Double Elimination may never take the table below two players. */
function expectNeverBelowTwo(t: Table, events: readonly GameEvent[]): void {
  for (const event of events) {
    if (event.type === "player_eliminated") {
      expect(
        event.playersRemaining,
        "an elimination announced fewer than 2 players remaining",
      ).toBeGreaterThanOrEqual(2);
    }
  }
  expect(t.inPlay().length).toBeGreaterThanOrEqual(2);
}

// ---------------------------------------------------------------------------
// (b) exactly 2 tied for most -> both are voted out, with no Leader decision
// ---------------------------------------------------------------------------

describe("Double Elimination: exactly 2 tied for the most votes", () => {
  it('"If 2 players are tied with the most votes, both are voted out" — with no Leader decision', () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    expect(t.council()?.kind).toBe("double");
    expect(t.council()?.eliminationsRemaining).toBe(2);

    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[3]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[2]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(
      t.leaderDecision(),
      "no tie-break may be offered when exactly 2 tie",
    ).toBeNull();
    expect(typed(events, "tie_break_required")).toHaveLength(0);
    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expect(flipsOf(events, P[2]!)).toBe(1);
    expect(flipsOf(events, P[0]!)).toBe(0);
    expect(flipsOf(events, P[3]!)).toBe(0);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
  });

  it("both tied players turn over exactly one card each — lives are never decremented twice", () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[3]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[2]!],
    ]);
    tally(t);

    expect(t.charactersLeft(P[1]!)).toBe(1);
    expect(t.charactersLeft(P[2]!)).toBe(1);
    expect(t.charactersLeft(P[0]!)).toBe(2);
    expect(t.charactersLeft(P[3]!)).toBe(2);
    expect(t.inPlay()).toHaveLength(4);
  });

  it("the council ends after exactly 2 eliminations and names both flipped players", () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[3]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[2]!],
    ]);
    tally(t);

    const ended = t.since(mark).find((e) => e.type === "council_ended");
    expect(
      ended,
      "the council must end once both eliminations are spent",
    ).toBeDefined();
    if (ended?.type === "council_ended") {
      expect([...ended.flippedIds].sort()).toEqual([P[1]!, P[2]!].sort());
      expect(ended.eliminatedIds).toEqual([]);
    }
    expect(t.council()).toBeNull();
    expect(t.game.state().stage.kind).toBe("turn");
  });
});

// ---------------------------------------------------------------------------
// (a) 3+ tied for most -> the Leader picks exactly 2
// ---------------------------------------------------------------------------

describe("Double Elimination: 3 or more tied for the most votes", () => {
  const fourWayTie = (t: Table): void => {
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[3]!],
      [P[3]!, P[0]!],
    ]);
    tally(t);
  };

  const setup = (): Table => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    return t;
  };

  it('"If 3 or more players are tied with the most votes, the Leader decides which 2 are voted out"', () => {
    const t = setup();
    fourWayTie(t);

    const decision = t.leaderDecision();
    expect(decision, "a four-way tie must ask the Leader to choose").not.toBeNull();
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.choose, "the Leader picks exactly 2").toBe(2);
    expect(decision.reason).toBe("double_tie_for_most");
    expect(decision.tier).toBe("voted_non_immune");
    expect([...decision.candidates].sort()).toEqual(
      [P[0]!, P[1]!, P[2]!, P[3]!].sort(),
    );
    expect(decision.leaderId, "the drawer runs the council").toBe(P[0]!);
  });

  it("the Leader may not name fewer or more than 2 of the tied players", () => {
    const t = setup();
    fourWayTie(t);
    const decision = t.leaderDecision()!;

    const tooFew = t.attempt({
      type: "leader_choose_eliminations",
      actor: P[0]!,
      pendingId: decision.id,
      targets: [P[1]!],
    });
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.error.code).toBe("wrong_number_of_choices");

    const tooMany = t.attempt({
      type: "leader_choose_eliminations",
      actor: P[0]!,
      pendingId: decision.id,
      targets: [P[1]!, P[2]!, P[3]!],
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe("wrong_number_of_choices");

    const twice = t.attempt({
      type: "leader_choose_eliminations",
      actor: P[0]!,
      pendingId: decision.id,
      targets: [P[1]!, P[1]!],
    });
    expect(
      twice.ok,
      '"2 DIFFERENT players" — the same player cannot be named twice',
    ).toBe(false);
    if (!twice.ok) expect(twice.error.code).toBe("duplicate_target");

    const notLeader = t.attempt({
      type: "leader_choose_eliminations",
      actor: P[1]!,
      pendingId: decision.id,
      targets: [P[1]!, P[2]!],
    });
    expect(notLeader.ok).toBe(false);
    if (!notLeader.ok) expect(notLeader.error.code).toBe("not_council_leader");
  });

  it("the 2 players the Leader names each turn over exactly one Survivor Character Card", () => {
    const t = setup();
    const before = livesBefore(t);
    const mark = t.log.length;
    fourWayTie(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: P[0]!,
      pendingId: decision.id,
      targets: [P[1]!, P[2]!],
    });
    const events = t.since(mark);

    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expect(flipsOf(events, P[2]!)).toBe(1);
    expect(t.charactersLeft(P[1]!)).toBe(1);
    expect(t.charactersLeft(P[2]!)).toBe(1);
    expect(t.charactersLeft(P[0]!)).toBe(2);
    expect(t.charactersLeft(P[3]!)).toBe(2);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(t.council(), "the council ends once the Leader has chosen").toBeNull();
  });

  it("a five-way tie at 5 players still eliminates exactly 2", () => {
    const t = newTable(5);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[3]!],
      [P[3]!, P[4]!],
      [P[4]!, P[0]!],
    ]);
    tally(t);
    const decision = t.leaderDecision();
    expect(decision?.kind).toBe("leader_decision");
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.choose).toBe(2);
    expect(decision.candidates).toHaveLength(5);

    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[3]!, P[4]!],
    });
    const events = t.since(mark);
    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(t.inPlay()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// (c) 1 clear first, 2+ tied for second
// ---------------------------------------------------------------------------

describe("Double Elimination: 1 clear first and 2 or more tied for second", () => {
  const setup = (): Table => {
    const t = newTable(5);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    return t;
  };

  /** P0 = 3 votes (clear first); P1 and P2 = 1 each (tied for second); P3, P4 = none. */
  const clearFirstPlusTie = (t: Table): void => {
    voteAs(t, [
      [P[1]!, P[0]!],
      [P[2]!, P[0]!],
      [P[3]!, P[0]!],
      [P[0]!, P[1]!],
      [P[4]!, P[2]!],
    ]);
    tally(t);
  };

  it('"the player with the most votes is voted out FIRST" — before the Leader is asked anything', () => {
    const t = setup();
    const mark = t.log.length;
    clearFirstPlusTie(t);
    const events = t.since(mark);

    const flip = events.findIndex(
      (e) => e.type === "character_card_flipped" && e.playerId === P[0]!,
    );
    const ask = events.findIndex((e) => e.type === "tie_break_required");
    expect(flip, "the clear top vote-getter must be flipped").toBeGreaterThanOrEqual(0);
    expect(ask, "the Leader must then be asked about the tie").toBeGreaterThanOrEqual(
      0,
    );
    expect(
      flip,
      "the first elimination happens BEFORE the Leader decides",
    ).toBeLessThan(ask);
    expect(t.charactersLeft(P[0]!)).toBe(1);
  });

  it('"Then, the Leader decides which of the tied players is also voted out" — exactly one, from the tied pair', () => {
    const t = setup();
    clearFirstPlusTie(t);
    const decision = t.leaderDecision();
    expect(decision, "a tie for second must ask the Leader").not.toBeNull();
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");

    expect(decision.choose, "one more player goes, not two").toBe(1);
    expect(decision.reason).toBe("double_tie_for_second");
    expect([...decision.candidates].sort()).toEqual([P[1]!, P[2]!].sort());
    expect(
      decision.candidates.includes(P[0]!),
      '"2 DIFFERENT players" — the player already voted out is not a candidate',
    ).toBe(false);
    expect(
      decision.candidates.includes(P[3]!) || decision.candidates.includes(P[4]!),
      '"First, always choose from the (non-immune) players who got votes" — nobody who got no votes may be offered while vote-getters remain',
    ).toBe(false);
  });

  it("the Leader may not vote out a player who received no votes while tied vote-getters remain", () => {
    const t = setup();
    clearFirstPlusTie(t);
    const decision = t.leaderDecision()!;
    const out = t.attempt({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[3]!],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("candidate_not_eligible");
  });

  it("exactly 2 players are voted out in total, one card each", () => {
    const t = setup();
    const before = livesBefore(t);
    const mark = t.log.length;
    clearFirstPlusTie(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[2]!],
    });
    const events = t.since(mark);

    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(flipsOf(events, P[0]!)).toBe(1);
    expect(flipsOf(events, P[2]!)).toBe(1);
    expect(flipsOf(events, P[1]!)).toBe(0);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(t.council()).toBeNull();
    expect(t.inPlay()).toHaveLength(5);
  });

  it('"2 DIFFERENT players": when only one player received any votes, the ladder descends to the players who got none', () => {
    const t = setup();
    const mark = t.log.length;
    // Every vote in the game lands on P1, self-vote included.
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[1]!],
      [P[2]!, P[1]!],
      [P[3]!, P[1]!],
      [P[4]!, P[1]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(flipsOf(events, P[1]!)).toBe(1);
    const descended = events.find((e) => e.type === "tie_break_tier_descended");
    expect(descended, "the vote-getter rung is empty once P1 is spent").toBeDefined();
    if (descended?.type === "tie_break_tier_descended") {
      expect(descended.from).toBe("voted_non_immune");
      expect(descended.to).toBe("unvoted_non_immune");
    }
    const decision = t.leaderDecision();
    expect(decision?.kind).toBe("leader_decision");
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.choose).toBe(1);
    expect(
      decision.candidates.includes(P[1]!),
      "the same player may never take both eliminations of one Double Elimination",
    ).toBe(false);
    expect([...decision.candidates].sort()).toEqual(
      [P[0]!, P[2]!, P[3]!, P[4]!].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// (d) only 3 players left and 2 would go
// ---------------------------------------------------------------------------

describe("Double Elimination with only 3 players left", () => {
  /**
   * A 4-player game already down to three: P3 is out, P1 and P2 are each on their last
   * Survivor Character Card, and the votes tie P1 with P2 — so both "would be eliminated at
   * the same time, leaving you with only 1 player left in the game".
   */
  const setup = (): Table => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      eliminateOutright(s, P[3]!, 7);
      flipCharacters(s, P[1]!, 1);
      flipCharacters(s, P[2]!, 1);
      // A fourth ballot, so P1 and P2 can tie at 2 apiece with only three voters.
      dealFromDeck(s, P[0]!, CardKind.ExtraVote);
    });
    expect(t.inPlay()).toHaveLength(3);
    expect(t.charactersLeft(P[1]!)).toBe(1);
    expect(t.charactersLeft(P[2]!)).toBe(1);
    drawIntoCouncil(t);
    expect(t.council()?.kind).toBe("double");
    return t;
  };

  const tieP1WithP2 = (t: Table): void => {
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[0]!, P[2]!],
      [P[1]!, P[2]!],
      [P[2]!, P[1]!],
    ]);
    tally(t);
  };

  it('"the Leader decides which of the tied players is eliminated" — ONE, not two', () => {
    const t = setup();
    tieP1WithP2(t);
    const decision = t.leaderDecision();
    expect(decision, "the three-player override must ask the Leader").not.toBeNull();
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.choose, "only ONE player may be eliminated").toBe(1);
    expect(decision.reason).toBe("three_player_double_override");
    expect([...decision.candidates].sort()).toEqual([P[1]!, P[2]!].sort());
  });

  it("only one of the two tied players turns a card over; the other keeps their last life", () => {
    const t = setup();
    const before = livesBefore(t);
    const mark = t.log.length;
    tieP1WithP2(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[1]!],
    });
    const events = t.since(mark);

    expect(typed(events, "character_card_flipped")).toHaveLength(1);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expect(flipsOf(events, P[2]!), "the spared player keeps their last card").toBe(0);
    expect(t.charactersLeft(P[2]!)).toBe(1);
    expect(typed(events, "player_eliminated")).toHaveLength(1);
    expectOneFlipPerElimination(t, events, before);
  });

  it('"Immediately begin The Final Tribal Council" — and the game never falls below 2 players', () => {
    const t = setup();
    const mark = t.log.length;
    tieP1WithP2(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[1]!],
    });
    const events = t.since(mark);

    expectNeverBelowTwo(t, events);
    expect(t.inPlay()).toHaveLength(2);
    expect(t.game.state().stage.kind).toBe("final_council");

    const started = events.find((e) => e.type === "final_council_started");
    expect(started, "the Final Tribal Council begins immediately").toBeDefined();
    if (started?.type === "final_council_started") {
      expect([...started.finalists].sort()).toEqual([P[0]!, P[2]!].sort());
      expect(
        started.leaderId,
        '"The player most recently eliminated is a member of the Jury AND the Final Tribal Council Leader"',
      ).toBe(P[1]!);
      expect([...started.juryIds].sort()).toEqual([P[1]!, P[3]!].sort());
      expect(started.trigger).toBe("three_player_override");
    }
    expect(t.leaderDecision(), "no second elimination may still be pending").toBeNull();
  });

  it("the spared player can still win: the council does not keep resolving after the override", () => {
    const t = setup();
    tieP1WithP2(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[2]!],
    });
    expect(t.charactersLeft(P[1]!), "P1 was not chosen and keeps their last card").toBe(
      1,
    );
    expect(t.player(P[1]!).eliminatedAtSeq).toBeNull();
    expect(t.inPlay()).toHaveLength(2);
    expect(t.game.state().stage.kind).toBe("final_council");
  });
});

describe("The 3-player override applies only when 2 players really would be eliminated", () => {
  /** 3 players left: P0 still holds both cards, P1 and P2 are each on their last one. */
  const threePlayerTable = (): Table => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      eliminateOutright(s, P[3]!, 7);
      flipCharacters(s, P[1]!, 1);
      flipCharacters(s, P[2]!, 1);
      dealFromDeck(s, P[0]!, CardKind.ExtraVote);
    });
    drawIntoCouncil(t);
    return t;
  };

  it("offers the Leader only the tied players a turn-over would actually eliminate", () => {
    // "If there are only 3 players left and 2 players would be eliminated at the same time
    // (leaving you with only 1 player left in the game), the Tribal Council Leader decides which
    // of the tied players IS ELIMINATED." (docs/RULES.md, DOUBLE ELIMINATION TRIBAL COUNCIL)
    //
    // The question the rulebook asks is which tied player is ELIMINATED, so a tied player who
    // still holds two Survivor Character Cards is not an answer to it: naming them turns over a
    // card and eliminates nobody. This test used to name exactly that player and then assert
    // only that the council did not stall — which it did not, because the engine quietly
    // resolved the rest by SEAT ORDER: the second of the two endangered players went home, and
    // became the Final Tribal Council Leader, purely because seat 1 sorts before seat 2. The
    // Leader was never asked. Restricting the candidate list is what makes the one decision the
    // rulebook grants actually decide the outcome.
    const t = threePlayerTable();
    const mark = t.log.length;
    // A three-way tie at one vote apiece. Two of the three tied players are on their last card,
    // so "2 players would be eliminated at the same time" and the override applies — but the
    // third tied player is not in danger at all.
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[0]!],
    ]);
    tally(t);
    const decision = t.leaderDecision();
    expect(decision?.kind).toBe("leader_decision");
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.reason).toBe("three_player_double_override");
    expect(decision.choose).toBe(1);
    expect(
      [...decision.candidates].sort(),
      "P0 still holds both cards: naming them would eliminate nobody",
    ).toEqual([P[1]!, P[2]!].sort());

    // Whichever of the two the Leader names is the one who goes — not the one who sits first.
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[2]!],
    });
    const events = t.since(mark);

    expect(typed(events, "character_card_flipped")).toHaveLength(1);
    expect(flipsOf(events, P[2]!)).toBe(1);
    expect(
      flipsOf(events, P[1]!),
      "the player the Leader spared keeps their card",
    ).toBe(0);
    expect(t.player(P[1]!).eliminatedAtSeq).toBeNull();
    expect(t.player(P[2]!).eliminatedAtSeq).not.toBeNull();
    // "Immediately begin The Final Tribal Council."
    expect(events.some((e) => e.type === "final_council_started")).toBe(true);
    expect(t.inPlay()).toHaveLength(2);
    expect(t.leaderDecision(), "no second elimination may still be pending").toBeNull();
  });

  it("the override does NOT fire when neither tied player would be eliminated: both turn a card over", () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      eliminateOutright(s, P[3]!, 7); // three players left, all still holding both cards
      dealFromDeck(s, P[0]!, CardKind.ExtraVote);
    });
    expect(t.inPlay()).toHaveLength(3);
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[0]!, P[2]!],
      [P[1]!, P[2]!],
      [P[2]!, P[1]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(
      events.some((e) => e.type === "tie_break_required"),
      '"If 2 players are tied with the most votes, both are voted out" — nobody would be eliminated, so there is nothing to override',
    ).toBe(false);
    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(t.charactersLeft(P[1]!)).toBe(1);
    expect(t.charactersLeft(P[2]!)).toBe(1);
    expect(t.inPlay()).toHaveLength(3);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
  });

  it("the override does NOT fire when only one of the two tied players would actually be eliminated", () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      eliminateOutright(s, P[3]!, 7);
      flipCharacters(s, P[1]!, 1); // P1 is on their last card; P2 still holds both.
      dealFromDeck(s, P[0]!, CardKind.ExtraVote);
    });
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[0]!, P[2]!],
      [P[1]!, P[2]!],
      [P[2]!, P[1]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(
      events.some(
        (e) =>
          e.type === "tie_break_required" &&
          e.reason === "three_player_double_override",
      ),
      "only one player was in danger, so no override was needed",
    ).toBe(false);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expect(t.player(P[1]!).eliminatedAtSeq).not.toBeNull();
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(t.inPlay()).toHaveLength(2);
    expect(t.game.state().stage.kind).toBe("final_council");
  });
});

// ---------------------------------------------------------------------------
// The Final Tribal Council interrupting a double elimination
// ---------------------------------------------------------------------------

describe("Double Elimination interrupted by the Final Tribal Council", () => {
  it('"after just the first player is voted out" — a 4-player table taken to 2 goes straight to the Final Council', () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      flipCharacters(s, P[1]!, 1);
      flipCharacters(s, P[2]!, 1);
    });
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    // P1 and P2 tie at 2 votes each, and each is on their last card.
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[2]!, P[1]!],
      [P[1]!, P[2]!],
      [P[3]!, P[2]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(typed(events, "player_eliminated")).toHaveLength(2);
    expectNeverBelowTwo(t, events);
    expect(t.inPlay()).toHaveLength(2);
    expectOneFlipPerElimination(t, events, before);

    const started = events.find((e) => e.type === "final_council_started");
    expect(
      started,
      "two players left means the Final Tribal Council starts at once",
    ).toBeDefined();
    if (started?.type === "final_council_started") {
      expect([...started.finalists].sort()).toEqual([P[0]!, P[3]!].sort());
      expect([...started.juryIds].sort()).toEqual([P[1]!, P[2]!].sort());
      expect(started.leaderId, "the most recently eliminated player leads").toBe(P[2]!);
    }
    expect(t.game.state().stage.kind).toBe("final_council");
  });

  it("a Double Elimination never takes the table from 3 players to 1", () => {
    // Same three-player table as the override tests, but resolved end to end.
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      eliminateOutright(s, P[3]!, 7);
      flipCharacters(s, P[1]!, 1);
      flipCharacters(s, P[2]!, 1);
      dealFromDeck(s, P[0]!, CardKind.ExtraVote);
    });
    drawIntoCouncil(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[0]!, P[2]!],
      [P[1]!, P[2]!],
      [P[2]!, P[1]!],
    ]);
    tally(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[1]!],
    });

    expect(t.inPlay().length).toBeGreaterThanOrEqual(2);
    expectNeverBelowTwo(t, t.since(mark));
    expect(t.game.state().stage.kind).not.toBe("finished");
  });

  it("a clear single top vote-getter at 3 players is flipped without the override", () => {
    // "With one clear top vote-getter there is nothing to override." P1 alone tops the vote and
    // is eliminated; the table is then at 2 and the Final Council interrupts the second
    // elimination — the rulebook's own "after just the first player is voted out" route.
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      eliminateOutright(s, P[3]!, 7);
      flipCharacters(s, P[1]!, 1);
      dealFromDeck(s, P[0]!, CardKind.ExtraVote);
    });
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[0]!, P[1]!],
      [P[2]!, P[1]!],
      [P[1]!, P[2]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(
      events.some((e) => e.type === "tie_break_required"),
      "a clear top vote-getter needs no Leader decision",
    ).toBe(false);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expect(typed(events, "player_eliminated")).toHaveLength(1);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(t.inPlay()).toHaveLength(2);
    expect(t.game.state().stage.kind).toBe("final_council");
  });
});

describe("Double Elimination: the top two vote-getters with no tie at all", () => {
  it('"The 2 different players with the most votes must EACH turn over one" — no Leader decision needed', () => {
    const t = newTable(5);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    // P0 = 3 votes, P1 = 2 votes, everyone else none.
    voteAs(t, [
      [P[1]!, P[0]!],
      [P[2]!, P[0]!],
      [P[3]!, P[0]!],
      [P[0]!, P[1]!],
      [P[4]!, P[1]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(typed(events, "tie_break_required")).toHaveLength(0);
    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(flipsOf(events, P[0]!)).toBe(1);
    expect(flipsOf(events, P[1]!)).toBe(1);
    for (const event of events) {
      if (event.type === "character_card_flipped") {
        expect(
          event.charactersRemaining,
          "the announced count must match the card that was actually turned over",
        ).toBe(t.charactersLeft(event.playerId));
      }
    }
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
  });
});

describe("Double Elimination interrupted by an Inheritance claim", () => {
  it("a claim on the first elimination does not cancel the second", () => {
    // "You get all of the cards in their hand instead of their cards going in the Discard Pile."
    // The window opens between the two eliminations of the Double Elimination.
    const t = newTable(4);
    const victimColor = t.player(P[1]!).color;
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      flipCharacters(s, P[1]!, 1); // P1 is on their last card, so the vote eliminates them.
      dealFromDeck(s, P[1]!, CardKind.ExtraVote); // a hand worth inheriting
      moveToHand(s, P[0]!, inheritanceCardFor(s, victimColor));
    });
    drawIntoCouncil(t, P[3]); // steal from P3, so P1's hand survives to be inherited
    const before = livesBefore(t);
    const mark = t.log.length;
    // P1 and P2 tie at 2 votes each: "both are voted out".
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[2]!, P[1]!],
      [P[1]!, P[2]!],
      [P[3]!, P[2]!],
    ]);
    tally(t);

    const inheritance = t.game.state().pending.find((p) => p.kind === "inheritance");
    expect(
      inheritance,
      "eliminating P1 must offer the Inheritance card its window",
    ).toBeDefined();
    if (!inheritance) throw new Error("unreachable");
    const card = t
      .player(P[0]!)
      .hand.find((uid) => t.game.card(uid)?.kind === CardKind.Inheritance)!;
    t.do({
      type: "play_inheritance",
      actor: P[0]!,
      cardUid: card,
      pendingId: inheritance.id,
    });

    // Resolution resumes: the second of the two tied players still has to turn a card over,
    // and with only one candidate left there is nothing for the Leader to decide.
    const events = t.since(mark);
    expect(t.leaderDecision()).toBeNull();
    expect(
      flipsOf(events, P[2]!),
      "the second of the two tied players must still be voted out",
    ).toBe(1);
    expect(t.charactersLeft(P[2]!)).toBe(1);
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(censusOf(t.game.state())).toEqual([]);
  });

  it('"the Leader decides which 2 are voted out" — both named players go, even across an Inheritance window', () => {
    const t = newTable(4);
    const victimColor = t.player(P[1]!).color;
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      flipCharacters(s, P[1]!, 1); // P1's elimination will open the Inheritance window
      dealFromDeck(s, P[1]!, CardKind.ExtraVote);
      moveToHand(s, P[0]!, inheritanceCardFor(s, victimColor));
    });
    drawIntoCouncil(t, P[3]);
    const mark = t.log.length;
    // A four-way tie at one vote apiece: the Leader picks which 2 of the tied players go.
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[3]!],
      [P[3]!, P[0]!],
    ]);
    tally(t);
    const decision = t.leaderDecision();
    expect(decision?.kind).toBe("leader_decision");
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.choose).toBe(2);
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[1]!, P[2]!],
    });

    const inheritance = t.game.state().pending.find((p) => p.kind === "inheritance");
    expect(inheritance, "P1's elimination opens an Inheritance window").toBeDefined();
    if (!inheritance) throw new Error("unreachable");
    t.do({ type: "decline_reaction", actor: P[0]!, pendingId: inheritance.id });

    const events = t.since(mark);
    expect(flipsOf(events, P[1]!)).toBe(1);
    const reprompt = t.leaderDecision();
    expect(
      reprompt,
      reprompt?.kind === "leader_decision"
        ? `the Leader's decision was thrown away and re-opened as ${reprompt.reason} over ${reprompt.candidates.join(",")}`
        : "",
    ).toBeNull();
    expect(
      flipsOf(events, P[2]!),
      "the second player the Leader named must still be voted out once the window closes",
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-branch invariants
// ---------------------------------------------------------------------------

describe("Double Elimination invariants", () => {
  it("a Single Elimination council still eliminates only one player", () => {
    // The control case: the same machinery must not double-eliminate at a single council.
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      const at = s.zones.drawPile.findIndex(
        (uid) => kindOfUid(s, uid) === CardKind.TribalCouncilSingle,
      );
      if (at < 0) throw new Error("no Single Elimination card in the draw pile");
      const [uid] = s.zones.drawPile.splice(at, 1);
      s.zones.drawPile.unshift(uid!);
    });
    drawIntoCouncil(t);
    expect(t.council()?.kind).toBe("single");
    expect(t.council()?.eliminationsRemaining).toBe(1);

    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[2]!, P[1]!],
      [P[1]!, P[2]!],
      [P[3]!, P[0]!],
    ]);
    tally(t);
    const events = t.since(mark);

    expect(typed(events, "character_card_flipped")).toHaveLength(1);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expectOneFlipPerElimination(t, events, before);
  });

  it("the card census still balances after every double elimination branch", () => {
    // `Table.do` audits the census after every single dispatch; this asserts the end state too.
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[3]!],
      [P[3]!, P[0]!],
    ]);
    tally(t);
    const decision = t.leaderDecision()!;
    t.do({
      type: "leader_choose_eliminations",
      actor: decision.leaderId,
      pendingId: decision.id,
      targets: [P[1]!, P[3]!],
    });
    expect(censusOf(t.game.state())).toEqual([]);
  });

  it("a silent Leader still costs exactly 2 players one card each, chosen lowest seat first", () => {
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    const before = livesBefore(t);
    const mark = t.log.length;
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[3]!],
      [P[3]!, P[0]!],
    ]);
    tally(t);
    const decision = t.leaderDecision()!;
    expect(decision.deadlineMs).toBeGreaterThan(CLOCK_START);

    const ticked = t.game.tick(decision.deadlineMs + 1);
    expect(ticked.ok).toBe(true);
    if (!ticked.ok) throw new Error("unreachable");
    t.log.push(...ticked.value.events);
    const events = t.since(mark);

    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(flipsOf(events, P[0]!)).toBe(1);
    expect(flipsOf(events, P[1]!)).toBe(1);
    expect(t.leaderDecision()).toBeNull();
    expectOneFlipPerElimination(t, events, before);
    expectNeverBelowTwo(t, events);
    expect(censusOf(t.game.state())).toEqual([]);
  });

  it("a Leader voted out by the first elimination still resolves the tie for the second", () => {
    // "you are responsible for starting the voting process, tallying the votes, and resolving
    // ties" — nothing in the rulebook hands the council to somebody else when the Leader is
    // voted out part-way through it, and the council must not wedge.
    const t = newTable(5);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
      flipCharacters(s, P[0]!, 1); // the drawer/Leader is on their last card
    });
    drawIntoCouncil(t);
    expect(t.council()?.leaderId).toBe(P[0]!);
    const mark = t.log.length;
    voteAs(t, [
      [P[1]!, P[0]!],
      [P[2]!, P[0]!],
      [P[3]!, P[0]!],
      [P[0]!, P[1]!],
      [P[4]!, P[2]!],
    ]);
    tally(t);

    expect(
      t.player(P[0]!).eliminatedAtSeq,
      "the Leader was voted out first",
    ).not.toBeNull();
    const decision = t.leaderDecision();
    expect(decision, "the tie for second still has to be resolved").not.toBeNull();
    if (decision?.kind !== "leader_decision") throw new Error("unreachable");
    expect(decision.leaderId).toBe(P[0]!);
    t.do({
      type: "leader_choose_eliminations",
      actor: P[0]!,
      pendingId: decision.id,
      targets: [P[1]!],
    });
    const events = t.since(mark);
    expect(typed(events, "character_card_flipped")).toHaveLength(2);
    expect(t.council(), "the council must not wedge").toBeNull();
    expectNeverBelowTwo(t, events);
    expect(censusOf(t.game.state())).toEqual([]);
  });

  it("every surviving player is handed exactly one Vote Card back after the council", () => {
    // "return 1 Vote Card to every player who still has at least one Survivor Character Card."
    const t = newTable(4);
    t.edit((s) => {
      clearHands(s);
      stackDoubleCouncil(s);
    });
    drawIntoCouncil(t);
    voteAs(t, [
      [P[0]!, P[1]!],
      [P[3]!, P[1]!],
      [P[1]!, P[2]!],
      [P[2]!, P[2]!],
    ]);
    tally(t);
    for (const id of t.inPlay()) {
      expect(
        t.player(id).voteCards,
        `${id} must hold exactly one Vote Card`,
      ).toHaveLength(1);
    }
  });
});
