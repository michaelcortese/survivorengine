/**
 * THE 3-TIER TIE-BREAK LADDER.
 *
 * docs/RULES.md:123 (rulebook, verbatim): "If it's unclear who is voted out (because too many
 * players tied, some players got no votes, and/or some players played Immunity Idols), the
 * Tribal Council Leader must decide who to vote out using these criteria:
 *   • First, always choose from the (non-immune) players who got votes. If there aren't any…
 *   • Choose from the (non-immune) players who got no votes. Finally, if there's not enough of
 *     them…
 *   • Choose from the players who played Immunity Idols."
 *
 * docs/RULES.md:127: "This is a strict 3-tier priority ladder and it is the key correctness rule
 * an implementation must encode: an Immunity Idol is NOT absolute protection. If every non-immune
 * candidate is exhausted, an idol-playing player can still be voted out."
 *
 * Every test below drives the REAL engine through real actions: join, start, steal, skip, draw a
 * Tribal Council card, run the council phases, cast real Vote Cards, play real Immunity Idol
 * cards. The only surgery is deterministic card placement between the play step and the draw
 * (see `rig`), which moves existing card instances between zones and therefore keeps the card
 * census balanced — asserted after every rig.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type EngineConfig } from "../src/config.js";
import {
  advance,
  censusOf,
  createGame,
  legalActionsFor,
  reduce,
} from "../src/engine/game.js";
import type { GameEvent } from "../src/engine/events.js";
import {
  CardKind,
  TIE_BREAK_LADDER,
  asGameId,
  asPlayerId,
  councilOf,
  type Action,
  type CardUid,
  type CouncilState,
  type GameState,
  type PendingLeaderDecision,
  type Player,
  type PlayerColor,
  type PlayerId,
  type Result,
  type TieBreakTier,
  type VoteTallyRow,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Fixed clock, fixed seed. Every test in this file is deterministic.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const SEED = 20250909;

const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eve", "Fay"] as const;
const COLORS: readonly PlayerColor[] = [
  "red",
  "orange",
  "magenta",
  "green",
  "teal",
  "yellow",
];

/** Players are addressed by seat index throughout. Seat 0 is the Leader in every test. */
const P = (i: number): PlayerId => asPlayerId(`p${i}`);
const LEADER = 0;

// ---------------------------------------------------------------------------
// Card surgery. A narrow structural mirror of the parts of GameState we move
// cards between, so the clone can be mutated without fighting `readonly`.
// ---------------------------------------------------------------------------

interface RigPlayer {
  id: string;
  hand: string[];
  voteCards: string[];
}
interface RigState {
  players: RigPlayer[];
  cards: { uid: string; kind: string }[];
  zones: { drawPile: string[]; discardPile: string[] };
}

const asRig = (state: GameState): RigState => state as unknown as RigState;

/** Pull one card instance of `kind` out of the draw pile, else out of the discard pile. */
function detach(rig: RigState, kind: string): string {
  for (const zone of [rig.zones.drawPile, rig.zones.discardPile]) {
    const at = zone.findIndex(
      (uid) => rig.cards.find((c) => c.uid === uid)?.kind === kind,
    );
    if (at >= 0) {
      const uid = zone[at];
      if (uid === undefined) continue;
      zone.splice(at, 1);
      return uid;
    }
  }
  throw new Error(`no free ${kind} card left to plant`);
}

/**
 * Deterministically stack the table: empty every hand into the discard pile, deal the named
 * cards back out, and put a Tribal Council card of the requested kind on top of the draw pile.
 * Only moves existing instances between zones, so the 80-instance census still balances.
 */
function rig(
  state: GameState,
  councilKind: "single" | "double",
  plant: Readonly<Record<number, readonly CardKind[]>>,
): GameState {
  const next = structuredClone(state);
  const r = asRig(next);

  for (const player of r.players) {
    r.zones.discardPile.push(...player.hand);
    player.hand = [];
  }
  for (const [seat, kinds] of Object.entries(plant)) {
    const player = r.players[Number(seat)];
    if (!player) throw new Error(`no seat ${seat}`);
    for (const kind of kinds) player.hand.push(detach(r, kind));
  }

  const councilCard = detach(
    r,
    councilKind === "single"
      ? CardKind.TribalCouncilSingle
      : CardKind.TribalCouncilDouble,
  );
  r.zones.drawPile.unshift(councilCard);

  expect(censusOf(next), "rigging must not lose or duplicate a card").toEqual([]);
  return next;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

class Table {
  state: GameState;
  events: GameEvent[] = [];

  constructor(state: GameState) {
    this.state = state;
  }

  /** Apply an action that is expected to succeed. Throws loudly if the engine refuses. */
  do(action: Action): readonly GameEvent[] {
    const result = reduce(this.state, action, T0);
    if (!result.ok) {
      throw new Error(
        `${action.type} was rejected: ${result.error.code} — ${result.error.message}`,
      );
    }
    this.state = result.value.state;
    this.events.push(...result.value.events);
    return result.value.events;
  }

  /** Fast-forward the engine's only clock. */
  tick(atMs: number): readonly GameEvent[] {
    const outcome = advance(this.state, atMs);
    this.state = outcome.state;
    this.events.push(...outcome.events);
    return outcome.events;
  }

  /** Apply an action that is expected to be refused. Returns the Result for inspection. */
  attempt(action: Action): Result<{ readonly state: GameState }> {
    return reduce(this.state, action, T0);
  }

  eventsOfType<T extends GameEvent["type"]>(
    type: T,
  ): Extract<GameEvent, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<GameEvent, { type: T }> => e.type === type,
    );
  }

  player(seat: number): Player {
    const p = this.state.players.find((x) => x.id === P(seat));
    if (!p) throw new Error(`no player at seat ${seat}`);
    return p;
  }

  council(): CouncilState {
    const c = councilOf(this.state.stage);
    if (!c) throw new Error("no council in progress");
    return c;
  }

  leaderDecision(): PendingLeaderDecision {
    const pending = this.state.pending.find(
      (p): p is PendingLeaderDecision => p.kind === "leader_decision",
    );
    if (!pending) throw new Error("no leader decision is open");
    return pending;
  }

  hasLeaderDecision(): boolean {
    return this.state.pending.some((p) => p.kind === "leader_decision");
  }

  /**
   * The tally row for a seat, read off the public `tally_computed` event so it stays readable
   * after the council has cleaned up and the stage has returned to a turn.
   */
  tallyFor(seat: number): VoteTallyRow {
    const computed = this.eventsOfType("tally_computed").at(-1);
    const row = computed?.rows.find((r) => r.playerId === P(seat));
    if (!row) throw new Error(`no tally row for seat ${seat}`);
    return row;
  }

  torches(seat: number): number {
    return this.player(seat).characterCards.filter((c) => !c.flipped).length;
  }

  /** The first unplayed card of `kind` in this player's hand. */
  handCard(seat: number, kind: CardKind): CardUid {
    const player = this.player(seat);
    const uid = player.hand.find(
      (u) => this.state.cards.find((c) => c.uid === u)?.kind === kind,
    );
    if (!uid) throw new Error(`seat ${seat} holds no ${kind}`);
    return uid;
  }
}

/** A started game with `count` players, seat 0 to move first. */
function startTable(
  count: number,
  config: EngineConfig = DEFAULT_CONFIG.engine,
): Table {
  const game = createGame({
    gameId: asGameId("tiebreak"),
    hostId: P(0),
    config,
    nowMs: T0,
    seed: SEED,
  });
  for (let i = 0; i < count; i += 1) {
    const color = COLORS[i];
    const displayName = NAMES[i];
    if (!color || !displayName) throw new Error("player count out of range");
    const joined = game.dispatch(
      { type: "join_game", actor: P(i), displayName, color },
      T0,
    );
    expect(joined.ok, "join_game").toBe(true);
  }
  const started = game.dispatch(
    { type: "start_game", actor: P(0), firstPlayer: P(0) },
    T0,
  );
  expect(started.ok, "start_game").toBe(true);
  return new Table(game.state());
}

/**
 * Take seat 0 through a real turn — mandatory steal, skipped play step — then stack the deck
 * and draw the Tribal Council card. Seat 0 draws it, so seat 0 is the Leader.
 */
function openCouncil(
  t: Table,
  councilKind: "single" | "double",
  plant: Readonly<Record<number, readonly CardKind[]>> = {},
): void {
  t.do({ type: "steal_random", actor: P(0), target: P(1) });
  const take = t.state.pending.find((p) => p.kind === "take");
  if (!take) throw new Error("the mandatory steal opened no window");
  t.do({ type: "decline_reaction", actor: P(1), pendingId: take.id });
  t.do({ type: "skip_play_step", actor: P(0) });

  t.state = rig(t.state, councilKind, plant);

  t.do({ type: "draw_card", actor: P(0) });
  expect(t.council().kind).toBe(councilKind);
  expect(t.council().leaderId).toBe(P(LEADER));
}

/**
 * Run the council from `advantages` all the way to the tally: open voting, cast every Vote Card
 * as instructed, close voting, play every instructed Immunity Idol in the idol window, then
 * advance through the nullifier window into the tally.
 */
function runToTally(
  t: Table,
  votes: readonly (readonly [number, number])[],
  idols: readonly (readonly [number, number])[] = [],
): void {
  const leader = P(LEADER);
  t.do({ type: "advance_council", actor: leader, from: "advantages" });
  t.do({ type: "advance_council", actor: leader, from: "discussion" });

  for (const [voter, target] of votes) {
    const card = t.player(voter).voteCards[0];
    if (!card) throw new Error(`seat ${voter} holds no Vote Card`);
    t.do({ type: "cast_vote", actor: P(voter), cardUid: card, target: P(target) });
  }

  t.do({ type: "advance_council", actor: leader, from: "voting" });
  expect(t.council().phase).toBe("idols");

  for (const [player, protects] of idols) {
    t.do({
      type: "play_immunity_idol",
      actor: P(player),
      cardUid: t.handCard(player, CardKind.ImmunityIdol),
      protects: P(protects),
    });
  }

  t.do({ type: "advance_council", actor: leader, from: "idols" });
  if (councilOf(t.state.stage)?.phase === "nullifiers") {
    t.do({ type: "advance_council", actor: leader, from: "nullifiers" });
  }
}

const idolHands = (
  seats: readonly number[],
  each = 1,
): Record<number, readonly CardKind[]> =>
  Object.fromEntries(
    seats.map((s) => [s, Array.from({ length: each }, () => CardKind.ImmunityIdol)]),
  );

const sorted = (ids: readonly PlayerId[]): string[] => [...ids].sort();

const descents = (t: Table): { from: TieBreakTier; to: TieBreakTier }[] =>
  t.eventsOfType("tie_break_tier_descended").map((e) => ({ from: e.from, to: e.to }));

// ===========================================================================
// TIER 1 — "First, always choose from the (non-immune) players who got votes."
// ===========================================================================

describe("tier 1: the non-immune players who received votes", () => {
  it("a plain tie at a Single Elimination council is decided by the Leader, and only from the tied players who received votes", () => {
    const t = startTable(4);
    openCouncil(t, "single");
    // Bex 2, Cyd 2, Ari 0, Dov 0.
    runToTally(t, [
      [0, 1],
      [3, 1],
      [1, 2],
      [2, 2],
    ]);

    expect(t.tallyFor(1).countedVotes).toBe(2);
    expect(t.tallyFor(2).countedVotes).toBe(2);
    expect(t.tallyFor(0).countedVotes).toBe(0);
    expect(t.tallyFor(3).countedVotes).toBe(0);

    const pending = t.leaderDecision();
    expect(pending.leaderId).toBe(P(LEADER));
    // docs/RULES.md:116 — "The Tribal Council Leader gets to decide which of the tied players
    // is voted out."
    expect(pending.reason).toBe("tie_for_most");
    expect(pending.tier).toBe<TieBreakTier>("voted_non_immune");
    expect(pending.choose).toBe(1);
    expect(sorted(pending.candidates)).toEqual(sorted([P(1), P(2)]));

    // Tier 1 was non-empty, so the ladder never descended.
    expect(descents(t)).toEqual([]);

    const required = t.eventsOfType("tie_break_required").at(-1);
    expect(required?.tier).toBe("voted_non_immune");
    expect(sorted(required?.candidates ?? [])).toEqual(sorted([P(1), P(2)]));
  });

  it("players who received no votes are not offered to the Leader while tier 1 is non-empty", () => {
    const t = startTable(4);
    openCouncil(t, "single");
    runToTally(t, [
      [0, 1],
      [3, 1],
      [1, 2],
      [2, 2],
    ]);

    const pending = t.leaderDecision();
    expect(pending.candidates).not.toContain(P(0));
    expect(pending.candidates).not.toContain(P(3));

    // And the renderer is handed the same constrained list, so a UI cannot offer a bad target.
    const offered = legalActionsFor(t.state, P(LEADER), T0).find(
      (a) => a.kind === "leader_choose_eliminations",
    );
    expect(offered).toBeDefined();
    expect(sorted(offered?.legalTargets ?? [])).toEqual(sorted([P(1), P(2)]));
    expect(offered?.chooseCount).toBe(1);
  });

  it("a Leader choice outside the current tier is rejected and changes nothing", () => {
    const t = startTable(4);
    openCouncil(t, "single");
    runToTally(t, [
      [0, 1],
      [3, 1],
      [1, 2],
      [2, 2],
    ]);

    const pending = t.leaderDecision();
    const before = t.state;

    // Dov received no votes: tier 2, and tier 1 is not exhausted.
    const rejected = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(3)],
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("candidate_not_eligible");
    expect(t.state).toBe(before);
    expect(t.torches(3)).toBe(2);
    expect(t.hasLeaderDecision()).toBe(true);

    // So is the Leader naming themselves when they are not on the rung.
    const selfSpare = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(LEADER)],
    });
    expect(selfSpare.ok).toBe(false);
    if (!selfSpare.ok) expect(selfSpare.error.code).toBe("candidate_not_eligible");

    // And naming the wrong NUMBER of players, or acting as somebody else.
    const twoNames = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(1), P(2)],
    });
    expect(twoNames.ok).toBe(false);
    if (!twoNames.ok) expect(twoNames.error.code).toBe("wrong_number_of_choices");

    const notLeader = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(2),
      pendingId: pending.id,
      targets: [P(1)],
    });
    expect(notLeader.ok).toBe(false);
    if (!notLeader.ok) expect(notLeader.error.code).toBe("not_council_leader");

    expect(t.state).toBe(before);
  });

  it("the Leader's tier-1 choice turns over exactly one Survivor Character Card and spares the other tied player", () => {
    const t = startTable(4);
    openCouncil(t, "single");
    runToTally(t, [
      [0, 1],
      [3, 1],
      [1, 2],
      [2, 2],
    ]);

    const pending = t.leaderDecision();
    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(1)],
    });

    expect(t.torches(1)).toBe(1);
    expect(t.torches(2)).toBe(2);
    expect(t.torches(0)).toBe(2);
    expect(t.torches(3)).toBe(2);

    const chose = t.eventsOfType("leader_chose_eliminations").at(-1);
    expect(chose?.targetIds).toEqual([P(1)]);
    expect(chose?.tier).toBe("voted_non_immune");

    const ended = t.eventsOfType("council_ended").at(-1);
    expect(ended?.flippedIds).toEqual([P(1)]);
    expect(censusOf(t.state)).toEqual([]);
  });

  it("a player protected by a live Immunity Idol is never a tier-1 candidate, however many votes they drew", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([1]));
    // Bex draws the most raw votes (2) but plays an idol on herself; Cyd and Dov tie on 1.
    runToTally(
      t,
      [
        [0, 1],
        [3, 1],
        [1, 2],
        [2, 3],
      ],
      [[1, 1]],
    );

    expect(t.tallyFor(1).rawVotes).toBe(2);
    expect(t.tallyFor(1).immune).toBe(true);
    expect(t.tallyFor(1).countedVotes).toBe(0);

    const pending = t.leaderDecision();
    expect(pending.tier).toBe<TieBreakTier>("voted_non_immune");
    expect(sorted(pending.candidates)).toEqual(sorted([P(2), P(3)]));
    expect(pending.candidates).not.toContain(P(1));
    expect(descents(t)).toEqual([]);
  });

  it("a player who plays an Immunity Idol on an ally stays non-immune and remains a tier-1 candidate", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([0]));
    // Ari spends her idol on Bex, who draws no votes at all; Ari and Cyd then tie on 2.
    runToTally(
      t,
      [
        [1, 0],
        [2, 0],
        [0, 2],
        [3, 2],
      ],
      [[0, 1]],
    );

    expect(t.tallyFor(1).immune).toBe(true); // the protected ally
    expect(t.tallyFor(0).immune).toBe(false); // the player who PLAYED it
    expect(t.tallyFor(0).countedVotes).toBe(2);

    const pending = t.leaderDecision();
    expect(pending.tier).toBe<TieBreakTier>("voted_non_immune");
    expect(sorted(pending.candidates)).toEqual(sorted([P(0), P(2)]));
    expect(pending.candidates).toContain(P(0));
    expect(pending.candidates).not.toContain(P(1));
    expect(descents(t)).toEqual([]);
  });

  it("at a Double Elimination with 3 or more tied for most votes the Leader picks 2, and only from the tied players", () => {
    const t = startTable(4);
    openCouncil(t, "double");
    // A four-way one-vote tie.
    runToTally(t, [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ]);

    const pending = t.leaderDecision();
    // docs/RULES.md:118 — "If 3 or more players are tied with the most votes, the Tribal Council
    // Leader gets to decide which 2 of the tied players are voted out."
    expect(pending.reason).toBe("double_tie_for_most");
    expect(pending.tier).toBe<TieBreakTier>("voted_non_immune");
    expect(pending.choose).toBe(2);
    expect(sorted(pending.candidates)).toEqual(sorted([P(0), P(1), P(2), P(3)]));

    const duplicate = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(1), P(1)],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate_target");

    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(1), P(2)],
    });
    expect(t.torches(1)).toBe(1);
    expect(t.torches(2)).toBe(1);
    expect(t.torches(0)).toBe(2);
    expect(t.torches(3)).toBe(2);
  });
});

// ===========================================================================
// TIER 2 — "Choose from the (non-immune) players who got no votes."
// ===========================================================================

describe("tier 2: the non-immune players who received no votes", () => {
  it("the ladder descends to tier 2 only once every non-immune player who received votes is exhausted", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([1]));
    // Every vote lands on Bex, and Bex is immune. Nobody else drew a single vote.
    runToTally(
      t,
      [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      [[1, 1]],
    );

    expect(t.tallyFor(1).rawVotes).toBe(4);
    expect(t.tallyFor(1).countedVotes).toBe(0);
    for (const seat of [0, 2, 3]) expect(t.tallyFor(seat).rawVotes).toBe(0);

    // Exactly one rung of descent: tier 1 was empty, tier 2 was not.
    expect(descents(t)).toEqual([
      { from: "voted_non_immune", to: "unvoted_non_immune" },
    ]);
    expect(t.eventsOfType("tie_break_tier_descended")[0]?.emptyBecause).toBe(
      "no_candidates",
    );

    const pending = t.leaderDecision();
    expect(pending.reason).toBe("unclear_cascade");
    expect(pending.tier).toBe<TieBreakTier>("unvoted_non_immune");
    expect(pending.choose).toBe(1);
    expect(sorted(pending.candidates)).toEqual(sorted([P(0), P(2), P(3)]));
    // The immune player is on neither of the first two rungs.
    expect(pending.candidates).not.toContain(P(1));
  });

  it("a tier-3 player cannot be chosen while tier 2 still has candidates", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([1]));
    runToTally(
      t,
      [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      [[1, 1]],
    );

    const pending = t.leaderDecision();
    const rejected = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(1)],
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("candidate_not_eligible");
    expect(t.torches(1)).toBe(2);
  });

  it("a player who drew every vote survives on the idol while a player with no votes at all is sent home", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([1]));
    runToTally(
      t,
      [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      [[1, 1]],
    );

    const pending = t.leaderDecision();
    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(2)],
    });

    expect(t.torches(1)).toBe(2); // the idol did its job
    expect(t.torches(2)).toBe(1); // and somebody still went home
    expect(t.eventsOfType("council_ended").at(-1)?.flippedIds).toEqual([P(2)]);
    expect(censusOf(t.state)).toEqual([]);
  });
});

// ===========================================================================
// TIER 3 — "Choose from the players who played Immunity Idols."
//   docs/RULES.md:127: "an Immunity Idol is NOT absolute protection."
// ===========================================================================

describe("tier 3: the players who played Immunity Idols", () => {
  it("an Immunity Idol does not protect when every other tier is exhausted", () => {
    const t = startTable(4);
    // Every player holds an idol and plays it on themselves: the whole table is immune.
    openCouncil(t, "single", idolHands([0, 1, 2, 3]));
    runToTally(
      t,
      [
        [0, 1],
        [1, 0],
        [2, 3],
        [3, 2],
      ],
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );

    for (const seat of [0, 1, 2, 3]) {
      expect(t.tallyFor(seat).immune, `seat ${seat} immune`).toBe(true);
      expect(t.tallyFor(seat).countedVotes).toBe(0);
    }
    expect(t.eventsOfType("tally_computed").at(-1)?.highestCountedVotes).toBe(0);
    expect(t.eventsOfType("tally_computed").at(-1)?.topVoteGetters).toEqual([]);

    // Both rungs above were empty, and the engine said so out loud.
    expect(descents(t)).toEqual([
      { from: "voted_non_immune", to: "unvoted_non_immune" },
      { from: "unvoted_non_immune", to: "played_or_protected_by_idol" },
    ]);

    const pending = t.leaderDecision();
    expect(pending.reason).toBe("unclear_cascade");
    expect(pending.tier).toBe<TieBreakTier>("played_or_protected_by_idol");
    expect(pending.choose).toBe(1);
    expect(sorted(pending.candidates)).toEqual(sorted([P(0), P(1), P(2), P(3)]));

    // …and somebody is still voted out. A council can never end with nobody out.
    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(2)],
    });
    expect(t.torches(2)).toBe(1);
    expect(t.tallyFor(2).immune).toBe(true);
    expect(t.eventsOfType("council_ended").at(-1)?.flippedIds).toEqual([P(2)]);
    expect(censusOf(t.state)).toEqual([]);
  });

  it("tier 3 is the players who PLAYED Immunity Idols, not the players those idols protected", () => {
    const t = startTable(4);
    // Ari holds all four idols and spreads them across the whole table, herself included.
    openCouncil(t, "single", idolHands([0], 4));
    runToTally(
      t,
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
      [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );

    for (const seat of [0, 1, 2, 3]) {
      expect(t.tallyFor(seat).immune, `seat ${seat} immune`).toBe(true);
    }

    const pending = t.leaderDecision();
    expect(pending.tier).toBe<TieBreakTier>("played_or_protected_by_idol");
    // Only Ari PLAYED an idol; Bex, Cyd and Dov were merely protected by one.
    expect(pending.candidates).toEqual([P(0)]);

    const rejected = t.attempt({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(1)],
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("candidate_not_eligible");

    // The Leader has no way out: she played the idols, so she is the only candidate.
    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(0)],
    });
    expect(t.torches(0)).toBe(1);
    expect(t.torches(1)).toBe(2);
    expect(t.torches(2)).toBe(2);
    expect(t.torches(3)).toBe(2);
  });

  it("an idol cancelled by an Idol Nullifier restores its holder to tier 1 and stops the descent", () => {
    const t = startTable(4);
    openCouncil(t, "single", {
      1: [CardKind.ImmunityIdol],
      2: [CardKind.IdolNullifier],
    });
    const leader = P(LEADER);
    t.do({ type: "advance_council", actor: leader, from: "advantages" });
    t.do({ type: "advance_council", actor: leader, from: "discussion" });
    for (const [voter, target] of [
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ] as const) {
      const card = t.player(voter).voteCards[0];
      if (!card) throw new Error("no Vote Card");
      t.do({ type: "cast_vote", actor: P(voter), cardUid: card, target: P(target) });
    }
    t.do({ type: "advance_council", actor: leader, from: "voting" });
    const idolUid = t.handCard(1, CardKind.ImmunityIdol);
    t.do({
      type: "play_immunity_idol",
      actor: P(1),
      cardUid: idolUid,
      protects: P(1),
    });
    t.do({ type: "advance_council", actor: leader, from: "idols" });
    t.do({
      type: "play_idol_nullifier",
      actor: P(2),
      cardUid: t.handCard(2, CardKind.IdolNullifier),
      targetIdolUid: idolUid,
    });
    t.do({ type: "advance_council", actor: leader, from: "nullifiers" });

    // The idol is dead, so the votes count and there is a clear top vote-getter: no ladder at all.
    expect(t.tallyFor(1).immune).toBe(false);
    expect(t.tallyFor(1).countedVotes).toBe(4);
    expect(descents(t)).toEqual([]);
    expect(t.hasLeaderDecision()).toBe(false);
    expect(t.torches(1)).toBe(1);
  });

  it("a player whose Immunity Idol was cancelled by a Nullifier is still a player who played an Immunity Idol", () => {
    // docs/RULES.md:126 — the third rung is "the players who played Immunity Idols", with no
    // qualification about whether the idol survived. Ari plays an idol that Cyd then cancels;
    // Ari is nonetheless immune (Bex protected her) and so sits on neither of the first two
    // rungs. If Ari is also kept off rung 3 she is untouchable, which no rung of the ladder
    // grants anyone.
    const t = startTable(3);
    openCouncil(t, "single", {
      0: [CardKind.ImmunityIdol],
      1: [CardKind.ImmunityIdol, CardKind.ImmunityIdol],
      2: [CardKind.ImmunityIdol, CardKind.IdolNullifier],
    });
    const leader = P(LEADER);
    t.do({ type: "advance_council", actor: leader, from: "advantages" });
    t.do({ type: "advance_council", actor: leader, from: "discussion" });
    for (const [voter, target] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as const) {
      const card = t.player(voter).voteCards[0];
      if (!card) throw new Error("no Vote Card");
      t.do({ type: "cast_vote", actor: P(voter), cardUid: card, target: P(target) });
    }
    t.do({ type: "advance_council", actor: leader, from: "voting" });

    const arisIdol = t.handCard(0, CardKind.ImmunityIdol);
    t.do({
      type: "play_immunity_idol",
      actor: P(0),
      cardUid: arisIdol,
      protects: P(2),
    });
    t.do({
      type: "play_immunity_idol",
      actor: P(1),
      cardUid: t.handCard(1, CardKind.ImmunityIdol),
      protects: P(0),
    });
    t.do({
      type: "play_immunity_idol",
      actor: P(1),
      cardUid: t.handCard(1, CardKind.ImmunityIdol),
      protects: P(2),
    });
    t.do({
      type: "play_immunity_idol",
      actor: P(2),
      cardUid: t.handCard(2, CardKind.ImmunityIdol),
      protects: P(1),
    });
    t.do({ type: "advance_council", actor: leader, from: "idols" });
    t.do({
      type: "play_idol_nullifier",
      actor: P(2),
      cardUid: t.handCard(2, CardKind.IdolNullifier),
      targetIdolUid: arisIdol,
    });
    t.do({ type: "advance_council", actor: leader, from: "nullifiers" });

    // Every remaining player is protected by a live idol, so rungs 1 and 2 are empty.
    for (const seat of [0, 1, 2]) {
      expect(t.tallyFor(seat).immune, `seat ${seat} immune`).toBe(true);
    }
    const pending = t.leaderDecision();
    expect(pending.tier).toBe<TieBreakTier>("played_or_protected_by_idol");
    expect(sorted(pending.candidates)).toEqual(sorted([P(0), P(1), P(2)]));
  });

  it("the disclosed house rule widens tier 3 to the protected players and announces itself", () => {
    const widened: EngineConfig = {
      ...DEFAULT_CONFIG.engine,
      houseRules: {
        ...DEFAULT_CONFIG.engine.houseRules,
        tieBreakIdolTierIncludesProtected: true,
      },
    };
    const t = startTable(4, widened);
    openCouncil(t, "single", idolHands([0], 4));
    runToTally(
      t,
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
      [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );

    const pending = t.leaderDecision();
    expect(pending.tier).toBe<TieBreakTier>("played_or_protected_by_idol");
    expect(sorted(pending.candidates)).toEqual(sorted([P(0), P(1), P(2), P(3)]));

    const announced = t
      .eventsOfType("house_rule_applied")
      .filter((e) => e.rule === "tieBreakIdolTierIncludesProtected");
    expect(announced.length).toBe(1);
  });
});

// ===========================================================================
// The ladder as a whole
// ===========================================================================

describe("the ladder as a whole", () => {
  it("the ladder is walked in exactly the printed order", () => {
    // docs/RULES.md:124-126 — votes first, then no-votes, then idol players. One constant.
    expect([...TIE_BREAK_LADDER]).toEqual([
      "voted_non_immune",
      "unvoted_non_immune",
      "played_or_protected_by_idol",
    ]);
  });

  it("the second elimination of a Double Elimination is decided from tier 1 and excludes the player already turned over", () => {
    const t = startTable(4);
    openCouncil(t, "double");
    // Bex 2 (clear first), Cyd 1 and Dov 1 tied for second, Ari 0.
    runToTally(t, [
      [0, 1],
      [3, 1],
      [1, 2],
      [2, 3],
    ]);

    // The clear top vote-getter goes first, with no Leader decision at all.
    expect(t.torches(1)).toBe(1);

    const pending = t.leaderDecision();
    // docs/RULES.md:120 — "If 1 player gets the most votes, and 2 or more are tied with the
    // second most, the player with the most votes is voted out first. Then, the Tribal Council
    // Leader decides which of the tied players is also voted out."
    expect(pending.reason).toBe("double_tie_for_second");
    expect(pending.tier).toBe<TieBreakTier>("voted_non_immune");
    expect(pending.choose).toBe(1);
    expect(sorted(pending.candidates)).toEqual(sorted([P(2), P(3)]));
    // "2 DIFFERENT players": the player already turned over is off the rung…
    expect(pending.candidates).not.toContain(P(1));
    // …and so is the player who received no votes, because tier 1 still has candidates.
    expect(pending.candidates).not.toContain(P(0));
    expect(descents(t)).toEqual([]);

    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [P(3)],
    });
    expect(t.torches(1)).toBe(1);
    expect(t.torches(3)).toBe(1);
    expect(t.torches(0)).toBe(2);
    expect(t.torches(2)).toBe(2);
  });

  it("every candidate offered at a rung is actually a member of that rung", () => {
    // A Double Elimination where one player played every idol. The first elimination takes the
    // only tier-3 member off the board; the second must still find candidates on a rung whose
    // definition it announces. Offering players who neither played an idol nor were widened in
    // by `tieBreakIdolTierIncludesProtected` (which is OFF here) is the silent-widening failure
    // the ladder's candidate list exists to prevent.
    const t = startTable(4);
    openCouncil(t, "double", idolHands([0], 4));
    runToTally(
      t,
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
      [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    );

    const first = t.leaderDecision();
    expect(first.tier).toBe<TieBreakTier>("played_or_protected_by_idol");
    expect(first.candidates).toEqual([P(0)]);
    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: first.id,
      targets: [P(0)],
    });

    const second = t.leaderDecision();
    const idolPlayers = new Set(t.council().idolPlays.map((i) => i.playedBy));
    if (second.tier === "played_or_protected_by_idol") {
      const widened = t
        .eventsOfType("house_rule_applied")
        .some((e) => e.rule === "tieBreakIdolTierIncludesProtected");
      expect(
        widened,
        "offering players who did not play an Immunity Idol is the widened reading, and the engine promises to announce it",
      ).toBe(true);
      for (const candidate of second.candidates) {
        expect(idolPlayers.has(candidate), `${candidate} played an Immunity Idol`).toBe(
          true,
        );
      }
    }
  });

  it("the Leader cannot advance the council past an open tie-break decision", () => {
    const t = startTable(4);
    openCouncil(t, "single");
    runToTally(t, [
      [0, 1],
      [3, 1],
      [1, 2],
      [2, 2],
    ]);

    expect(t.council().phase).toBe("tie_break");
    const dodged = t.attempt({
      type: "advance_council",
      actor: P(LEADER),
      from: "tie_break",
    });
    expect(dodged.ok).toBe(false);
    if (!dodged.ok) expect(dodged.error.code).toBe("wrong_council_phase");
    expect(t.hasLeaderDecision()).toBe(true);
  });

  it("a Leader who never decides does not wedge the council: the backstop still picks from the reached tier", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([0, 1, 2, 3]));
    runToTally(
      t,
      [
        [0, 1],
        [1, 0],
        [2, 3],
        [3, 2],
      ],
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );

    const pending = t.leaderDecision();
    expect(pending.tier).toBe<TieBreakTier>("played_or_protected_by_idol");
    const candidates = [...pending.candidates];

    t.tick(pending.deadlineMs + 1);

    const expired = t
      .eventsOfType("pending_expired")
      .find((e) => e.pendingId === pending.id);
    expect(expired?.defaultApplied).toBe("leader_choice_auto_selected");

    const chose = t.eventsOfType("leader_chose_eliminations").at(-1);
    expect(chose?.targetIds.length).toBe(1);
    const picked = chose?.targetIds[0];
    expect(picked).toBeDefined();
    // The backstop obeys the same tier the Leader was bound to.
    expect(candidates).toContain(picked);

    const flipped = [0, 1, 2, 3].filter((s) => t.torches(s) === 1);
    expect(flipped.length).toBe(1);
    expect(t.eventsOfType("council_ended").at(-1)).toBeDefined();
    expect(censusOf(t.state)).toEqual([]);
  });

  it("descends one rung at a time and never skips a rung that has candidates", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([0, 1, 2, 3]));
    runToTally(
      t,
      [
        [0, 1],
        [1, 0],
        [2, 3],
        [3, 2],
      ],
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );

    const chain = descents(t);
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]?.from).toBe(chain[i - 1]?.to);
    }
    expect(chain[0]?.from).toBe("voted_non_immune");
    expect(t.leaderDecision().tier).toBe(chain.at(-1)?.to);
  });

  it("a Tribal Council can never end with nobody voted out, even when the whole table is immune", () => {
    const t = startTable(4);
    openCouncil(t, "single", idolHands([0, 1, 2, 3]));
    runToTally(
      t,
      [
        [0, 1],
        [1, 0],
        [2, 3],
        [3, 2],
      ],
      [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );
    const pending = t.leaderDecision();
    t.do({
      type: "leader_choose_eliminations",
      actor: P(LEADER),
      pendingId: pending.id,
      targets: [pending.candidates[0] as PlayerId],
    });

    const ended = t.eventsOfType("council_ended").at(-1);
    expect(ended).toBeDefined();
    expect(ended?.flippedIds.length).toBe(1);
    const totalTorches = [0, 1, 2, 3].reduce((n, s) => n + t.torches(s), 0);
    expect(totalTorches).toBe(7);
  });
});
