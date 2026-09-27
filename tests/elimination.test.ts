/**
 * ELIMINATION, INHERITANCE & COUNCIL CLEANUP
 *
 * The rules under test, from docs/RULES.md:
 *
 *  - "The player with the most votes must turn over one of their Survivor Character Cards to
 *    indicate that they have been voted out." / "As long as you have at least one Survivor
 *    Character Card, you're still in the game."
 *  - "If both of your Survivor Character Cards have been turned over, you are eliminated from
 *    the game. When this happens, put your cards face up on top of the Discard Pile."
 *  - Inheritance: "Each Inheritance Card targets a different color player. When that player is
 *    eliminated from the game (by having both of their Survivor Character Cards turned over),
 *    you can IMMEDIATELY play this card. You get all of the cards in their hand instead of
 *    their cards going in the Discard Pile." / "It can be useful to have the Inheritance for a
 *    player that isn't in the game. You can discard it if someone plays a Sorry For You
 *    against you!"
 *  - Cleanup: "After voting has ended, return 1 Vote Card to every player who still has at
 *    least one Survivor Character Card left in the game. Discard all other cards used during
 *    the Tribal Council (including the Tribal Council Card) face up in the Discard Pile. After
 *    Tribal, continue play with the player on your left."
 *  - I'm the Leader Now: "It's your turn when the Tribal Council ends (or the player after you
 *    if you are eliminated)."
 *
 * Everything is driven through the public engine surface only: `createGame` / `dispatch`, and
 * `serializeSnapshot` -> `parseSnapshot` -> `restoreGame` to deal a known hand and put a known
 * card on top of the draw pile. No engine file is touched.
 */

import { describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import type { GameEvent } from "../src/engine/events.js";
import { censusOf, createGame, restoreGame } from "../src/engine/game.js";
import {
  createSnapshot,
  parseSnapshot,
  serializeSnapshot,
} from "../src/engine/snapshot.js";
import {
  CardKind,
  asGameId,
  asCardUid,
  asPendingId,
  asPlayerId,
  councilOf,
  type Action,
  type CardUid,
  type CouncilPhase,
  type Game,
  type PlayerColor,
  type PlayerId,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

const SEED = 424_242;

let clock = 1_700_000_000_000;
const now = (): number => (clock += 1_000);

/** 12 Survivor Character + 67 Action + the hidden Idol Nullifier. */
const TOTAL_CARDS = 80;

const P: readonly PlayerId[] = ["p0", "p1", "p2", "p3"].map(asPlayerId);
/** `join_game` with no colour takes the first free one, in `ALL_PLAYER_COLORS` order. */
const SEAT_COLOR: readonly PlayerColor[] = ["red", "orange", "magenta", "green"];
/** Colours nobody is playing in a 4-player game — the Survival Guide's "dead card" case. */
const DEAD_COLOR: PlayerColor = "teal";

// ---------------------------------------------------------------------------
// Driving the engine
// ---------------------------------------------------------------------------

function assertConserved(game: Game): void {
  const state = game.state();
  expect(censusOf(state)).toEqual([]);
  // The box is minted at `start_game`; before that the registry is legitimately empty.
  if (state.stage.kind !== "lobby") expect(state.cards.length).toBe(TOTAL_CARDS);
}

/** Dispatch and require success, re-checking the card census after every single mutation. */
function must(game: Game, action: Action): readonly GameEvent[] {
  const out = game.dispatch(action, now());
  if (!out.ok) {
    throw new Error(
      `${action.type} rejected: ${out.error.code} — ${out.error.message}`,
    );
  }
  assertConserved(game);
  return out.value.events;
}

const typesOf = (events: readonly GameEvent[]): string[] => events.map((e) => e.type);

function eventOf<T extends GameEvent["type"]>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as
    Extract<GameEvent, { type: T }> | undefined;
}

function requireEvent<T extends GameEvent["type"]>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }> {
  const found = eventOf(events, type);
  if (!found)
    throw new Error(`expected a ${type} event, saw: ${typesOf(events).join(", ")}`);
  return found;
}

// ---------------------------------------------------------------------------
// Rigging a known deal through the snapshot boundary
// ---------------------------------------------------------------------------

interface RawCard {
  uid: string;
  kind: string;
  color?: string;
}
interface RawCharacterCard {
  uid: string;
  flipped: boolean;
  flippedAtSeq: number | null;
}
interface RawPlayer {
  id: string;
  color: string;
  seat: number;
  hand: string[];
  voteCards: string[];
  grantedVotes: string[];
  characterCards: RawCharacterCard[];
  campRaid: { cardUid: string; raiderId: string; placedAtSeq: number } | null;
}
interface RawZones {
  drawPile: string[];
  discardPile: string[];
  removedFromGame: string[];
  voteCardBank: string[];
  votingBox: string[];
  inPlay: string[];
}
interface RawState {
  seq: number;
  cards: RawCard[];
  players: RawPlayer[];
  zones: RawZones;
}
interface RawSnapshot {
  schemaVersion: number;
  savedAtMs: number;
  state: RawState;
}

/** Re-enter the engine through `parseSnapshot`, so the rigged state is validated like a save. */
function rig(game: Game, edit: (state: RawState) => void): Game {
  const raw = JSON.parse(
    JSON.stringify(serializeSnapshot(createSnapshot(game.state(), now()))),
  ) as RawSnapshot;
  edit(raw.state);
  const parsed = parseSnapshot(raw);
  if (!parsed.ok) throw new Error(`rigged snapshot rejected: ${parsed.error.message}`);
  const restored = restoreGame(parsed.value);
  if (!restored.ok)
    throw new Error(`rigged restore rejected: ${restored.error.message}`);
  assertConserved(restored.value);
  return restored.value;
}

const cardOf = (state: RawState, uid: string): RawCard => {
  const card = state.cards.find((c) => c.uid === uid);
  if (!card) throw new Error(`no such card ${uid}`);
  return card;
};

type CardSpec = CardKind | { readonly kind: CardKind; readonly color: PlayerColor };

const specKind = (spec: CardSpec): CardKind =>
  typeof spec === "string" ? spec : spec.kind;
const specColor = (spec: CardSpec): PlayerColor | undefined =>
  typeof spec === "string" ? undefined : spec.color;

/**
 * Pull a card of this kind out of whichever table zone currently holds one. Only zones nobody
 * is looking at are raided, so the census still balances and no hand is disturbed.
 */
function pull(state: RawState, spec: CardSpec): string {
  const kind = specKind(spec);
  const color = specColor(spec);
  for (const zone of ["drawPile", "discardPile", "removedFromGame"] as const) {
    const arr = state.zones[zone];
    const at = arr.findIndex((uid) => {
      const card = cardOf(state, uid);
      return card.kind === kind && (color === undefined || card.color === color);
    });
    if (at >= 0) return arr.splice(at, 1)[0]!;
  }
  throw new Error(`no spare ${kind}${color ? `/${color}` : ""} to deal`);
}

/** Replace a player's hand exactly. The cards they held are put away, not discarded. */
function setHand(state: RawState, seat: number, specs: readonly CardSpec[]): string[] {
  const player = state.players[seat]!;
  state.zones.removedFromGame.push(...player.hand.splice(0, player.hand.length));
  for (const spec of specs) player.hand.push(pull(state, spec));
  return [...player.hand];
}

/** The next card the current player draws. */
function putOnTopOfDeck(state: RawState, spec: CardSpec): string {
  const uid = pull(state, spec);
  state.zones.drawPile.unshift(uid);
  return uid;
}

/**
 * Move every Inheritance card still in the draw pile aside, face up. An Inheritance window opens
 * whenever the matching card is somewhere the table cannot see, so a test about something else
 * sets them aside rather than waiting out a window after every elimination.
 */
function setInheritanceAside(state: RawState): void {
  const pile = state.zones.drawPile;
  const loose = pile.filter((uid) => cardOf(state, uid).kind === CardKind.Inheritance);
  state.zones.drawPile = pile.filter((uid) => !loose.includes(uid));
  state.zones.removedFromGame.push(...loose);
}

/** Turn over the first Survivor Character Card, as an earlier council would have. */
function preflip(state: RawState, seat: number): void {
  const card = state.players[seat]!.characterCards.find((c) => !c.flipped);
  if (!card) throw new Error(`seat ${seat} has no unflipped character card`);
  card.flipped = true;
  card.flippedAtSeq = state.seq;
}

// ---------------------------------------------------------------------------
// Game / council helpers
// ---------------------------------------------------------------------------

function startedGame(): Game {
  const game = createGame({
    gameId: asGameId("elimination-suite"),
    hostId: P[0]!,
    config: DEFAULT_CONFIG.engine,
    nowMs: now(),
    seed: SEED,
  });
  for (const [i, id] of P.entries()) {
    must(game, { type: "join_game", actor: id, displayName: `P${i}` });
  }
  must(game, { type: "start_game", actor: P[0]!, firstPlayer: P[0]! });
  return game;
}

const takePendingId = (game: Game): string => {
  const pending = game.state().pending.find((p) => p.kind === "take");
  if (!pending) throw new Error("no take window is open");
  return pending.id;
};

/**
 * Run P0's whole turn — Steal, (skip) Play, Draw — with the Tribal Council card already on top
 * of the deck, so the council starts the way the rulebook says it does: on the draw, at the end
 * of the turn.
 */
function drawIntoCouncil(game: Game, stealFromSeat: number): readonly GameEvent[] {
  const victim = P[stealFromSeat]!;
  must(game, { type: "steal_random", actor: P[0]!, target: victim });
  must(game, {
    type: "decline_reaction",
    actor: victim,
    pendingId: asPendingId(takePendingId(game)),
  });
  must(game, { type: "skip_play_step", actor: P[0]! });
  const events = must(game, { type: "draw_card", actor: P[0]! });
  // Guard the fixture itself: every council test below is worthless if no council started.
  requireEvent(events, "council_started");
  expect(councilOf(game.state().stage)?.phase).toBe("advantages");
  return events;
}

function councilPhase(game: Game): CouncilPhase | null {
  return councilOf(game.state().stage)?.phase ?? null;
}

function leaderOf(game: Game): PlayerId {
  const council = councilOf(game.state().stage);
  if (!council) throw new Error("no council in progress");
  return council.leaderId;
}

/** Leader-driven phase advance, stopping exactly at `target`. */
function advanceCouncilTo(game: Game, target: CouncilPhase): readonly GameEvent[] {
  const collected: GameEvent[] = [];
  for (let guard = 0; guard < 8; guard += 1) {
    const phase = councilPhase(game);
    if (phase === null || phase === target) return collected;
    collected.push(
      ...must(game, { type: "advance_council", actor: leaderOf(game), from: phase }),
    );
  }
  throw new Error(`council never reached ${target}`);
}

/** Everyone in play casts their Vote Card at the named seat and passes the box on. */
function voteEveryone(
  game: Game,
  targets: Readonly<Record<number, number>>,
): readonly GameEvent[] {
  const collected: GameEvent[] = [];
  const inPlay = game
    .state()
    .players.filter((p) => p.eliminatedAtSeq === null && p.leftAtSeq === null);
  for (const player of inPlay) {
    const voteCard = player.voteCards[0];
    if (!voteCard) throw new Error(`${player.id} holds no Vote Card`);
    const target = P[targets[player.seat]!]!;
    collected.push(
      ...must(game, {
        type: "cast_vote",
        actor: player.id,
        cardUid: voteCard,
        target,
      }),
    );
  }
  for (const player of inPlay) {
    collected.push(...must(game, { type: "finish_voting", actor: player.id }));
  }
  return collected;
}

const handOf = (game: Game, seat: number): readonly CardUid[] =>
  game.state().players[seat]!.hand;

const inDiscard = (game: Game, uid: string): boolean =>
  game.state().zones.discardPile.includes(asCardUid(uid));

const charactersLeft = (game: Game, seat: number): number =>
  game.state().players[seat]!.characterCards.filter((c) => !c.flipped).length;

// ---------------------------------------------------------------------------
// Scenario builder: one single-elimination council in which seat 1 is voted out
// ---------------------------------------------------------------------------

interface CouncilScenario {
  /** Hands to deal before the council. Anything unspecified is emptied. */
  readonly hands?: Readonly<Record<number, readonly CardSpec[]>>;
  /** Seats whose first Survivor Character Card is already turned over. */
  readonly preflipped?: readonly number[];
  readonly councilKind?: CardKind;
  /**
   * Leave the undealt Inheritance cards face down in the draw pile. Off by default: an
   * Inheritance window opens whenever the matching card is somewhere the table cannot see, so
   * with the cards left in the pile every elimination below would wait out a window it is not
   * about. The default sets them aside, face up, where the table can see nobody holds them.
   */
  readonly inheritanceInDrawPile?: boolean;
}

interface Rigged {
  readonly game: Game;
  readonly dealt: Readonly<Record<number, readonly string[]>>;
  readonly councilCardUid: string;
}

function riggedCouncil(scenario: CouncilScenario): Rigged {
  const dealt: Record<number, readonly string[]> = {};
  let councilCardUid = "";
  const game = rig(startedGame(), (state) => {
    for (let seat = 0; seat < P.length; seat += 1) {
      dealt[seat] = setHand(state, seat, scenario.hands?.[seat] ?? []);
    }
    for (const seat of scenario.preflipped ?? []) preflip(state, seat);
    if (scenario.inheritanceInDrawPile !== true) setInheritanceAside(state);
    councilCardUid = putOnTopOfDeck(
      state,
      scenario.councilKind ?? CardKind.TribalCouncilSingle,
    );
  });
  return { game, dealt, councilCardUid };
}

// ---------------------------------------------------------------------------

describe("flipping a Survivor Character Card", () => {
  test("turning over the FIRST Survivor Character Card is not elimination: the player stays in the game and no player_eliminated is announced", () => {
    const { game } = riggedCouncil({ hands: { 1: [CardKind.SorryForYou] } });
    drawIntoCouncil(game, 3);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    const flip = requireEvent(events, "character_card_flipped");
    expect(flip.playerId).toBe(P[1]!);
    expect(flip.charactersRemaining).toBe(1);
    expect(flip.votesReceived).toBe(3);

    // "As long as you have at least one Survivor Character Card, you're still in the game."
    expect(eventOf(events, "player_eliminated")).toBeUndefined();
    expect(eventOf(events, "hand_discarded_on_elimination")).toBeUndefined();
    expect(game.state().players[1]!.eliminatedAtSeq).toBeNull();
    expect(charactersLeft(game, 1)).toBe(1);
    expect(game.view().players[1]!.eliminated).toBe(false);
    // Still holding the hand they had.
    expect(handOf(game, 1).length).toBe(1);
    assertConserved(game);
  });

  test("turning over the SECOND Survivor Character Card eliminates the player and puts them on the Jury", () => {
    const { game } = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.SorryForYou] },
    });
    drawIntoCouncil(game, 3);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    const flip = requireEvent(events, "character_card_flipped");
    expect(flip.playerId).toBe(P[1]!);
    expect(flip.charactersRemaining).toBe(0);

    const out = requireEvent(events, "player_eliminated");
    expect(out.playerId).toBe(P[1]!);
    expect(out.eliminationOrder).toBe(1);
    expect(out.playersRemaining).toBe(3);
    expect(out.handSize).toBe(1);

    const player = game.state().players[1]!;
    expect(player.eliminatedAtSeq).not.toBeNull();
    expect(player.leftAtSeq).toBeNull(); // eliminated, not departed: they ARE on the Jury
    expect(charactersLeft(game, 1)).toBe(0);
    expect(game.view().players[1]!.eliminated).toBe(true);
    assertConserved(game);
  });

  test("two councils in a row: the engine's own first flip is what makes the second one an elimination", () => {
    const first = riggedCouncil({ hands: { 1: [CardKind.SorryForYou] } });
    drawIntoCouncil(first.game, 3);
    advanceCouncilTo(first.game, "voting");
    voteEveryone(first.game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const round1 = advanceCouncilTo(first.game, "cleanup");
    expect(requireEvent(round1, "character_card_flipped").charactersRemaining).toBe(1);
    expect(typesOf(round1)).not.toContain("player_eliminated");
    expect(requireEvent(round1, "council_ended").nextPlayerId).toBe(P[1]!);

    // Seat 1 now takes their turn and draws the next Tribal Council card themselves.
    const game = rig(first.game, (state) => {
      putOnTopOfDeck(state, CardKind.TribalCouncilSingle);
    });
    must(game, { type: "steal_random", actor: P[1]!, target: P[3]! });
    must(game, {
      type: "decline_reaction",
      actor: P[3]!,
      pendingId: asPendingId(takePendingId(game)),
    });
    must(game, { type: "skip_play_step", actor: P[1]! });
    requireEvent(must(game, { type: "draw_card", actor: P[1]! }), "council_started");
    expect(leaderOf(game)).toBe(P[1]!);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const round2 = advanceCouncilTo(game, "cleanup");

    const flip = requireEvent(round2, "character_card_flipped");
    expect(flip.playerId).toBe(P[1]!);
    expect(flip.charactersRemaining).toBe(0);
    expect(requireEvent(round2, "player_eliminated").playerId).toBe(P[1]!);
    expect(game.state().players[1]!.eliminatedAtSeq).not.toBeNull();
    assertConserved(game);
  });

  test("the first flip and the second flip are announced by different events", () => {
    // Same council, same votes, same victim — only the number of torches differs.
    const first = riggedCouncil({ hands: { 1: [CardKind.SorryForYou] } });
    drawIntoCouncil(first.game, 3);
    advanceCouncilTo(first.game, "voting");
    voteEveryone(first.game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const firstEvents = advanceCouncilTo(first.game, "cleanup");

    const second = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.SorryForYou] },
    });
    drawIntoCouncil(second.game, 3);
    advanceCouncilTo(second.game, "voting");
    voteEveryone(second.game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const secondEvents = advanceCouncilTo(second.game, "cleanup");

    expect(typesOf(firstEvents)).toContain("character_card_flipped");
    expect(typesOf(firstEvents)).not.toContain("player_eliminated");
    expect(typesOf(secondEvents)).toContain("character_card_flipped");
    expect(typesOf(secondEvents)).toContain("player_eliminated");

    // The eliminated player is on the jury; the flipped one is not.
    expect(requireEvent(firstEvents, "council_ended").eliminatedIds).toEqual([]);
    expect(requireEvent(firstEvents, "council_ended").flippedIds).toEqual([P[1]!]);
    expect(requireEvent(secondEvents, "council_ended").eliminatedIds).toEqual([P[1]!]);
  });
});

describe("an eliminated player's hand", () => {
  test("goes face up on the Discard Pile when no matching Inheritance card is played", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote, CardKind.CampRaid],
        // A live-colour Inheritance for somebody ELSE: it must not open a window here.
        2: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[3]! }],
      },
    });
    const victimHand = dealt[1]!;
    drawIntoCouncil(game, 3);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    expect(eventOf(events, "inheritance_window_opened")).toBeUndefined();
    const discarded = requireEvent(events, "hand_discarded_on_elimination");
    expect(discarded.playerId).toBe(P[1]!);
    expect(discarded.cards.map((c) => c.uid).sort()).toEqual([...victimHand].sort());

    expect(handOf(game, 1)).toEqual([]);
    for (const uid of victimHand) expect(inDiscard(game, uid)).toBe(true);
    assertConserved(game);
  });

  test("a Camp Raid marker sitting in front of an eliminated player leaves the table with them", () => {
    let markerUid = "";
    const game = rig(startedGame(), (state) => {
      for (let seat = 0; seat < P.length; seat += 1) setHand(state, seat, []);
      setHand(state, 1, [CardKind.SorryForYou]);
      preflip(state, 1);
      setInheritanceAside(state);
      markerUid = pull(state, CardKind.CampRaid);
      state.zones.inPlay.push(markerUid);
      state.players[1]!.campRaid = {
        cardUid: markerUid,
        raiderId: P[2]!,
        placedAtSeq: state.seq,
      };
      putOnTopOfDeck(state, CardKind.TribalCouncilSingle);
    });
    expect(game.view().players[1]!.campRaidBy).toBe(P[2]!);

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    advanceCouncilTo(game, "cleanup");

    expect(game.state().players[1]!.campRaid).toBeNull();
    expect(game.state().zones.inPlay).not.toContain(asCardUid(markerUid));
    expect(inDiscard(game, markerUid)).toBe(true);
    assertConserved(game);
  });

  test("every card an eliminated player held is still somewhere in the game: nothing vanishes", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote, CardKind.KnowledgeIsPower],
      },
    });
    const before = game.state();
    const victimHand = dealt[1]!;
    const victimVoteCard = before.players[1]!.voteCards[0]!;
    const victimCharacters = before.players[1]!.characterCards.map((c) => c.uid);

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    advanceCouncilTo(game, "cleanup");

    const after = game.state();
    expect(after.cards.length).toBe(TOTAL_CARDS);
    expect(censusOf(after)).toEqual([]);

    // The hand is on the Discard Pile.
    for (const uid of victimHand) expect(inDiscard(game, uid)).toBe(true);
    // The Vote Card is table property: recycled, never destroyed and never left with the dead.
    expect(after.players[1]!.voteCards).toEqual([]);
    const voteCardStillPlaced =
      after.zones.voteCardBank.includes(victimVoteCard) ||
      after.players.some((p) => p.voteCards.includes(victimVoteCard)) ||
      after.zones.discardPile.includes(victimVoteCard);
    expect(voteCardStillPlaced).toBe(true);
    // Both Survivor Character Cards are still in front of them, turned over.
    expect(after.players[1]!.characterCards.map((c) => c.uid)).toEqual(
      victimCharacters,
    );
    expect(after.players[1]!.characterCards.every((c) => c.flipped)).toBe(true);
  });
});

describe("elimination outside a Tribal Council (an empty Draw Pile)", () => {
  test("the mass elimination that empties the Draw Pile still discards every hand and returns every Vote Card", () => {
    // "The moment there are only 2 players left in the game … it's time to IMMEDIATELY start the
    // Final Tribal Council." The two players holding the most torches survive the exhaustion.
    const game = rig(startedGame(), (state) => {
      for (let seat = 0; seat < P.length; seat += 1) {
        setHand(state, seat, [CardKind.SorryForYou, CardKind.ExtraVote]);
      }
      // Seats 1 and 2 are down to one torch, so they are the two who go home.
      preflip(state, 1);
      preflip(state, 2);
      state.zones.removedFromGame.push(
        ...state.zones.drawPile.splice(0, state.zones.drawPile.length),
      );
    });
    const doomed = [1, 2].map((seat) => ({
      seat,
      hand: [...game.state().players[seat]!.hand],
      voteCard: game.state().players[seat]!.voteCards[0]!,
    }));

    must(game, { type: "steal_random", actor: P[0]!, target: P[3]! });
    must(game, {
      type: "decline_reaction",
      actor: P[3]!,
      pendingId: asPendingId(takePendingId(game)),
    });
    must(game, { type: "skip_play_step", actor: P[0]! });
    const events = must(game, { type: "draw_card", actor: P[0]! });

    expect(typesOf(events)).toContain("draw_pile_exhausted");
    const eliminated = events.filter((e) => e.type === "player_eliminated");
    expect(eliminated.length).toBe(2);

    for (const { seat, hand, voteCard } of doomed) {
      const player = game.state().players[seat]!;
      expect(player.eliminatedAtSeq).not.toBeNull();
      expect(player.hand).toEqual([]);
      for (const uid of hand) expect(inDiscard(game, uid)).toBe(true);
      // "Vote Cards … back to `zones.voteCardBank`, never to a hand."
      expect(player.voteCards).toEqual([]);
      expect(game.state().zones.voteCardBank).toContain(asCardUid(voteCard));
    }
    assertConserved(game);
  });

  test("the elimination report names the Vote Card it took back off the table", () => {
    const game = rig(startedGame(), (state) => {
      for (let seat = 0; seat < P.length; seat += 1) {
        setHand(state, seat, [CardKind.SorryForYou]);
      }
      preflip(state, 1);
      preflip(state, 2);
      state.zones.removedFromGame.push(
        ...state.zones.drawPile.splice(0, state.zones.drawPile.length),
      );
    });

    must(game, { type: "steal_random", actor: P[0]!, target: P[3]! });
    must(game, {
      type: "decline_reaction",
      actor: P[3]!,
      pendingId: asPendingId(takePendingId(game)),
    });
    must(game, { type: "skip_play_step", actor: P[0]! });
    const events = must(game, { type: "draw_card", actor: P[0]! });

    const reports = events.filter((e) => e.type === "hand_discarded_on_elimination");
    expect(reports.length).toBe(2);
    for (const report of reports) {
      if (report.type !== "hand_discarded_on_elimination") continue;
      // Each of them was holding exactly one Vote Card when they were eliminated, and it went
      // back to the bank — `voteCardsReturned` is the field that says so.
      expect(report.voteCardsReturned).toBe(1);
    }
  });
});

describe("Inheritance", () => {
  test("the matching Inheritance card takes the eliminated player's WHOLE hand instead of the Discard Pile", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote, CardKind.CampRaid],
        2: [
          { kind: CardKind.Inheritance, color: SEAT_COLOR[1]! },
          CardKind.SorryForYou,
        ],
      },
    });
    const victimHand = dealt[1]!;
    const inheritanceUid = dealt[2]![0]!;
    const claimantKeeps = dealt[2]![1]!;

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });

    const toTally = must(game, {
      type: "advance_council",
      actor: leaderOf(game),
      from: "idols",
    });
    const opened = requireEvent(toTally, "inheritance_window_opened");
    expect(opened.eliminatedPlayerId).toBe(P[1]!);
    expect(opened.color).toBe(SEAT_COLOR[1]!);
    expect(opened.handSize).toBe(victimHand.length);
    // The hand has NOT been discarded while the window is open.
    expect(typesOf(toTally)).not.toContain("hand_discarded_on_elimination");

    const claimed = must(game, {
      type: "play_inheritance",
      actor: P[2]!,
      cardUid: asCardUid(inheritanceUid),
      pendingId: asPendingId(opened.pendingId),
    });
    const claim = requireEvent(claimed, "inheritance_claimed");
    expect(claim.claimantId).toBe(P[2]!);
    expect(claim.eliminatedPlayerId).toBe(P[1]!);
    expect(claim.cardCount).toBe(victimHand.length);

    // "instead of their cards going in the Discard Pile"
    expect(typesOf(claimed)).not.toContain("hand_discarded_on_elimination");
    for (const uid of victimHand) {
      expect(handOf(game, 2)).toContain(asCardUid(uid));
      expect(inDiscard(game, uid)).toBe(false);
    }
    expect(handOf(game, 1)).toEqual([]);
    expect(handOf(game, 2)).toContain(asCardUid(claimantKeeps));
    expect(handOf(game, 2).length).toBe(victimHand.length + 1);
    assertConserved(game);
  });

  test("the Inheritance card is CONSUMED when played: it leaves the claimant's hand for the Discard Pile", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote],
        2: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[1]! }],
      },
    });
    const inheritanceUid = dealt[2]![0]!;

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const toTally = must(game, {
      type: "advance_council",
      actor: leaderOf(game),
      from: "idols",
    });
    const opened = requireEvent(toTally, "inheritance_window_opened");

    must(game, {
      type: "play_inheritance",
      actor: P[2]!,
      cardUid: asCardUid(inheritanceUid),
      pendingId: asPendingId(opened.pendingId),
    });

    expect(handOf(game, 2)).not.toContain(asCardUid(inheritanceUid));
    expect(inDiscard(game, inheritanceUid)).toBe(true);

    // And it cannot be played a second time.
    const again = game.dispatch(
      {
        type: "play_inheritance",
        actor: P[2]!,
        cardUid: asCardUid(inheritanceUid),
        pendingId: asPendingId(opened.pendingId),
      },
      now(),
    );
    expect(again.ok).toBe(false);
    assertConserved(game);
  });

  test("declining the window sends the hand to the Discard Pile and keeps the Inheritance card in hand", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote],
        2: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[1]! }],
      },
    });
    const victimHand = dealt[1]!;
    const inheritanceUid = dealt[2]![0]!;

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const toTally = must(game, {
      type: "advance_council",
      actor: leaderOf(game),
      from: "idols",
    });
    const opened = requireEvent(toTally, "inheritance_window_opened");

    const declined = must(game, {
      type: "decline_reaction",
      actor: P[2]!,
      pendingId: asPendingId(opened.pendingId),
    });
    const discarded = requireEvent(declined, "hand_discarded_on_elimination");
    expect(discarded.cards.map((c) => c.uid).sort()).toEqual([...victimHand].sort());
    for (const uid of victimHand) expect(inDiscard(game, uid)).toBe(true);
    expect(handOf(game, 2)).toContain(asCardUid(inheritanceUid));
    assertConserved(game);
  });

  test("the council does not finish while the Inheritance window is open, and forfeits it on the deadline", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote],
        2: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[1]! }],
      },
    });
    const victimHand = dealt[1]!;
    const inheritanceUid = dealt[2]![0]!;

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const toTally = must(game, {
      type: "advance_council",
      actor: leaderOf(game),
      from: "idols",
    });
    const opened = requireEvent(toTally, "inheritance_window_opened");

    // "you can IMMEDIATELY play this card" — the council waits for the answer.
    expect(game.state().stage.kind).toBe("council");
    expect(typesOf(toTally)).not.toContain("council_ended");
    expect(typesOf(toTally)).not.toContain("vote_cards_returned");
    expect(handOf(game, 1).length).toBe(victimHand.length);

    const deadline = game
      .state()
      .pending.find((p) => p.id === opened.pendingId)!.deadlineMs;
    const expired = game.tick(deadline + 1);
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;

    const gone = requireEvent(expired.value.events, "pending_expired");
    expect(gone.pendingKind).toBe("inheritance");
    expect(gone.defaultApplied).toBe("inheritance_forfeited");
    expect(typesOf(expired.value.events)).toContain("hand_discarded_on_elimination");
    // Forfeited, so the hand goes to the Discard Pile after all and the card is not consumed.
    for (const uid of victimHand) expect(inDiscard(game, uid)).toBe(true);
    expect(handOf(game, 2)).toContain(asCardUid(inheritanceUid));
    // And the council is free to finish.
    expect(typesOf(expired.value.events)).toContain("council_ended");
    assertConserved(game);
  });

  test("an Inheritance card for another live colour cannot claim this elimination", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote],
        2: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[1]! }],
        3: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[2]! }],
      },
    });
    const wrongColorUid = dealt[3]![0]!;

    drawIntoCouncil(game, 2); // seat 3 is holding a card, so steal from the empty-handed seat 2
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const toTally = must(game, {
      type: "advance_council",
      actor: leaderOf(game),
      from: "idols",
    });
    const opened = requireEvent(toTally, "inheritance_window_opened");

    const wrong = game.dispatch(
      {
        type: "play_inheritance",
        actor: P[3]!,
        cardUid: asCardUid(wrongColorUid),
        pendingId: asPendingId(opened.pendingId),
      },
      now(),
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("invalid_target");
    assertConserved(game);
  });

  test("the window opens even when NOBODY can claim, if the card is face down in the draw pile — so it says nothing about who holds what", () => {
    // Opening the window only when somebody held the card made its announcement a leak: "whoever
    // holds the Orange Inheritance may claim" told the table that somebody did. With the card
    // face down in the pile the window opens all the same, nobody can answer it, and it runs out.
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.SorryForYou, CardKind.ExtraVote] },
      inheritanceInDrawPile: true,
    });
    const victimHand = dealt[1]!;
    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    // The council holds at the tally while the window is open.
    const events = advanceCouncilTo(game, "tally");

    const opened = requireEvent(events, "inheritance_window_opened");
    expect(opened.eliminatedPlayerId).toBe(P[1]!);
    for (const seat of [0, 2, 3]) {
      expect(game.legalActions(P[seat]!, now()).map((a) => a.kind)).not.toContain(
        "play_inheritance",
      );
    }
    // Nothing moves until the window has run out; then the hand goes face up as usual.
    expect(eventOf(events, "hand_discarded_on_elimination")).toBeUndefined();
    const expired = game.tick(opened.deadlineMs + 1);
    if (!expired.ok) throw new Error("tick failed");
    const discarded = requireEvent(
      expired.value.events,
      "hand_discarded_on_elimination",
    );
    expect(discarded.cards.map((c) => c.uid).sort()).toEqual([...victimHand].sort());
    assertConserved(game);
  });

  test("no window opens when the matching card is face up where the table can see it", () => {
    const { game } = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.SorryForYou] },
    });
    // The rig set every loose Inheritance card aside face up: nobody can hold Orange's.
    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    expect(eventOf(events, "inheritance_window_opened")).toBeUndefined();
    expect(requireEvent(events, "hand_discarded_on_elimination").playerId).toBe(P[1]!);
  });

  test("an Inheritance card for a colour nobody is playing is a dead card: it never opens or answers a window", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [CardKind.SorryForYou, CardKind.ExtraVote],
        2: [{ kind: CardKind.Inheritance, color: DEAD_COLOR }],
      },
    });
    const deadUid = dealt[2]![0]!;
    const victimHand = dealt[1]!;
    expect(game.state().players.some((p) => p.color === DEAD_COLOR)).toBe(false);

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    // No window at all, so the hand goes straight to the Discard Pile.
    expect(eventOf(events, "inheritance_window_opened")).toBeUndefined();
    expect(requireEvent(events, "hand_discarded_on_elimination").playerId).toBe(P[1]!);
    for (const uid of victimHand) expect(inDiscard(game, uid)).toBe(true);

    // The dead card is still stuck in its owner's hand, and never offered.
    expect(handOf(game, 2)).toContain(asCardUid(deadUid));
    expect(game.legalActions(P[2]!, now()).map((a) => a.kind)).not.toContain(
      "play_inheritance",
    );
    assertConserved(game);
  });

  test("a player eliminated while holding their OWN colour's Inheritance card does not inherit from themselves", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        1: [
          { kind: CardKind.Inheritance, color: SEAT_COLOR[1]! },
          CardKind.SorryForYou,
        ],
      },
    });
    const ownInheritance = dealt[1]![0]!;

    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    expect(eventOf(events, "inheritance_window_opened")).toBeUndefined();
    expect(eventOf(events, "inheritance_claimed")).toBeUndefined();
    expect(
      requireEvent(events, "hand_discarded_on_elimination").cards.map((c) => c.uid),
    ).toContain(asCardUid(ownInheritance));
    expect(inDiscard(game, ownInheritance)).toBe(true);
    assertConserved(game);
  });

  test("playing Inheritance is a reaction: it does not consume the claimant's once-per-turn card play", () => {
    // The claimant here is the player whose turn the council interrupted.
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: {
        0: [{ kind: CardKind.Inheritance, color: SEAT_COLOR[1]! }],
        1: [CardKind.SorryForYou, CardKind.ExtraVote],
      },
    });
    const inheritanceUid = dealt[0]![0]!;

    drawIntoCouncil(game, 3);
    expect(game.view().turn?.cardPlayedThisTurn).toBeNull();

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const toTally = must(game, {
      type: "advance_council",
      actor: leaderOf(game),
      from: "idols",
    });
    const opened = requireEvent(toTally, "inheritance_window_opened");

    const claimed = must(game, {
      type: "play_inheritance",
      actor: P[0]!,
      cardUid: asCardUid(inheritanceUid),
      pendingId: asPendingId(opened.pendingId),
    });
    const played = requireEvent(claimed, "card_played");
    expect(played.cardUid).toBe(asCardUid(inheritanceUid));
    // "Cards played outside your turn … are not constrained by this limit."
    expect(played.consumedTurnPlay).toBe(false);
    expect(handOf(game, 0)).toContain(asCardUid(dealt[1]![0]!));
    assertConserved(game);
  });

  test("a dead Inheritance card is still discardable — 'You can discard it if someone plays a Sorry For You against you!'", () => {
    const game = rig(startedGame(), (state) => {
      for (let seat = 0; seat < P.length; seat += 1) setHand(state, seat, []);
      setHand(state, 0, [{ kind: CardKind.Inheritance, color: DEAD_COLOR }]);
      setHand(state, 1, [CardKind.SorryForYou]);
    });
    const deadUid = game.state().players[0]!.hand[0]!;
    const sorryUid = game.state().players[1]!.hand[0]!;

    must(game, { type: "steal_random", actor: P[0]!, target: P[1]! });
    const takeId = takePendingId(game);
    const blocked = must(game, {
      type: "play_sorry_for_you",
      actor: P[1]!,
      cardUid: sorryUid,
      pendingId: asPendingId(takeId),
    });
    const forced = requireEvent(blocked, "forced_discard_opened");
    expect(forced.playerId).toBe(P[0]!);

    const discardId = game.state().pending.find((p) => p.kind === "discard")!.id;
    must(game, {
      type: "discard_card",
      actor: P[0]!,
      cardUid: deadUid,
      pendingId: discardId,
    });

    expect(handOf(game, 0)).not.toContain(deadUid);
    expect(inDiscard(game, deadUid)).toBe(true);
    assertConserved(game);
  });
});

describe("Tribal Council cleanup", () => {
  test("exactly 1 Vote Card is returned to every player who still has a Survivor Character Card, and none to the eliminated", () => {
    const { game } = riggedCouncil({
      preflipped: [1, 2],
      hands: { 1: [CardKind.SorryForYou] },
    });
    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    // Seat 1 is voted out; seat 2 keeps its single remaining Survivor Character Card.
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    const returned = requireEvent(events, "vote_cards_returned");
    expect([...returned.playerIds].sort()).toEqual([P[0]!, P[2]!, P[3]!].sort());
    expect(returned.playerIds).not.toContain(P[1]!);

    const state = game.state();
    // "…every player who still has at least one Survivor Character Card left in the game."
    expect(state.players[0]!.voteCards.length).toBe(1);
    expect(state.players[2]!.voteCards.length).toBe(1);
    expect(charactersLeft(game, 2)).toBe(1); // one torch left is still "in the game"
    expect(state.players[3]!.voteCards.length).toBe(1);
    expect(state.players[1]!.voteCards.length).toBe(0);

    // The surplus — the eliminated player's Vote Card — is nobody's property and is out of the
    // Voting Box. (`Zones.voteCardBank` is where the frozen contract parks it; RULES.md calls it
    // "discarded". Both are off the table, and the engine reports a count either way.)
    expect(returned.surplusDiscarded).toBe(1);
    const voteCardUids = state.cards
      .filter((c) => c.kind === CardKind.Vote)
      .map((c) => c.uid);
    const held = voteCardUids.filter((uid) =>
      state.players.some((p) => p.voteCards.includes(uid) || p.hand.includes(uid)),
    );
    expect(held.length).toBe(3);
    expect(state.zones.votingBox).toEqual([]);
    assertConserved(game);
  });

  test("a player who gained a second Vote Card is reset to exactly one, and the surplus leaves every hand", () => {
    const { game, dealt } = riggedCouncil({
      hands: { 0: [CardKind.ControlTheVote], 1: [CardKind.SorryForYou] },
    });
    const controlUid = dealt[0]![0]!;
    drawIntoCouncil(game, 3);

    // "take any player's Vote Card. You MUST use that Vote Card in addition to your Vote Card."
    must(game, {
      type: "play_control_the_vote",
      actor: P[0]!,
      cardUid: asCardUid(controlUid),
      target: P[2]!,
    });
    const stolen = game.state().pending.find((p) => p.kind === "take");
    if (stolen) {
      must(game, {
        type: "decline_reaction",
        actor: P[2]!,
        pendingId: asPendingId(stolen.id),
      });
    }
    expect(game.state().players[0]!.voteCards.length).toBe(2);

    advanceCouncilTo(game, "voting");
    for (const uid of [...game.state().players[0]!.voteCards]) {
      must(game, { type: "cast_vote", actor: P[0]!, cardUid: uid, target: P[1]! });
    }
    for (const player of game.state().players) {
      for (const uid of [...player.voteCards]) {
        must(game, {
          type: "cast_vote",
          actor: player.id,
          cardUid: uid,
          target: P[1]!,
        });
      }
    }
    for (const player of game.state().players) {
      must(game, { type: "finish_voting", actor: player.id });
    }
    advanceCouncilTo(game, "cleanup");

    const state = game.state();
    for (const player of state.players) expect(player.voteCards.length).toBe(1);
    // The Control the Vote card itself was used during the council, so it is discarded.
    expect(inDiscard(game, controlUid)).toBe(true);
    assertConserved(game);
  });

  test("every card used during the council — the Tribal Council Card included — ends up in the Discard Pile", () => {
    const { game, dealt, councilCardUid } = riggedCouncil({
      hands: {
        0: [CardKind.ExtraVote],
        1: [CardKind.SorryForYou],
        3: [CardKind.ImmunityIdol],
      },
    });
    const extraVoteUid = dealt[0]![0]!;
    const idolUid = dealt[3]![0]!;

    drawIntoCouncil(game, 2);
    expect(game.state().zones.inPlay).toContain(asCardUid(councilCardUid));

    advanceCouncilTo(game, "voting");
    must(game, {
      type: "cast_vote",
      actor: P[0]!,
      cardUid: asCardUid(extraVoteUid),
      target: P[1]!,
    });
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });

    expect(councilPhase(game)).toBe("idols");
    must(game, {
      type: "play_immunity_idol",
      actor: P[3]!,
      cardUid: asCardUid(idolUid),
      protects: P[3]!,
    });
    advanceCouncilTo(game, "cleanup");

    // "Discard all other cards used during the Tribal Council (including the Tribal Council
    // Card) face up in the Discard Pile."
    expect(inDiscard(game, councilCardUid)).toBe(true);
    expect(inDiscard(game, extraVoteUid)).toBe(true);
    expect(inDiscard(game, idolUid)).toBe(true);
    expect(game.state().zones.votingBox).toEqual([]);
    expect(game.state().zones.inPlay).not.toContain(asCardUid(councilCardUid));

    // Vote Cards are the exception: they are recycled, not discarded.
    const voteCardUids = game
      .state()
      .cards.filter((c) => c.kind === CardKind.Vote)
      .map((c) => c.uid);
    for (const uid of voteCardUids) expect(inDiscard(game, uid)).toBe(false);
    assertConserved(game);
  });

  test("after a Tribal Council play continues with the player on the Leader's LEFT", () => {
    const { game } = riggedCouncil({ hands: { 1: [CardKind.SorryForYou] } });
    drawIntoCouncil(game, 3);
    expect(leaderOf(game)).toBe(P[0]!); // the drawer leads

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    const ended = requireEvent(events, "council_ended");
    expect(ended.nextTurnFromOverride).toBe(false);
    expect(ended.nextPlayerId).toBe(P[1]!); // seat 0's left is seat 1
    expect(game.state().stage.kind).toBe("turn");
    const turn = game.view().turn;
    expect(turn?.playerId).toBe(P[1]!);
    expect(turn?.phase).toBe("steal");
    assertConserved(game);
  });

  test("the player on the Leader's left is skipped when they were the one voted out", () => {
    const { game } = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.SorryForYou] },
    });
    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    const ended = requireEvent(events, "council_ended");
    expect(ended.eliminatedIds).toEqual([P[1]!]);
    expect(ended.nextPlayerId).toBe(P[2]!);
    expect(game.view().turn?.playerId).toBe(P[2]!);
    assertConserved(game);
  });

  test("when the Leader is the player voted out, play still continues with the player on the Leader's left", () => {
    const { game } = riggedCouncil({
      preflipped: [0],
      hands: { 0: [CardKind.SorryForYou] },
    });
    drawIntoCouncil(game, 3);
    expect(leaderOf(game)).toBe(P[0]!);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 0, 3: 0 });
    const events = advanceCouncilTo(game, "cleanup");

    expect(requireEvent(events, "player_eliminated").playerId).toBe(P[0]!);
    const ended = requireEvent(events, "council_ended");
    expect(ended.nextTurnFromOverride).toBe(false);
    expect(ended.nextPlayerId).toBe(P[1]!);
    expect(game.view().turn?.playerId).toBe(P[1]!);
    assertConserved(game);
  });

  test("'I'm the Leader Now' takes the next turn itself, overriding the player on the Leader's left", () => {
    const { game, dealt } = riggedCouncil({
      hands: { 1: [CardKind.SorryForYou], 3: [CardKind.ImTheLeaderNow] },
    });
    const leaderCardUid = dealt[3]![0]!;

    drawIntoCouncil(game, 2);
    expect(leaderOf(game)).toBe(P[0]!);

    must(game, {
      type: "play_im_the_leader_now",
      actor: P[3]!,
      cardUid: asCardUid(leaderCardUid),
    });
    expect(leaderOf(game)).toBe(P[3]!);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    const ended = requireEvent(events, "council_ended");
    expect(ended.nextTurnFromOverride).toBe(true);
    // Without the card the turn would pass to seat 0 (the seat after the leader's seat 3).
    expect(ended.nextPlayerId).toBe(P[3]!);
    expect(game.view().turn?.playerId).toBe(P[3]!);
    expect(inDiscard(game, leaderCardUid)).toBe(true);
    assertConserved(game);
  });

  test("'I'm the Leader Now' passes the next turn to the player AFTER them when they are the one voted out", () => {
    const { game, dealt } = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.ImTheLeaderNow] },
    });
    const leaderCardUid = dealt[1]![0]!;

    drawIntoCouncil(game, 2);
    must(game, {
      type: "play_im_the_leader_now",
      actor: P[1]!,
      cardUid: asCardUid(leaderCardUid),
    });
    expect(leaderOf(game)).toBe(P[1]!);

    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    const events = advanceCouncilTo(game, "cleanup");

    expect(requireEvent(events, "player_eliminated").playerId).toBe(P[1]!);
    const ended = requireEvent(events, "council_ended");
    expect(ended.nextTurnFromOverride).toBe(true);
    // "(or the player after you if you are eliminated)"
    expect(ended.nextPlayerId).toBe(P[2]!);
    expect(game.view().turn?.playerId).toBe(P[2]!);
    assertConserved(game);
  });

  test("an eliminated player is skipped by turn order and is no longer a legal target", () => {
    const { game } = riggedCouncil({
      preflipped: [1],
      hands: { 1: [CardKind.SorryForYou] },
    });
    drawIntoCouncil(game, 3);
    advanceCouncilTo(game, "voting");
    voteEveryone(game, { 0: 1, 1: 0, 2: 1, 3: 1 });
    advanceCouncilTo(game, "cleanup");

    const stealing = game.dispatch(
      { type: "steal_random", actor: P[2]!, target: P[1]! },
      now(),
    );
    expect(stealing.ok).toBe(false);
    if (!stealing.ok) expect(stealing.error.code).toBe("invalid_target");

    const acting = game.dispatch(
      { type: "steal_random", actor: P[1]!, target: P[0]! },
      now(),
    );
    expect(acting.ok).toBe(false);
    if (!acting.ok) expect(acting.error.code).toBe("player_eliminated");
    assertConserved(game);
  });
});
