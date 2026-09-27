/**
 * STEALING & SORRY FOR YOU
 *
 * The rules under test, from docs/RULES.md:
 *
 *  - Turn step 1 (RULES.md:60): "MANDATORY. Random (i.e. drawn blind from their hand), not
 *    chosen. The victim may respond with Sorry For You, which cancels the steal and forces the
 *    stealer to discard 1 card."
 *  - Sorry For You (RULES.md:434, verbatim Survival Guide): "Play ANY time someone tries to take
 *    cards from you. Instead, they get nothing from you and must discard 1 card (regardless of
 *    how many cards you owe them). This includes any card they attempt to steal from you at the
 *    start of their turn or any cards they would steal from you as an effect of another card
 *    (like the Do Or Die Card). If you play a Sorry For You after a card that would allow more
 *    than 1 player to take cards from you, each of those players gets nothing, and must EACH
 *    discard 1 card instead."
 *  - RULES.md:313 / :545 — stealing from an empty hand is unaddressed by the publisher; the
 *    engine discloses its answer as `houseRules.allowStealFromEmptyHand`, so BOTH settings are
 *    tested rather than one being assumed.
 *
 * Everything here is driven through the pure `reduce`/`advance` API with a fixed seed, so every
 * assertion is deterministic and reproducible.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  type EngineConfig,
  type HouseRulesConfig,
} from "../src/config.js";
import {
  advance,
  censusOf,
  createGame,
  legalActionsFor,
  reduce,
} from "../src/engine/game.js";
import type { GameEvent } from "../src/engine/events.js";
import {
  asGameId,
  asPlayerId,
  CardKind,
  type Action,
  type CardUid,
  type DispatchOutcome,
  type GameErrorCode,
  type GameState,
  type PendingDiscard,
  type PendingTake,
  type PlayerId,
  type Result,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED = 20250909;
const T0 = 1_700_000_000_000;
const TAKE_WINDOW = DEFAULT_CONFIG.engine.timings.pendingWindows.take;

const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eve", "Fay"] as const;
const ARI = asPlayerId("Ari");
const BEX = asPlayerId("Bex");
const CYD = asPlayerId("Cyd");
const DOV = asPlayerId("Dov");

function engineConfig(houseRules: Partial<HouseRulesConfig> = {}): EngineConfig {
  return {
    ...DEFAULT_CONFIG.engine,
    houseRules: { ...DEFAULT_CONFIG.engine.houseRules, ...houseRules },
  };
}

function must(result: Result<DispatchOutcome>): DispatchOutcome {
  if (!result.ok) {
    throw new Error(`action rejected: ${result.error.code} — ${result.error.message}`);
  }
  return result.value;
}

/** A started game: N players seated in `NAMES` order, `Ari` first, deterministic deck. */
function started(
  playerCount: number,
  houseRules: Partial<HouseRulesConfig> = {},
  seed = SEED,
): GameState {
  const ids = NAMES.slice(0, playerCount).map((n) => asPlayerId(n));
  const first = ids[0];
  if (!first) throw new Error("playerCount must be >= 1");
  const game = createGame({
    gameId: asGameId("test-game"),
    hostId: first,
    config: engineConfig(houseRules),
    nowMs: T0,
    seed,
  });
  let state = game.state();
  for (const id of ids) {
    state = must(
      reduce(state, { type: "join_game", actor: id, displayName: id }, T0),
    ).state;
  }
  state = must(
    reduce(state, { type: "start_game", actor: first, firstPlayer: first }, T0),
  ).state;
  return state;
}

// ---------------------------------------------------------------------------
// State surgery (census-preserving)
// ---------------------------------------------------------------------------

interface MutablePlayer {
  id: PlayerId;
  seat: number;
  hand: CardUid[];
  voteCards: CardUid[];
  grantedVotes: CardUid[];
  characterCards: { uid: CardUid; flipped: boolean; flippedAtSeq: number | null }[];
  eliminatedAtSeq: number | null;
  leftAtSeq: number | null;
}

interface MutableState {
  players: MutablePlayer[];
  cards: { uid: CardUid; kind: CardKind }[];
  zones: {
    drawPile: CardUid[];
    discardPile: CardUid[];
    removedFromGame: CardUid[];
    voteCardBank: CardUid[];
    votingBox: CardUid[];
    inPlay: CardUid[];
  };
  seq: number;
}

function mutate(state: GameState, fn: (draft: MutableState) => void): GameState {
  const draft = structuredClone(state) as unknown as MutableState;
  fn(draft);
  const next = draft as unknown as GameState;
  // Surgery must never unbalance the deck; a broken fixture would silently fake a pass.
  expect(censusOf(next)).toEqual([]);
  return next;
}

const kindIndex = (draft: MutableState): Map<CardUid, CardKind> =>
  new Map(draft.cards.map((c) => [c.uid, c.kind]));

/**
 * Replace the named players' hands with exactly those card kinds, drawing the replacements out
 * of the draw pile and returning the old hands to it. Card identity and the census are
 * preserved; only which zone each card sits in changes.
 */
function setHands(state: GameState, spec: Record<string, CardKind[]>): GameState {
  return mutate(state, (draft) => {
    const kinds = kindIndex(draft);
    const named = Object.keys(spec).map((id) => {
      const player = draft.players.find((p) => p.id === id);
      if (!player) throw new Error(`setHands: no player ${id}`);
      return player;
    });
    for (const player of named) {
      draft.zones.drawPile.push(...player.hand);
      player.hand = [];
    }
    for (const player of named) {
      for (const kind of spec[player.id] ?? []) {
        const at = draft.zones.drawPile.findIndex((uid) => kinds.get(uid) === kind);
        if (at < 0) throw new Error(`setHands: no free ${kind} left in the deck`);
        const [uid] = draft.zones.drawPile.splice(at, 1);
        if (uid) player.hand.push(uid);
      }
    }
  });
}

/** Force the next draws, in order, so a test never draws a Tribal Council card by accident. */
function setTopOfDraw(state: GameState, kinds: CardKind[]): GameState {
  return mutate(state, (draft) => {
    const index = kindIndex(draft);
    const picked: CardUid[] = [];
    for (const kind of kinds) {
      const at = draft.zones.drawPile.findIndex((uid) => index.get(uid) === kind);
      if (at < 0) throw new Error(`setTopOfDraw: no free ${kind} left in the deck`);
      const [uid] = draft.zones.drawPile.splice(at, 1);
      if (uid) picked.push(uid);
    }
    draft.zones.drawPile.unshift(...picked);
  });
}

/** Both Survivor Character Cards turned over: fully eliminated, and on the Jury. */
function eliminate(state: GameState, playerId: PlayerId): GameState {
  return mutate(state, (draft) => {
    const player = draft.players.find((p) => p.id === playerId);
    if (!player) throw new Error(`eliminate: no player ${playerId}`);
    player.characterCards = player.characterCards.map((c) => ({
      ...c,
      flipped: true,
      flippedAtSeq: draft.seq,
    }));
    player.eliminatedAtSeq = draft.seq;
  });
}

/** Left the table entirely: not on any jury, never a legal target. */
function depart(state: GameState, playerId: PlayerId): GameState {
  return mutate(state, (draft) => {
    const player = draft.players.find((p) => p.id === playerId);
    if (!player) throw new Error(`depart: no player ${playerId}`);
    player.leftAtSeq = draft.seq;
  });
}

// ---------------------------------------------------------------------------
// Reading state and events
// ---------------------------------------------------------------------------

type EventOf<T extends GameEvent["type"]> = Extract<GameEvent, { type: T }>;

function eventsOf<T extends GameEvent["type"]>(
  outcome: DispatchOutcome,
  type: T,
): EventOf<T>[] {
  return outcome.events.filter((e): e is EventOf<T> => e.type === type);
}

function oneEvent<T extends GameEvent["type"]>(
  outcome: DispatchOutcome,
  type: T,
): EventOf<T> {
  const found = eventsOf(outcome, type);
  expect(found, `expected exactly one ${type} event`).toHaveLength(1);
  const first = found[0];
  if (!first) throw new Error(`no ${type} event`);
  return first;
}

const openTakes = (state: GameState): PendingTake[] =>
  state.pending.filter((p): p is PendingTake => p.kind === "take");

const openDiscards = (state: GameState): PendingDiscard[] =>
  state.pending.filter((p): p is PendingDiscard => p.kind === "discard");

function takeAgainst(state: GameState, victimId: PlayerId): PendingTake {
  const found = openTakes(state).filter((t) => t.victimId === victimId);
  expect(found, `expected exactly one open take against ${victimId}`).toHaveLength(1);
  const first = found[0];
  if (!first) throw new Error(`no open take against ${victimId}`);
  return first;
}

function discardFor(state: GameState, playerId: PlayerId): PendingDiscard {
  const found = openDiscards(state).filter((d) => d.playerId === playerId);
  expect(found, `expected exactly one open discard for ${playerId}`).toHaveLength(1);
  const first = found[0];
  if (!first) throw new Error(`no open discard for ${playerId}`);
  return first;
}

const player = (state: GameState, id: PlayerId) => {
  const found = state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
};

const handOf = (state: GameState, id: PlayerId): readonly CardUid[] =>
  player(state, id).hand;
const handSize = (state: GameState, id: PlayerId): number => handOf(state, id).length;

const kindOf = (state: GameState, uid: CardUid): CardKind => {
  const card = state.cards.find((c) => c.uid === uid);
  if (!card) throw new Error(`no card ${uid}`);
  return card.kind;
};

const handKinds = (state: GameState, id: PlayerId): CardKind[] =>
  handOf(state, id).map((uid) => kindOf(state, uid));

const firstOfKind = (state: GameState, id: PlayerId, kind: CardKind): CardUid => {
  const uid = handOf(state, id).find((u) => kindOf(state, u) === kind);
  if (!uid) throw new Error(`${id} holds no ${kind}`);
  return uid;
};

/** A tiny driver so a scenario reads as the sequence of table actions it is. */
class Sim {
  state: GameState;
  last: DispatchOutcome | null = null;

  constructor(state: GameState) {
    this.state = state;
  }

  do(action: Action, nowMs = T0): DispatchOutcome {
    const outcome = must(reduce(this.state, action, nowMs));
    this.state = outcome.state;
    this.last = outcome;
    expect(censusOf(this.state), "card census must balance after every action").toEqual(
      [],
    );
    return outcome;
  }

  tick(nowMs: number): DispatchOutcome {
    const outcome = advance(this.state, nowMs);
    this.state = outcome.state;
    this.last = outcome;
    expect(censusOf(this.state), "card census must balance after every tick").toEqual(
      [],
    );
    return outcome;
  }

  /** Turn step 1, taken to completion with no Sorry For You. */
  stealAndDecline(actor: PlayerId, target: PlayerId): DispatchOutcome {
    this.do({ type: "steal_random", actor, target });
    const take = takeAgainst(this.state, target);
    return this.do({ type: "decline_reaction", actor: target, pendingId: take.id });
  }
}

function rejects(
  state: GameState,
  action: Action,
  code: GameErrorCode,
  nowMs = T0,
): void {
  const before = structuredClone(state);
  const result = reduce(state, action, nowMs);
  expect(result.ok, `expected ${action.type} to be rejected with ${code}`).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  // Audit #49: validation must never mutate. The caller's own object must be untouched.
  expect(state).toEqual(before);
}

// ===========================================================================
// The turn steal
// ===========================================================================

describe("turn step 1: the mandatory steal", () => {
  it("takes exactly one card drawn blind from the victim's hand, uniformly at random", () => {
    const base = setHands(started(3), {
      Bex: [
        CardKind.SorryForYou,
        CardKind.ExtraVote,
        CardKind.Inheritance,
        CardKind.ImmunityIdol,
        CardKind.CampRaid,
      ],
    });

    const TRIALS = 500;
    const counts = new Map<CardKind, number>();
    // One seeded RNG stream, carried across trials, with the table reset each time: the
    // distribution is a property of the engine's shuffle, and the whole run is reproducible.
    let rng = base.rng;

    for (let i = 0; i < TRIALS; i += 1) {
      const trial: GameState = { ...base, rng };
      const declared = must(
        reduce(trial, { type: "steal_random", actor: ARI, target: BEX }, T0),
      );
      const take = takeAgainst(declared.state, BEX);
      expect(take.spec).toEqual({ kind: "random", count: 1 });
      const resolved = must(
        reduce(
          declared.state,
          { type: "decline_reaction", actor: BEX, pendingId: take.id },
          T0,
        ),
      );

      const moved = oneEvent(resolved, "take_resolved");
      expect(moved.cardUids).toHaveLength(1);
      expect(handSize(resolved.state, BEX)).toBe(4);
      expect(handSize(resolved.state, ARI)).toBe(handSize(base, ARI) + 1);

      const kind = moved.kinds[0];
      if (!kind) throw new Error("take_resolved carried no card kind");
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      rng = resolved.state.rng;
    }

    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(TRIALS);
    // Five equiprobable cards: mean 100, sd ~8.9. [70,130] is ±3.4 sd — a band a fair shuffle
    // clears and a biased one (e.g. always the first or last card) cannot.
    expect(counts.size, "every card in the hand must be reachable").toBe(5);
    for (const [kind, n] of counts) {
      expect(
        n,
        `${kind} was stolen ${n} times out of ${TRIALS}`,
      ).toBeGreaterThanOrEqual(70);
      expect(n, `${kind} was stolen ${n} times out of ${TRIALS}`).toBeLessThanOrEqual(
        130,
      );
    }
  });

  it("is random, not chosen: the thief is never offered a card to name", () => {
    const state = setHands(started(3), {
      Bex: [CardKind.SorryForYou, CardKind.ExtraVote, CardKind.Inheritance],
    });
    const legal = legalActionsFor(state, ARI, T0).filter(
      (a) => a.kind === "steal_random",
    );
    expect(legal).toHaveLength(1);
    expect(legal[0]?.optionCardUids).toBeUndefined();
    expect(legal[0]?.playableCardUids).toBeUndefined();

    const sim = new Sim(state);
    const declared = sim.do({ type: "steal_random", actor: ARI, target: BEX });
    // The public announcement names the selection MODE, never a card.
    expect(oneEvent(declared, "take_declared").selection).toBe("random");
    expect(oneEvent(declared, "take_declared").count).toBe(1);
  });

  it("cannot be aimed at yourself", () => {
    rejects(
      started(3),
      { type: "steal_random", actor: ARI, target: ARI },
      "self_target_not_allowed",
    );
  });

  it("cannot be aimed at a fully eliminated player", () => {
    const state = eliminate(setHands(started(4), { Cyd: [CardKind.ExtraVote] }), CYD);
    rejects(state, { type: "steal_random", actor: ARI, target: CYD }, "invalid_target");
    expect(
      legalActionsFor(state, ARI, T0).find((a) => a.kind === "steal_random")
        ?.legalTargets,
    ).not.toContain(CYD);
  });

  it("cannot be aimed at a player who has left the table", () => {
    const state = depart(setHands(started(4), { Cyd: [CardKind.ExtraVote] }), CYD);
    rejects(state, { type: "steal_random", actor: ARI, target: CYD }, "invalid_target");
  });

  it("against an empty hand takes nothing, and still spends the mandatory steal step", () => {
    const sim = new Sim(setHands(started(3), { Bex: [] }));
    const before = handSize(sim.state, ARI);

    sim.do({ type: "steal_random", actor: ARI, target: BEX });
    const take = takeAgainst(sim.state, BEX);
    const resolved = sim.do({
      type: "decline_reaction",
      actor: BEX,
      pendingId: take.id,
    });

    const nothing = oneEvent(resolved, "take_found_nothing");
    expect(nothing.takerId).toBe(ARI);
    expect(nothing.victimId).toBe(BEX);
    expect(eventsOf(resolved, "take_resolved")).toHaveLength(0);
    expect(handSize(sim.state, ARI)).toBe(before);
    expect(handSize(sim.state, BEX)).toBe(0);
    // Step 1 is spent even though nothing moved: the turn is not deadlocked (RULES.md:313).
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.phase).toBe("play");
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.stealResolved).toBe(
      true,
    );
  });

  it("against an empty hand is refused when the table disallows it", () => {
    const state = setHands(started(3, { allowStealFromEmptyHand: false }), { Bex: [] });
    rejects(state, { type: "steal_random", actor: ARI, target: BEX }, "invalid_target");
    expect(
      legalActionsFor(state, ARI, T0).find((a) => a.kind === "steal_random")
        ?.legalTargets,
    ).not.toContain(BEX);
  });

  it("must happen before the play step begins", () => {
    const state = started(3);
    rejects(state, { type: "skip_play_step", actor: ARI }, "steal_step_not_done");
    rejects(state, { type: "draw_card", actor: ARI }, "steal_step_not_done");
  });

  it("happens at most once per turn", () => {
    const sim = new Sim(
      setHands(started(3), { Bex: [CardKind.ExtraVote, CardKind.CampRaid] }),
    );
    sim.stealAndDecline(ARI, BEX);
    rejects(
      sim.state,
      { type: "steal_random", actor: ARI, target: CYD },
      "wrong_turn_phase",
    );
  });

  it("once declared, tells the thief it is being answered — never to steal first", () => {
    // Twenty seconds after stealing, "steal first" reads as the bot having lost the move. The
    // steal IS done as far as the thief can act on it; what is open is the victim's window.
    const sim = new Sim(setHands(started(3), { Bex: [CardKind.ExtraVote] }));
    sim.do({ type: "steal_random", actor: ARI, target: BEX });
    expect(openTakes(sim.state)).toHaveLength(1);

    rejects(sim.state, { type: "skip_play_step", actor: ARI }, "steal_being_answered");
    rejects(sim.state, { type: "draw_card", actor: ARI }, "steal_being_answered");
    rejects(
      sim.state,
      { type: "steal_random", actor: ARI, target: CYD },
      "steal_being_answered",
    );
  });

  it("cannot be armed a second time while the first steal is still awaiting a reaction", () => {
    // "Steal one random card from a chosen player" — ONE steal, from ONE player. The window
    // being open is not permission to declare another: audit #83 is exactly "two steals can be
    // armed at once and one Sorry For You cancels both", which the PendingId model is supposed
    // to make unreachable. The engine, not the renderer, is the rule authority here.
    const sim = new Sim(
      setHands(started(3), {
        Bex: [CardKind.ExtraVote, CardKind.CampRaid],
        Cyd: [CardKind.ExtraVote, CardKind.Inheritance],
      }),
    );
    sim.do({ type: "steal_random", actor: ARI, target: BEX });
    expect(openTakes(sim.state)).toHaveLength(1);

    const second = reduce(
      sim.state,
      { type: "steal_random", actor: ARI, target: CYD },
      T0,
    );
    expect(second.ok, "a second simultaneous turn steal must be refused").toBe(false);
    if (second.ok) {
      expect(
        openTakes(second.value.state),
        "the turn steal may never arm two take windows at once",
      ).toHaveLength(1);
    }
  });

  it("is not declared against an empty hand by the backstop when the table forbids it", () => {
    // The engine refuses `steal_random` against an empty-handed player under this house rule
    // (RULES.md:313 flags the case as unaddressed by the publisher, which is why the setting
    // exists). The turn backstop must reach the same answer the player was given, not declare
    // the very steal the rule just refused.
    const sim = new Sim(
      setHands(started(3, { allowStealFromEmptyHand: false }), { Bex: [], Cyd: [] }),
    );
    expect(
      legalActionsFor(sim.state, ARI, T0).find((a) => a.kind === "steal_random")
        ?.legalTargets,
    ).toEqual([]);
    rejects(
      sim.state,
      { type: "steal_random", actor: ARI, target: BEX },
      "invalid_target",
    );

    const backstop = sim.tick(T0 + DEFAULT_CONFIG.engine.timings.turnSafetyTimeout + 1);
    expect(
      eventsOf(backstop, "take_declared"),
      "the backstop must not declare a steal the rules refuse",
    ).toHaveLength(0);
    // The turn must still make progress rather than wedge (RULES.md:545).
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.stealResolved).toBe(
      true,
    );
  });

  it("does not reach the Vote Card, which is held apart from the hand", () => {
    const sim = new Sim(setHands(started(3), { Bex: [CardKind.CampRaid] }));
    const voteCardsBefore = [...player(sim.state, BEX).voteCards];
    expect(voteCardsBefore.length).toBe(1);

    const resolved = sim.stealAndDecline(ARI, BEX);
    expect(oneEvent(resolved, "take_resolved").kinds).toEqual([CardKind.CampRaid]);
    expect(player(sim.state, BEX).voteCards).toEqual(voteCardsBefore);
    expect(handKinds(sim.state, ARI)).toContain(CardKind.CampRaid);
  });
});

// ===========================================================================
// Sorry For You: what it blocks
// ===========================================================================

describe("Sorry For You blocks every attempt to take cards from you", () => {
  it("blocks the mandatory turn-start steal: the thief gets nothing and discards exactly 1", () => {
    const sim = new Sim(
      setHands(started(3), {
        Ari: [CardKind.Inheritance, CardKind.ExtraVote],
        Bex: [CardKind.SorryForYou, CardKind.ImmunityIdol, CardKind.CampRaid],
      }),
    );
    const sorry = firstOfKind(sim.state, BEX, CardKind.SorryForYou);

    sim.do({ type: "steal_random", actor: ARI, target: BEX });
    const take = takeAgainst(sim.state, BEX);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: sorry,
      pendingId: take.id,
    });

    const takeBlocked = oneEvent(blocked, "take_blocked");
    expect(takeBlocked.victimId).toBe(BEX);
    expect(takeBlocked.blockedTakerIds).toEqual([ARI]);
    expect(takeBlocked.sorryCardUid).toBe(sorry);
    // "they get nothing from you": no card ever moved.
    expect(eventsOf(blocked, "take_resolved")).toHaveLength(0);
    expect(eventsOf(blocked, "cards_transferred")).toHaveLength(0);
    expect(handKinds(sim.state, BEX).sort()).toEqual(
      [CardKind.ImmunityIdol, CardKind.CampRaid].sort(),
    );
    expect(sim.state.zones.discardPile).toContain(sorry);

    // "and must discard 1 card"
    const opened = oneEvent(blocked, "forced_discard_opened");
    expect(opened.playerId).toBe(ARI);
    expect(opened.count).toBe(1);
    expect(opened.reason).toBe("sorry_for_you_penalty");

    const penalty = discardFor(sim.state, ARI);
    const toss = firstOfKind(sim.state, ARI, CardKind.Inheritance);
    const paid = sim.do({
      type: "discard_card",
      actor: ARI,
      cardUid: toss,
      pendingId: penalty.id,
    });
    expect(oneEvent(paid, "card_discarded").cardUid).toBe(toss);
    expect(handKinds(sim.state, ARI)).toEqual([CardKind.ExtraVote]);
    expect(openDiscards(sim.state)).toHaveLength(0);

    // "The thief still had to declare the steal, so their turn's steal step is spent."
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.stealResolved).toBe(
      true,
    );
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.phase).toBe("play");
  });

  it("costs a thief with an empty hand nothing, and opens no window nobody can answer", () => {
    // RULES.md:545 — "Sorry For You forcing a discard from a thief whose hand is now empty" is
    // explicitly unaddressed. Whatever the answer, it may not leave an unanswerable window.
    const sim = new Sim(
      setHands(started(3), { Ari: [], Bex: [CardKind.SorryForYou, CardKind.CampRaid] }),
    );
    sim.do({ type: "steal_random", actor: ARI, target: BEX });
    const take = takeAgainst(sim.state, BEX);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.SorryForYou),
      pendingId: take.id,
    });

    expect(oneEvent(blocked, "take_blocked").blockedTakerIds).toEqual([ARI]);
    expect(eventsOf(blocked, "forced_discard_opened")).toHaveLength(0);
    expect(openDiscards(sim.state)).toHaveLength(0);
    expect(sim.state.pending).toHaveLength(0);
    expect(handSize(sim.state, ARI)).toBe(0);
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.phase).toBe("play");
  });

  it("blocks The Spy Shack: no card is chosen and the spy discards 1", () => {
    const sim = new Sim(setHands(started(3), { Cyd: [] }));
    sim.stealAndDecline(ARI, CYD);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.TheSpyShack, CardKind.ExtraVote, CardKind.Inheritance],
      Bex: [CardKind.SorryForYou, CardKind.ImmunityIdol, CardKind.CampRaid],
    });

    const spyShack = firstOfKind(sim.state, ARI, CardKind.TheSpyShack);
    sim.do({ type: "play_spy_shack", actor: ARI, cardUid: spyShack, target: BEX });
    const take = takeAgainst(sim.state, BEX);
    expect(take.spec.kind).toBe("chosen");

    const sorry = firstOfKind(sim.state, BEX, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: sorry,
      pendingId: take.id,
    });

    expect(oneEvent(blocked, "take_blocked").blockedTakerIds).toEqual([ARI]);
    // The spy never gets to pick: no card_choice window is opened by a blocked take.
    expect(sim.state.pending.filter((p) => p.kind === "card_choice")).toHaveLength(0);
    expect(handKinds(sim.state, BEX).sort()).toEqual(
      [CardKind.ImmunityIdol, CardKind.CampRaid].sort(),
    );
    expect(oneEvent(blocked, "forced_discard_opened")).toMatchObject({
      playerId: ARI,
      count: 1,
    });
  });

  it("blocks Knowledge is Power: the named card stays put and the asker discards 1", () => {
    const sim = new Sim(setHands(started(3), { Cyd: [] }));
    sim.stealAndDecline(ARI, CYD);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.KnowledgeIsPower, CardKind.ExtraVote, CardKind.Inheritance],
      Bex: [CardKind.SorryForYou, CardKind.ImmunityIdol],
    });

    const kip = firstOfKind(sim.state, ARI, CardKind.KnowledgeIsPower);
    const idol = firstOfKind(sim.state, BEX, CardKind.ImmunityIdol);
    const asked = sim.do({
      type: "play_knowledge_is_power",
      actor: ARI,
      cardUid: kip,
      target: BEX,
      named: CardKind.ImmunityIdol,
    });
    expect(oneEvent(asked, "knowledge_is_power_answered").hit).toBe(true);

    const take = takeAgainst(sim.state, BEX);
    expect(take.spec).toEqual({ kind: "specific", cardUids: [idol] });

    const sorry = firstOfKind(sim.state, BEX, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: sorry,
      pendingId: take.id,
    });

    expect(oneEvent(blocked, "take_blocked").blockedTakerIds).toEqual([ARI]);
    expect(handOf(sim.state, BEX)).toContain(idol);
    expect(handOf(sim.state, ARI)).not.toContain(idol);
    expect(oneEvent(blocked, "forced_discard_opened")).toMatchObject({
      playerId: ARI,
      count: 1,
    });
  });

  it("blocks Camp Raid: the victim keeps the card they drew and the raider discards 1", () => {
    let state = setHands(started(3), {
      Ari: [CardKind.CampRaid, CardKind.Inheritance, CardKind.ExtraVote],
      Bex: [CardKind.SorryForYou],
      Cyd: [],
    });
    // Neither draw may be a Tribal Council card: this test is about the raid, not a council.
    state = setTopOfDraw(state, [CardKind.PowerPair, CardKind.ImmunityIdol]);
    const sim = new Sim(state);

    const raid = firstOfKind(sim.state, ARI, CardKind.CampRaid);
    sim.stealAndDecline(ARI, CYD);
    sim.do({ type: "play_camp_raid", actor: ARI, cardUid: raid, target: BEX });
    expect(player(sim.state, BEX).campRaid?.raiderId).toBe(ARI);
    sim.do({ type: "draw_card", actor: ARI });

    // Bex's turn: steal, skip, then draw — the moment the raid resolves.
    expect(sim.state.stage.kind === "turn" && sim.state.stage.turn.playerId).toBe(BEX);
    sim.stealAndDecline(BEX, CYD);
    sim.do({ type: "skip_play_step", actor: BEX });
    const drew = sim.do({ type: "draw_card", actor: BEX });
    const drawn = oneEvent(drew, "card_drawn").cardUid;

    const take = takeAgainst(sim.state, BEX);
    expect(take.origin.kind).toBe("camp_raid");
    expect(take.spec).toEqual({ kind: "specific", cardUids: [drawn] });

    const sorry = firstOfKind(sim.state, BEX, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: sorry,
      pendingId: take.id,
    });

    expect(oneEvent(blocked, "take_blocked").blockedTakerIds).toEqual([ARI]);
    // "the victim keeps the card they drew"
    expect(handOf(sim.state, BEX)).toContain(drawn);
    expect(handOf(sim.state, ARI)).not.toContain(drawn);
    // The marker card is spent either way.
    expect(sim.state.zones.discardPile).toContain(raid);
    expect(player(sim.state, BEX).campRaid).toBeNull();
    expect(oneEvent(blocked, "forced_discard_opened")).toMatchObject({
      playerId: ARI,
      count: 1,
    });
  });

  it("blocks a Do or Die payout, and the loser discards 1 no matter how many they owed", () => {
    const sim = new Sim(setHands(started(3), { Cyd: [] }));
    sim.stealAndDecline(ARI, CYD);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.DoOrDie, CardKind.Inheritance, CardKind.ExtraVote],
      Bex: [CardKind.SorryForYou, CardKind.ImmunityIdol, CardKind.CampRaid],
      Cyd: [],
    });

    const doOrDie = firstOfKind(sim.state, ARI, CardKind.DoOrDie);
    sim.do({ type: "play_do_or_die", actor: ARI, cardUid: doOrDie, opponent: BEX });
    const challenge = sim.state.pending.find((p) => p.kind === "challenge");
    if (!challenge) throw new Error("no challenge opened");

    sim.do({
      type: "submit_challenge_choice",
      actor: ARI,
      pendingId: challenge.id,
      submission: { kind: "rps", throw: "rock" },
    });
    const settled = sim.do({
      type: "submit_challenge_choice",
      actor: BEX,
      pendingId: challenge.id,
      submission: { kind: "rps", throw: "scissors" },
    });
    expect(oneEvent(settled, "challenge_resolved").outcome).toMatchObject({
      kind: "rps_decisive",
      winnerId: ARI,
      loserId: BEX,
    });

    // "the winner steals 2 random cards from the loser" — TWO cards are owed.
    const take = takeAgainst(sim.state, BEX);
    expect(take.spec).toEqual({ kind: "random", count: 2 });
    expect(oneEvent(settled, "take_declared").count).toBe(2);

    const bexHandBefore = [...handOf(sim.state, BEX)];
    const ariHandBefore = handSize(sim.state, ARI);
    const sorry = firstOfKind(sim.state, BEX, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: sorry,
      pendingId: take.id,
    });

    // "they get nothing from you and must discard 1 card (regardless of how many cards you
    // owe them)": 2 cards owed, ONE card discarded, and no transfer at all.
    expect(eventsOf(blocked, "take_resolved")).toHaveLength(0);
    expect(eventsOf(blocked, "cards_transferred")).toHaveLength(0);
    expect(handOf(sim.state, BEX)).toEqual(
      bexHandBefore.filter((uid) => uid !== sorry),
    );
    expect(handSize(sim.state, ARI)).toBe(ariHandBefore);

    const penalties = eventsOf(blocked, "forced_discard_opened");
    expect(penalties).toHaveLength(1);
    expect(penalties[0]).toMatchObject({ playerId: ARI, count: 1 });
    expect(openDiscards(sim.state)).toHaveLength(1);
    expect(discardFor(sim.state, ARI).count).toBe(1);

    sim.do({
      type: "discard_card",
      actor: ARI,
      cardUid: firstOfKind(sim.state, ARI, CardKind.Inheritance),
      pendingId: discardFor(sim.state, ARI).id,
    });
    expect(handSize(sim.state, ARI)).toBe(ariHandBefore - 1);
    expect(openDiscards(sim.state)).toHaveLength(0);
  });
});

// ===========================================================================
// Sorry For You: the multi-taker clause
// ===========================================================================

describe("one Sorry For You against a multi-player take blanks EVERY taker", () => {
  it("stops both Let's Form an Alliance partners and makes EACH of them discard 1", () => {
    const sim = new Sim(setHands(started(4), { Dov: [] }));
    sim.stealAndDecline(ARI, DOV);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.LetsFormAnAlliance, CardKind.Inheritance, CardKind.ExtraVote],
      Bex: [CardKind.Inheritance, CardKind.ExtraVote],
      Cyd: [CardKind.SorryForYou, CardKind.ImmunityIdol, CardKind.CampRaid],
      Dov: [],
    });

    const alliance = firstOfKind(sim.state, ARI, CardKind.LetsFormAnAlliance);
    sim.do({
      type: "play_lets_form_an_alliance",
      actor: ARI,
      cardUid: alliance,
      partner: BEX,
      victim: CYD,
    });
    const target = sim.state.pending.find((p) => p.kind === "alliance_target");
    if (!target) throw new Error("no alliance_target window opened");
    // The partner names the SAME victim: "You can steal from the same player."
    sim.do({
      type: "choose_alliance_target",
      actor: BEX,
      pendingId: target.id,
      target: CYD,
    });

    // GROUPING INVARIANT: one PendingTake per (effect, victim), with both takers on it — so a
    // single Sorry For You can reach both of them.
    const takes = openTakes(sim.state);
    expect(takes).toHaveLength(1);
    const take = takes[0];
    if (!take) throw new Error("no take");
    expect([...take.takerIds].sort()).toEqual([ARI, BEX].sort());
    expect(take.victimId).toBe(CYD);

    const cydHandBefore = [...handOf(sim.state, CYD)];
    const ariBefore = handSize(sim.state, ARI);
    const bexBefore = handSize(sim.state, BEX);
    const sorry = firstOfKind(sim.state, CYD, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: CYD,
      cardUid: sorry,
      pendingId: take.id,
    });

    const takeBlocked = oneEvent(blocked, "take_blocked");
    expect([...takeBlocked.blockedTakerIds].sort()).toEqual([ARI, BEX].sort());
    // "each of those players gets nothing"
    expect(eventsOf(blocked, "take_resolved")).toHaveLength(0);
    expect(handOf(sim.state, CYD)).toEqual(
      cydHandBefore.filter((uid) => uid !== sorry),
    );
    expect(handSize(sim.state, ARI)).toBe(ariBefore);
    expect(handSize(sim.state, BEX)).toBe(bexBefore);

    // "and must EACH discard 1 card instead"
    const penalties = eventsOf(blocked, "forced_discard_opened");
    expect(penalties).toHaveLength(2);
    expect(penalties.map((p) => p.playerId).sort()).toEqual([ARI, BEX].sort());
    expect(penalties.every((p) => p.count === 1)).toBe(true);
    expect(openDiscards(sim.state)).toHaveLength(2);

    sim.do({
      type: "discard_card",
      actor: ARI,
      cardUid: firstOfKind(sim.state, ARI, CardKind.Inheritance),
      pendingId: discardFor(sim.state, ARI).id,
    });
    sim.do({
      type: "discard_card",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.Inheritance),
      pendingId: discardFor(sim.state, BEX).id,
    });
    expect(handSize(sim.state, ARI)).toBe(ariBefore - 1);
    expect(handSize(sim.state, BEX)).toBe(bexBefore - 1);
    expect(openDiscards(sim.state)).toHaveLength(0);
  });

  it("stops both matched Power Pair players and makes EACH of them discard 1", () => {
    const sim = new Sim(setHands(started(3), { Bex: [] }));
    sim.stealAndDecline(ARI, BEX);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.PowerPair, CardKind.SorryForYou, CardKind.ExtraVote],
      Bex: [CardKind.Inheritance],
      Cyd: [CardKind.Inheritance],
    });

    const powerPair = firstOfKind(sim.state, ARI, CardKind.PowerPair);
    sim.do({
      type: "play_power_pair",
      actor: ARI,
      cardUid: powerPair,
      first: BEX,
      second: CYD,
    });
    const challenge = sim.state.pending.find((p) => p.kind === "challenge");
    if (!challenge) throw new Error("no challenge opened");
    for (const [actor, count] of [
      [ARI, 1],
      [BEX, 2],
      [CYD, 2],
    ] as const) {
      sim.do({
        type: "submit_challenge_choice",
        actor,
        pendingId: challenge.id,
        submission: { kind: "fingers", count },
      });
    }

    // "exactly 2 matching = those two each steal 1 random card from the third"
    const take = takeAgainst(sim.state, ARI);
    expect([...take.takerIds].sort()).toEqual([BEX, CYD].sort());
    expect(take.spec).toEqual({ kind: "random", count: 2 });

    const sorry = firstOfKind(sim.state, ARI, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: ARI,
      cardUid: sorry,
      pendingId: take.id,
    });

    expect([...oneEvent(blocked, "take_blocked").blockedTakerIds].sort()).toEqual(
      [BEX, CYD].sort(),
    );
    expect(eventsOf(blocked, "take_resolved")).toHaveLength(0);
    const penalties = eventsOf(blocked, "forced_discard_opened");
    expect(penalties).toHaveLength(2);
    expect(penalties.map((p) => p.playerId).sort()).toEqual([BEX, CYD].sort());
    expect(penalties.every((p) => p.count === 1)).toBe(true);
  });

  it("blanks only the ally who named that victim when the two allies name different victims", () => {
    const sim = new Sim(setHands(started(4), { Dov: [] }));
    sim.stealAndDecline(ARI, DOV);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.LetsFormAnAlliance, CardKind.Inheritance],
      Bex: [],
      Cyd: [CardKind.SorryForYou, CardKind.ImmunityIdol],
      Dov: [CardKind.CampRaid, CardKind.ExtraVote],
    });

    const alliance = firstOfKind(sim.state, ARI, CardKind.LetsFormAnAlliance);
    sim.do({
      type: "play_lets_form_an_alliance",
      actor: ARI,
      cardUid: alliance,
      partner: BEX,
      victim: CYD,
    });
    const target = sim.state.pending.find((p) => p.kind === "alliance_target");
    if (!target) throw new Error("no alliance_target window opened");
    sim.do({
      type: "choose_alliance_target",
      actor: BEX,
      pendingId: target.id,
      target: DOV,
    });

    const takes = openTakes(sim.state);
    expect(takes).toHaveLength(2);
    const effectIds = new Set(takes.map((t) => t.origin.effectId));
    expect(effectIds.size, "both takes come from the one card play").toBe(1);

    const cydTake = takeAgainst(sim.state, CYD);
    const dovTake = takeAgainst(sim.state, DOV);
    expect(cydTake.takerIds).toEqual([ARI]);
    expect(dovTake.takerIds).toEqual([BEX]);

    const sorry = firstOfKind(sim.state, CYD, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: CYD,
      cardUid: sorry,
      pendingId: cydTake.id,
    });

    expect(oneEvent(blocked, "take_blocked").blockedTakerIds).toEqual([ARI]);
    const penalties = eventsOf(blocked, "forced_discard_opened");
    expect(penalties).toHaveLength(1);
    expect(penalties[0]?.playerId).toBe(ARI);
    // Bex's separate take against Dov is untouched by Cyd's card.
    expect(sim.state.pending.some((p) => p.id === dovTake.id)).toBe(true);

    sim.do({
      type: "discard_card",
      actor: ARI,
      cardUid: firstOfKind(sim.state, ARI, CardKind.Inheritance),
      pendingId: discardFor(sim.state, ARI).id,
    });
    const dovResolved = sim.do({
      type: "decline_reaction",
      actor: DOV,
      pendingId: dovTake.id,
    });
    expect(oneEvent(dovResolved, "take_resolved").takerId).toBe(BEX);
    expect(handSize(sim.state, BEX)).toBe(1);
    expect(handSize(sim.state, DOV)).toBe(1);
  });
});

// ===========================================================================
// The chosen-steal house rule actually steals
// ===========================================================================

describe("Let's Form an Alliance with houseRules.allianceStealIsRandom off", () => {
  /**
   * "You and your partner EACH steal 1 card from any other player (for a total of 2 cards
   * stolen)." (docs/RULES.md, Let's Form an Alliance.)
   *
   * The Survival Guide text for this card omits the word "random" that Power Pair, Do or Die and
   * It's a Numbers Game all print, so `config.houseRules.allianceStealIsRandom` exposes the
   * reading as a setting — and with it off the take's spec was `chosen`, which by contract moves
   * nothing at resolution time and opens its own `card_choice` window instead. Only Spy Shack
   * ever opened one. So the strongest steal card in the box did NOTHING: the card was discarded,
   * the partner was picked, the victim was offered a block, and zero cards changed hands.
   */
  const CHOSEN = { allianceStealIsRandom: false } as const;

  it("opens a card choice for EACH ally and moves two cards", () => {
    const sim = new Sim(setHands(started(4, CHOSEN), { Dov: [] }));
    sim.stealAndDecline(ARI, DOV);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.LetsFormAnAlliance, CardKind.Inheritance],
      Bex: [CardKind.ExtraVote],
      Cyd: [CardKind.ImmunityIdol, CardKind.CampRaid, CardKind.SorryForYou],
      Dov: [],
    });

    const alliance = firstOfKind(sim.state, ARI, CardKind.LetsFormAnAlliance);
    sim.do({
      type: "play_lets_form_an_alliance",
      actor: ARI,
      cardUid: alliance,
      partner: BEX,
      victim: CYD,
    });
    const target = sim.state.pending.find((p) => p.kind === "alliance_target");
    if (!target) throw new Error("no alliance_target window opened");
    sim.do({
      type: "choose_alliance_target",
      actor: BEX,
      pendingId: target.id,
      target: CYD,
    });

    const take = takeAgainst(sim.state, CYD);
    expect(take.spec).toEqual({ kind: "chosen", count: 2 });
    const cydBefore = handSize(sim.state, CYD);

    // The victim lets it happen. THIS is where two card-choice windows have to appear.
    sim.do({ type: "decline_reaction", actor: CYD, pendingId: take.id });
    const choices = sim.state.pending.filter((p) => p.kind === "card_choice");
    expect(
      choices,
      "a chosen alliance steal must open one card choice per ally",
    ).toHaveLength(2);
    expect([...choices.map((c) => c.chooserId)].sort()).toEqual([ARI, BEX].sort());

    // Each ally names a card from the victim's hand, and it moves.
    const cydHand = [...handOf(sim.state, CYD)];
    const ariChoice = choices.find((c) => c.chooserId === ARI);
    const bexChoice = choices.find((c) => c.chooserId === BEX);
    if (!ariChoice || !bexChoice) throw new Error("missing a choice");
    const ariWants = cydHand[0];
    const bexWants = cydHand[1];
    if (!ariWants || !bexWants) throw new Error("fixture: victim needs two cards");

    sim.do({
      type: "choose_card",
      actor: ARI,
      pendingId: ariChoice.id,
      cardUid: ariWants,
    });
    sim.do({
      type: "choose_card",
      actor: BEX,
      pendingId: bexChoice.id,
      cardUid: bexWants,
    });

    expect(handOf(sim.state, ARI)).toContain(ariWants);
    expect(handOf(sim.state, BEX)).toContain(bexWants);
    expect(handSize(sim.state, CYD), "two cards left the victim").toBe(cydBefore - 2);
    expect(sim.state.pending.filter((p) => p.kind === "card_choice")).toHaveLength(0);
  });

  it("never lets one ally take the card the other already took", () => {
    // "Allies cannot steal from each other." Both windows are opened against the same hand, so
    // the second ally can name a card the first has already walked off with.
    const sim = new Sim(setHands(started(4, CHOSEN), { Dov: [] }));
    sim.stealAndDecline(ARI, DOV);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.LetsFormAnAlliance],
      Bex: [],
      Cyd: [CardKind.ImmunityIdol, CardKind.CampRaid],
      Dov: [],
    });

    const alliance = firstOfKind(sim.state, ARI, CardKind.LetsFormAnAlliance);
    sim.do({
      type: "play_lets_form_an_alliance",
      actor: ARI,
      cardUid: alliance,
      partner: BEX,
      victim: CYD,
    });
    const target = sim.state.pending.find((p) => p.kind === "alliance_target");
    if (!target) throw new Error("no alliance_target window opened");
    sim.do({
      type: "choose_alliance_target",
      actor: BEX,
      pendingId: target.id,
      target: CYD,
    });
    const take = takeAgainst(sim.state, CYD);
    sim.do({ type: "decline_reaction", actor: CYD, pendingId: take.id });

    const choices = sim.state.pending.filter((p) => p.kind === "card_choice");
    const contested = handOf(sim.state, CYD)[0];
    if (!contested || choices.length !== 2) throw new Error("fixture");
    const [first, second] = choices as [(typeof choices)[0], (typeof choices)[0]];

    sim.do({
      type: "choose_card",
      actor: first.chooserId,
      pendingId: first.id,
      cardUid: contested,
    });
    // The second ally points at the very same card.
    sim.do({
      type: "choose_card",
      actor: second.chooserId,
      pendingId: second.id,
      cardUid: contested,
    });

    expect(
      handOf(sim.state, first.chooserId),
      "the first ally keeps what they took",
    ).toContain(contested);
    expect(handSize(sim.state, first.chooserId)).toBe(1);
    expect(handSize(sim.state, second.chooserId)).toBe(1);
    expect(handSize(sim.state, CYD), "a total of 2 cards stolen").toBe(0);
  });

  it("still lets Sorry For You blank both allies, exactly as the random spec does", () => {
    const sim = new Sim(setHands(started(4, CHOSEN), { Dov: [] }));
    sim.stealAndDecline(ARI, DOV);
    sim.state = setHands(sim.state, {
      Ari: [CardKind.LetsFormAnAlliance, CardKind.Inheritance],
      Bex: [CardKind.ExtraVote],
      Cyd: [CardKind.SorryForYou, CardKind.ImmunityIdol],
      Dov: [],
    });
    const alliance = firstOfKind(sim.state, ARI, CardKind.LetsFormAnAlliance);
    sim.do({
      type: "play_lets_form_an_alliance",
      actor: ARI,
      cardUid: alliance,
      partner: BEX,
      victim: CYD,
    });
    const target = sim.state.pending.find((p) => p.kind === "alliance_target");
    if (!target) throw new Error("no alliance_target window opened");
    sim.do({
      type: "choose_alliance_target",
      actor: BEX,
      pendingId: target.id,
      target: CYD,
    });
    const take = takeAgainst(sim.state, CYD);
    const sorry = firstOfKind(sim.state, CYD, CardKind.SorryForYou);
    const blocked = sim.do({
      type: "play_sorry_for_you",
      actor: CYD,
      cardUid: sorry,
      pendingId: take.id,
    });

    expect([...oneEvent(blocked, "take_blocked").blockedTakerIds].sort()).toEqual(
      [ARI, BEX].sort(),
    );
    expect(
      sim.state.pending.filter((p) => p.kind === "card_choice"),
      "a blocked take opens no card choice",
    ).toHaveLength(0);
  });
});

// ===========================================================================
// A reaction is never dropped and never applied twice
// ===========================================================================

describe("a reaction window resolves, declines or expires exactly once", () => {
  const armedSteal = (): Sim => {
    const sim = new Sim(
      setHands(started(3), {
        Ari: [CardKind.Inheritance, CardKind.ExtraVote],
        Bex: [CardKind.SorryForYou, CardKind.ImmunityIdol, CardKind.CampRaid],
        Cyd: [CardKind.SorryForYou, CardKind.ExtraVote],
      }),
    );
    sim.do({ type: "steal_random", actor: ARI, target: BEX });
    return sim;
  };

  it("a Sorry For You cannot be played twice against the same take", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    const first = firstOfKind(sim.state, BEX, CardKind.SorryForYou);
    sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: first,
      pendingId: take.id,
    });

    expect(sim.state.pending.some((p) => p.id === take.id)).toBe(false);
    // Bex holds no second Sorry For You, but the window itself must already be unanswerable.
    rejects(
      sim.state,
      {
        type: "play_sorry_for_you",
        actor: BEX,
        cardUid: firstOfKind(sim.state, BEX, CardKind.ImmunityIdol),
        pendingId: take.id,
      },
      "pending_not_found",
    );
    // ...and exactly one penalty exists, not two.
    expect(openDiscards(sim.state)).toHaveLength(1);
  });

  it("a blocked take can no longer be declined into a resolution", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    const handBefore = [...handOf(sim.state, BEX)];
    sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.SorryForYou),
      pendingId: take.id,
    });
    rejects(
      sim.state,
      { type: "decline_reaction", actor: BEX, pendingId: take.id },
      "pending_not_found",
    );
    expect(handOf(sim.state, BEX)).toHaveLength(handBefore.length - 1);
    expect(handSize(sim.state, ARI)).toBe(2);
  });

  it("a declined take cannot be declined again, nor blocked after the fact", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    const resolved = sim.do({
      type: "decline_reaction",
      actor: BEX,
      pendingId: take.id,
    });
    expect(oneEvent(resolved, "take_resolved").cardUids).toHaveLength(1);
    const ariHand = handSize(sim.state, ARI);

    rejects(
      sim.state,
      { type: "decline_reaction", actor: BEX, pendingId: take.id },
      "pending_not_found",
    );
    const sorry = handOf(sim.state, BEX).find(
      (uid) => kindOf(sim.state, uid) === CardKind.SorryForYou,
    );
    if (sorry) {
      rejects(
        sim.state,
        { type: "play_sorry_for_you", actor: BEX, cardUid: sorry, pendingId: take.id },
        "pending_not_found",
      );
    }
    expect(handSize(sim.state, ARI)).toBe(ariHand);
  });

  it("an unanswered take expires exactly once however often the clock is advanced", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    expect(take.deadlineMs).toBe(T0 + TAKE_WINDOW);

    const bexBefore = handSize(sim.state, BEX);
    const ariBefore = handSize(sim.state, ARI);

    const expired = sim.tick(T0 + TAKE_WINDOW + 1);
    expect(expired.changed).toBe(true);
    expect(oneEvent(expired, "pending_expired")).toMatchObject({
      pendingId: take.id,
      pendingKind: "take",
      defaultApplied: "take_resolved",
    });
    expect(oneEvent(expired, "take_resolved").cardUids).toHaveLength(1);
    expect(handSize(sim.state, BEX)).toBe(bexBefore - 1);
    expect(handSize(sim.state, ARI)).toBe(ariBefore + 1);
    expect(sim.state.pending).toHaveLength(0);

    const again = sim.tick(T0 + TAKE_WINDOW + 2);
    expect(again.events).toEqual([]);
    expect(again.changed).toBe(false);
    expect(handSize(sim.state, BEX)).toBe(bexBefore - 1);
    expect(handSize(sim.state, ARI)).toBe(ariBefore + 1);
  });

  it("a take already answered is not resolved a second time by its deadline passing", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    sim.do({ type: "decline_reaction", actor: BEX, pendingId: take.id });
    const bexAfter = handSize(sim.state, BEX);
    const ariAfter = handSize(sim.state, ARI);

    const later = sim.tick(T0 + TAKE_WINDOW + 1);
    expect(eventsOf(later, "take_resolved")).toHaveLength(0);
    expect(eventsOf(later, "pending_expired")).toHaveLength(0);
    expect(handSize(sim.state, BEX)).toBe(bexAfter);
    expect(handSize(sim.state, ARI)).toBe(ariAfter);
  });

  it("a blocked take is not resolved after the fact by its deadline passing", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.SorryForYou),
      pendingId: take.id,
    });
    const bexAfter = handSize(sim.state, BEX);
    const ariAfter = handSize(sim.state, ARI);

    const later = sim.tick(T0 + TAKE_WINDOW + 1);
    expect(eventsOf(later, "take_resolved")).toHaveLength(0);
    expect(eventsOf(later, "cards_transferred")).toHaveLength(0);
    expect(handSize(sim.state, BEX)).toBe(bexAfter);
    // Only the forced discard may still change Ari's hand, and only by one card.
    expect(handSize(sim.state, ARI)).toBeGreaterThanOrEqual(ariAfter - 1);
  });

  it("only the victim may answer a take", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    const cydSorry = firstOfKind(sim.state, CYD, CardKind.SorryForYou);

    rejects(
      sim.state,
      { type: "play_sorry_for_you", actor: CYD, cardUid: cydSorry, pendingId: take.id },
      "not_a_participant",
    );
    rejects(
      sim.state,
      { type: "decline_reaction", actor: CYD, pendingId: take.id },
      "not_a_participant",
    );
    // The bystander's card is not burned by the rejected attempt (audit #49).
    expect(handOf(sim.state, CYD)).toContain(cydSorry);
    expect(
      legalActionsFor(sim.state, CYD, T0).some((a) => a.kind === "play_sorry_for_you"),
    ).toBe(false);
    expect(
      legalActionsFor(sim.state, BEX, T0).some((a) => a.kind === "play_sorry_for_you"),
    ).toBe(true);
  });

  it("Sorry For You answers a take and nothing else", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.SorryForYou),
      pendingId: take.id,
    });
    const penalty = discardFor(sim.state, ARI);
    rejects(
      sim.state,
      {
        type: "play_sorry_for_you",
        actor: ARI,
        cardUid: firstOfKind(sim.state, ARI, CardKind.Inheritance),
        pendingId: penalty.id,
      },
      "wrong_pending_kind",
    );
  });

  it("the forced discard is paid exactly once", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.SorryForYou),
      pendingId: take.id,
    });
    const penalty = discardFor(sim.state, ARI);
    const before = handSize(sim.state, ARI);
    sim.do({
      type: "discard_card",
      actor: ARI,
      cardUid: firstOfKind(sim.state, ARI, CardKind.Inheritance),
      pendingId: penalty.id,
    });
    expect(handSize(sim.state, ARI)).toBe(before - 1);

    rejects(
      sim.state,
      {
        type: "discard_card",
        actor: ARI,
        cardUid: firstOfKind(sim.state, ARI, CardKind.ExtraVote),
        pendingId: penalty.id,
      },
      "pending_not_found",
    );
    expect(handSize(sim.state, ARI)).toBe(before - 1);

    const later = sim.tick(
      T0 + DEFAULT_CONFIG.engine.timings.pendingWindows.discard + 1,
    );
    expect(eventsOf(later, "card_discarded")).toHaveLength(0);
    expect(handSize(sim.state, ARI)).toBe(before - 1);
  });

  it("an unpaid forced discard expires exactly once, taking exactly one card", () => {
    const sim = armedSteal();
    const take = takeAgainst(sim.state, BEX);
    sim.do({
      type: "play_sorry_for_you",
      actor: BEX,
      cardUid: firstOfKind(sim.state, BEX, CardKind.SorryForYou),
      pendingId: take.id,
    });
    const penalty = discardFor(sim.state, ARI);
    const before = handSize(sim.state, ARI);

    const expired = sim.tick(penalty.deadlineMs + 1);
    expect(eventsOf(expired, "card_discarded")).toHaveLength(1);
    expect(eventsOf(expired, "card_discarded")[0]?.autoSelected).toBe(true);
    expect(
      eventsOf(expired, "pending_expired").filter((e) => e.pendingId === penalty.id),
    ).toHaveLength(1);
    expect(handSize(sim.state, ARI)).toBe(before - 1);
    expect(openDiscards(sim.state)).toHaveLength(0);
  });
});
