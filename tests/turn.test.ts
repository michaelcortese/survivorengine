/**
 * THE TURN STATE MACHINE.
 *
 * docs/RULES.md, "Turn Structure", verbatim: "There are 3 parts to your turn:"
 *   1. Steal a Card  — "Pick a player and steal a random card from them." MANDATORY.
 *   2. Play a Card (Optional) — "You don't have to play a card, but you can't play more than one."
 *   3. Draw a Card  — "End your turn by taking the top card from the Draw Pile into your hand."
 * Rulebook footer: "Remember: Steal, Play (or don't), then Draw!"
 *
 * docs/RULES.md:53 — "Play proceeds clockwise ('Play continues clockwise around the table' /
 * 'continue play with the player on your left')."
 *
 * docs/RULES.md:70 — "When you draw a Tribal Council Card, IMMEDIATELY place it face up in front
 * of you to start a Tribal Council. This happens at the end of your turn, so make sure you
 * Steal, then Play (if you'd like to), and THEN Draw the Tribal Council Card."
 *
 * Everything here drives the pure reducer `reduce(state, action, nowMs)` with a fixed RNG seed,
 * so every assertion is deterministic. Fixtures that need a specific card in a specific place
 * rebuild the state object by hand (the card census is preserved: a card is only ever moved from
 * one zone to another, never minted or destroyed).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import { createGame, legalActionsFor, reduce } from "../src/engine/game.js";
import {
  CardKind,
  asGameId,
  asPlayerId,
  councilOf,
  isInPlay,
  turnOf,
  type Action,
  type ActionKind,
  type CardUid,
  type DispatchOutcome,
  type GameState,
  type PlayerId,
  type Result,
  type TurnState,
} from "../src/engine/types.js";
import type { GameEvent } from "../src/engine/events.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SEED = 20250909;
const T0 = 1_700_000_000_000;
/** One second per action: far under `turnSafetyTimeout` (10 minutes), so no backstop fires. */
const STEP_MS = 1_000;

const pid = (i: number): PlayerId => asPlayerId(`P${i}`);

function must(result: Result<DispatchOutcome>, what: string): DispatchOutcome {
  if (!result.ok) {
    throw new Error(
      `${what} was rejected: ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.value;
}

/** A 3-6 player game, started, with P0 on turn 1 at the steal step. */
function newGame(playerCount = 3, seed = SEED): GameState {
  const game = createGame({
    gameId: asGameId("game-turn-tests"),
    hostId: pid(0),
    config: DEFAULT_CONFIG.engine,
    nowMs: T0,
    seed,
  });
  let state = game.state();
  for (let i = 0; i < playerCount; i += 1) {
    state = must(
      reduce(state, { type: "join_game", actor: pid(i), displayName: `P${i}` }, T0),
      `join_game P${i}`,
    ).state;
  }
  state = must(
    reduce(state, { type: "start_game", actor: pid(0), firstPlayer: pid(0) }, T0),
    "start_game",
  ).state;
  return state;
}

/** A mutable driver over the pure reducer, so a test reads as a sequence of moves. */
class Table {
  public state: GameState;
  public now = T0;
  public lastEvents: readonly GameEvent[] = [];

  public constructor(state: GameState) {
    this.state = state;
  }

  /** Dispatch, requiring success. */
  public do(action: Action): readonly GameEvent[] {
    this.now += STEP_MS;
    const outcome = must(reduce(this.state, action, this.now), action.type);
    this.state = outcome.state;
    this.lastEvents = outcome.events;
    return outcome.events;
  }

  /**
   * Dispatch, requiring rejection — and asserting the state the engine was handed is deeply
   * unchanged. Audit #49: "checkForError() mutated player hands while validating".
   */
  public reject(action: Action): { code: string; message: string } {
    this.now += STEP_MS;
    const before = structuredClone(this.state);
    const result = reduce(this.state, action, this.now);
    expect(result.ok, `${action.type} should have been rejected but succeeded`).toBe(
      false,
    );
    // A rejected action must leave the caller's own state object untouched, byte for byte.
    expect(this.state).toEqual(before);
    if (result.ok) throw new Error("unreachable");
    return { code: result.error.code, message: result.error.message };
  }

  public turn(): TurnState {
    const turn = turnOf(this.state.stage);
    if (!turn) throw new Error(`no turn in progress (stage=${this.state.stage.kind})`);
    return turn;
  }

  public current(): PlayerId {
    return this.turn().playerId;
  }

  public legal(viewer: PlayerId): readonly ActionKind[] {
    return legalActionsFor(this.state, viewer, this.now).map((a) => a.kind);
  }

  /** Turn step 1, all the way through the victim's Sorry For You window. */
  public steal(target?: PlayerId): void {
    const actor = this.current();
    const victim = target ?? otherInPlay(this.state, actor);
    this.do({ type: "steal_random", actor, target: victim });
    this.closeTakeWindows();
  }

  /** Every victim declines their open take window, so the steal actually resolves. */
  public closeTakeWindows(): void {
    for (;;) {
      const take = this.state.pending.find((p) => p.kind === "take");
      if (!take || take.kind !== "take") return;
      this.do({ type: "decline_reaction", actor: take.victimId, pendingId: take.id });
    }
  }

  /** Steps 1 -> 2 (skipped) -> 3. */
  public playWholeTurn(): void {
    this.steal();
    this.do({ type: "skip_play_step", actor: this.current() });
    this.do({ type: "draw_card", actor: this.current() });
  }
}

function otherInPlay(state: GameState, actor: PlayerId): PlayerId {
  const target = state.players.find((p) => isInPlay(p) && p.id !== actor);
  if (!target) throw new Error("no legal steal target");
  return target.id;
}

const kindOf = (state: GameState, uid: CardUid): string =>
  state.cards.find((c) => c.uid === uid)?.kind ?? "unknown";

const isCouncilCard = (state: GameState, uid: CardUid): boolean => {
  const kind = kindOf(state, uid);
  return kind === CardKind.TribalCouncilSingle || kind === CardKind.TribalCouncilDouble;
};

/** Move a card of `kind` out of the draw pile and into `player`'s hand. Census preserved. */
function grantFromDeck(state: GameState, player: PlayerId, kind: string): GameState {
  const uid = state.zones.drawPile.find((u) => kindOf(state, u) === kind);
  if (!uid) throw new Error(`no ${kind} left in the draw pile`);
  return {
    ...state,
    zones: { ...state.zones, drawPile: state.zones.drawPile.filter((u) => u !== uid) },
    players: state.players.map((p) =>
      p.id === player ? { ...p, hand: [...p.hand, uid] } : p,
    ),
  };
}

function handUidOf(state: GameState, player: PlayerId, kind: string): CardUid {
  const p = state.players.find((x) => x.id === player);
  const uid = p?.hand.find((u) => kindOf(state, u) === kind);
  if (!uid) throw new Error(`${player} holds no ${kind}`);
  return uid;
}

/** Put an existing draw-pile card on TOP of the pile (index 0 is the next card drawn). */
function moveToTopOfDeck(state: GameState, uid: CardUid): GameState {
  return {
    ...state,
    zones: {
      ...state.zones,
      drawPile: [uid, ...state.zones.drawPile.filter((u) => u !== uid)],
    },
  };
}

function firstCouncilCardInDeck(state: GameState): CardUid {
  const uid = state.zones.drawPile.find((u) => isCouncilCard(state, u));
  if (!uid) throw new Error("no Tribal Council card in the draw pile");
  return uid;
}

/**
 * Fully eliminate a player without running a council: both Survivor Character Cards turned over
 * (docs/RULES.md — "turning over both character cards eliminates you") and an elimination seq.
 */
function eliminatePlayer(state: GameState, player: PlayerId): GameState {
  return {
    ...state,
    seq: state.seq + 1,
    players: state.players.map((p) =>
      p.id === player
        ? {
            ...p,
            characterCards: p.characterCards.map((c) => ({
              ...c,
              flipped: true,
              flippedAtSeq: state.seq,
            })),
            eliminatedAtSeq: state.seq,
          }
        : p,
    ),
  };
}

const eventTypes = (events: readonly GameEvent[]): readonly string[] =>
  events.map((e) => e.type);

const handSizeOf = (state: GameState, player: PlayerId): number =>
  state.players.find((p) => p.id === player)?.hand.length ?? -1;

// ---------------------------------------------------------------------------
// Step 1 — the steal is mandatory and happens exactly once
// ---------------------------------------------------------------------------

describe("turn step 1: the steal is mandatory", () => {
  it("a player cannot draw before stealing: the draw step is unreachable from the steal step", () => {
    const t = new Table(newGame(3));
    expect(t.turn().phase).toBe("steal");

    const error = t.reject({ type: "draw_card", actor: t.current() });

    expect(error.code).toBe("steal_step_not_done");
    expect(t.turn().phase).toBe("steal");
    expect(t.turn().stealResolved).toBe(false);
  });

  it("a player cannot skip past the steal: skip_play_step before the steal is refused", () => {
    const t = new Table(newGame(3));

    const error = t.reject({ type: "skip_play_step", actor: t.current() });

    expect(error.code).toBe("steal_step_not_done");
    expect(t.turn().phase).toBe("steal");
  });

  it("a player cannot play a card before stealing: the play step is unreachable from the steal step", () => {
    let state = newGame(3);
    state = grantFromDeck(state, pid(0), CardKind.CampRaid);
    const t = new Table(state);
    const raid = handUidOf(t.state, pid(0), CardKind.CampRaid);

    const error = t.reject({
      type: "play_camp_raid",
      actor: pid(0),
      cardUid: raid,
      target: pid(1),
    });

    expect(error.code).toBe("steal_step_not_done");
    expect(t.turn().cardPlayedThisTurn).toBeNull();
  });

  it("there is no action that skips the mandatory steal: steal_random is the only turn affordance in the steal step", () => {
    const t = new Table(newGame(3));

    const legal = t.legal(pid(0));

    expect(legal).toContain("steal_random");
    expect(legal).not.toContain("skip_play_step");
    expect(legal).not.toContain("draw_card");
    // Nothing in the frozen Action union skips step 1 — the machine only leaves `steal` once
    // the take window has resolved.
    expect(legal.filter((k) => k.startsWith("play_"))).toEqual([]);
  });

  it("the steal resolves the steal step and advances the turn to the play step", () => {
    const t = new Table(newGame(3));
    t.steal(pid(1));

    expect(t.turn().stealResolved).toBe(true);
    expect(t.turn().phase).toBe("play");
    expect(t.turn().playerId).toBe(pid(0));
  });

  it("a player cannot steal twice: a second steal_random after the first has resolved is refused", () => {
    const t = new Table(newGame(3));
    t.steal(pid(1));

    const error = t.reject({ type: "steal_random", actor: pid(0), target: pid(2) });

    expect(error.code).toBe("wrong_turn_phase");
    expect(t.turn().phase).toBe("play");
  });

  it("a player cannot steal twice: a second steal_random while the first steal is still open is refused", () => {
    const t = new Table(newGame(3));
    const p0Before = handSizeOf(t.state, pid(0));
    t.do({ type: "steal_random", actor: pid(0), target: pid(1) });
    expect(t.state.pending.filter((p) => p.kind === "take")).toHaveLength(1);

    // "1. Steal a Card — Pick a player and steal a random card from them." ONE player, ONE
    // card, once per turn. A second declaration made before the first Sorry For You window has
    // closed must not arm a second take (audit #83: "two steals can be armed at once").
    t.now += STEP_MS;
    const second = reduce(
      t.state,
      { type: "steal_random", actor: pid(0), target: pid(2) },
      t.now,
    );
    expect.soft(second.ok, "a second steal in one turn must be refused").toBe(false);

    if (second.ok) t.state = second.value.state;
    t.closeTakeWindows();

    // Whatever the engine said, the turn may only ever have moved one card into P0's hand.
    expect(handSizeOf(t.state, pid(0))).toBe(p0Before + 1);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — optional, and at most one card
// ---------------------------------------------------------------------------

describe("turn step 2: at most one card, and the step is optional", () => {
  it("the play step is optional: skip_play_step moves the turn straight to the draw step", () => {
    const t = new Table(newGame(3));
    t.steal(pid(1));

    const events = t.do({ type: "skip_play_step", actor: pid(0) });

    expect(eventTypes(events)).toContain("play_step_skipped");
    expect(t.turn().phase).toBe("draw");
    expect(t.turn().cardPlayedThisTurn).toBeNull();
  });

  it('Camp Raid may be placed on "any player", including yourself', () => {
    // "Place this card face up in front of ANY PLAYER. you take the next card they draw at the
    // end of their turn, no matter what it is, but only after they look at it."
    // (docs/RULES.md, Camp Raid.) The card's ONLY printed restriction is the sidebar's "You
    // can't play this card on a player who already has a Camp Raid in front of them", and the
    // engine checks that. Refusing a self-target was a rules change wearing a misclick guard:
    // a player whose every opponent already carried a marker had no legal target at all, so
    // `legalActionsFor` dropped the action and a card the printed text says is playable became
    // unplayable for the rest of the game.
    let state = newGame(3);
    state = grantFromDeck(state, pid(0), CardKind.CampRaid);
    const t = new Table(state);
    t.steal(pid(1));

    expect(t.legal(pid(0))).toContain("play_camp_raid");
    const raid = handUidOf(t.state, pid(0), CardKind.CampRaid);
    t.do({ type: "play_camp_raid", actor: pid(0), cardUid: raid, target: pid(0) });

    expect(t.state.players.find((p) => p.id === pid(0))?.campRaid?.raiderId).toBe(
      pid(0),
    );
    // And the marker-collision rule still holds against yourself.
    expect(t.turn().cardPlayedThisTurn).toBe(raid);
  });

  it("a player cannot play two cards in one turn: the second play is refused once the first has resolved", () => {
    let state = newGame(3);
    state = grantFromDeck(state, pid(0), CardKind.CampRaid);
    state = grantFromDeck(state, pid(0), CardKind.TheSpyShack);
    const t = new Table(state);
    t.steal(pid(1));

    const raid = handUidOf(t.state, pid(0), CardKind.CampRaid);
    t.do({ type: "play_camp_raid", actor: pid(0), cardUid: raid, target: pid(1) });
    expect(t.turn().cardPlayedThisTurn).toBe(raid);

    const spy = handUidOf(t.state, pid(0), CardKind.TheSpyShack);
    const error = t.reject({
      type: "play_spy_shack",
      actor: pid(0),
      cardUid: spy,
      target: pid(2),
    });

    // "You don't have to play a card, but you can't play more than one."
    expect(["card_already_played_this_turn", "wrong_turn_phase"]).toContain(error.code);
    expect(t.turn().cardPlayedThisTurn).toBe(raid);
    // The second card is still in hand: a rejected play never burns a card (audit #49).
    expect(t.state.players.find((p) => p.id === pid(0))?.hand).toContain(spy);
  });

  it("a player cannot play two cards in one turn even while the first card's window is still open", () => {
    let state = newGame(3);
    state = grantFromDeck(state, pid(0), CardKind.TheSpyShack);
    state = grantFromDeck(state, pid(0), CardKind.CampRaid);
    const t = new Table(state);
    t.steal(pid(1));

    const spy = handUidOf(t.state, pid(0), CardKind.TheSpyShack);
    t.do({ type: "play_spy_shack", actor: pid(0), cardUid: spy, target: pid(1) });
    // The Spy Shack opens a take window, so the turn is still parked on the play step.
    expect(t.turn().phase).toBe("play");
    expect(t.turn().cardPlayedThisTurn).toBe(spy);

    const raid = handUidOf(t.state, pid(0), CardKind.CampRaid);
    const error = t.reject({
      type: "play_camp_raid",
      actor: pid(0),
      cardUid: raid,
      target: pid(2),
    });

    expect(error.code).toBe("card_already_played_this_turn");
  });

  it("skipping is not playing: skip_play_step is refused once a card has been played, and cannot force the turn into the draw step while that card is still resolving", () => {
    let state = newGame(3);
    state = grantFromDeck(state, pid(0), CardKind.TheSpyShack);
    const t = new Table(state);
    t.steal(pid(1));
    const spy = handUidOf(t.state, pid(0), CardKind.TheSpyShack);
    t.do({ type: "play_spy_shack", actor: pid(0), cardUid: spy, target: pid(1) });
    expect(t.turn().phase).toBe("play");
    expect(t.state.pending.some((p) => p.kind === "take")).toBe(true);

    t.now += STEP_MS;
    const skip = reduce(t.state, { type: "skip_play_step", actor: pid(0) }, t.now);
    expect
      .soft(skip.ok, "the play step cannot be skipped after a card has been played")
      .toBe(false);

    if (skip.ok) t.state = skip.value.state;

    // "Remember: Steal, Play (or don't), then Draw!" — the draw step is not reachable while the
    // played card's window is still open.
    expect(t.turn().phase).toBe("play");
    expect(t.state.pending.some((p) => p.kind === "take")).toBe(true);
  });

  it("the turn cannot reach the draw step while the played card is still resolving", () => {
    let state = newGame(3);
    state = grantFromDeck(state, pid(0), CardKind.TheSpyShack);
    const t = new Table(state);
    t.steal(pid(1));
    const spy = handUidOf(t.state, pid(0), CardKind.TheSpyShack);
    t.do({ type: "play_spy_shack", actor: pid(0), cardUid: spy, target: pid(1) });

    // Straight at the draw, with the Spy Shack take window still open.
    const error = t.reject({ type: "draw_card", actor: pid(0) });

    expect(error.code).toBe("wrong_turn_phase");
    expect(t.state.pending.some((p) => p.kind === "take")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the draw is mandatory and terminal
// ---------------------------------------------------------------------------

describe("turn step 3: the draw is mandatory and ends the turn", () => {
  it("the draw step is not reachable until the play step has been spent or skipped", () => {
    const t = new Table(newGame(3));
    t.steal(pid(1));
    expect(t.turn().phase).toBe("play");

    const error = t.reject({ type: "draw_card", actor: pid(0) });

    expect(error.code).toBe("wrong_turn_phase");
    expect(t.turn().phase).toBe("play");
  });

  it("the draw cannot be skipped: draw_card is the only affordance in the draw step", () => {
    const t = new Table(newGame(3));
    t.steal(pid(1));
    t.do({ type: "skip_play_step", actor: pid(0) });

    const legal = t.legal(pid(0));

    expect(legal).toContain("draw_card");
    expect(legal).not.toContain("skip_play_step");
    expect(legal).not.toContain("steal_random");
    // There is no "skip the draw" action anywhere in the frozen Action union.
    expect(legal.filter((k) => k.startsWith("play_"))).toEqual([]);
  });

  it("the draw takes the TOP card of the pile into the drawer's hand and ends the turn", () => {
    const t = new Table(newGame(3));
    const topBefore = t.state.zones.drawPile[0] as CardUid;
    const pileBefore = t.state.zones.drawPile.length;
    t.steal(pid(1));
    t.do({ type: "skip_play_step", actor: pid(0) });
    const handBefore = t.state.players.find((p) => p.id === pid(0))?.hand.length ?? 0;

    const events = t.do({ type: "draw_card", actor: pid(0) });

    expect(eventTypes(events)).toContain("card_drawn");
    expect(eventTypes(events)).toContain("turn_ended");
    expect(t.state.zones.drawPile.length).toBe(pileBefore - 1);
    expect(t.state.players.find((p) => p.id === pid(0))?.hand).toContain(topBefore);
    expect(t.state.players.find((p) => p.id === pid(0))?.hand.length).toBe(
      handBefore + 1,
    );
    // The turn is over: it now belongs to someone else.
    expect(t.current()).not.toBe(pid(0));
  });
});

// ---------------------------------------------------------------------------
// Turn ownership
// ---------------------------------------------------------------------------

describe("only the current player may act on the turn", () => {
  it("a player who is not the current player is rejected on every turn action", () => {
    let state = newGame(3);
    state = grantFromDeck(state, pid(1), CardKind.CampRaid);
    const t = new Table(state);
    expect(t.current()).toBe(pid(0));
    const raid = handUidOf(t.state, pid(1), CardKind.CampRaid);

    const attempts: readonly Action[] = [
      { type: "steal_random", actor: pid(1), target: pid(2) },
      { type: "skip_play_step", actor: pid(1) },
      { type: "draw_card", actor: pid(1) },
      { type: "play_camp_raid", actor: pid(1), cardUid: raid, target: pid(2) },
      { type: "play_spy_shack", actor: pid(1), cardUid: raid, target: pid(2) },
      { type: "play_its_a_numbers_game", actor: pid(1), cardUid: raid },
    ];

    for (const action of attempts) {
      const error = t.reject(action);
      expect(error.code, `${action.type} from a non-current player`).toBe(
        "not_your_turn",
      );
    }
    expect(t.current()).toBe(pid(0));
    expect(t.turn().phase).toBe("steal");
  });

  it("a non-current player is rejected at every step of the current player's turn", () => {
    const t = new Table(newGame(3));

    expect(t.reject({ type: "steal_random", actor: pid(2), target: pid(0) }).code).toBe(
      "not_your_turn",
    );
    t.steal(pid(1));
    expect(t.reject({ type: "skip_play_step", actor: pid(2) }).code).toBe(
      "not_your_turn",
    );
    t.do({ type: "skip_play_step", actor: pid(0) });
    expect(t.reject({ type: "draw_card", actor: pid(2) }).code).toBe("not_your_turn");
  });

  it("no turn action is accepted while a Tribal Council is in progress", () => {
    let state = newGame(3);
    state = moveToTopOfDeck(state, firstCouncilCardInDeck(state));
    const t = new Table(state);
    t.playWholeTurn();
    expect(t.state.stage.kind).toBe("council");

    expect(t.reject({ type: "draw_card", actor: pid(0) }).code).toBe(
      "wrong_turn_phase",
    );
    expect(t.reject({ type: "steal_random", actor: pid(0), target: pid(1) }).code).toBe(
      "wrong_turn_phase",
    );
    expect(t.reject({ type: "skip_play_step", actor: pid(1) }).code).toBe(
      "wrong_turn_phase",
    );
  });
});

// ---------------------------------------------------------------------------
// Rejections never mutate
// ---------------------------------------------------------------------------

describe("a rejected action changes nothing", () => {
  it("every rejected turn action leaves the state deeply equal to the state before it", () => {
    let state = newGame(4);
    state = grantFromDeck(state, pid(0), CardKind.CampRaid);
    const t = new Table(state);
    const before = structuredClone(t.state);

    // Each `reject` already asserts deep equality; this loop covers a spread of rejection
    // reasons — wrong phase, wrong actor, unknown card, illegal target.
    const raid = handUidOf(t.state, pid(0), CardKind.CampRaid);
    t.reject({ type: "draw_card", actor: pid(0) });
    t.reject({ type: "skip_play_step", actor: pid(0) });
    t.reject({ type: "steal_random", actor: pid(1), target: pid(0) });
    t.reject({ type: "steal_random", actor: pid(0), target: pid(0) });
    t.reject({ type: "play_camp_raid", actor: pid(0), cardUid: raid, target: pid(1) });
    t.reject({
      type: "play_camp_raid",
      actor: pid(0),
      cardUid: "no-such-card" as CardUid,
      target: pid(1),
    });

    expect(t.state).toEqual(before);
    // And the caller's own object identity is untouched — the engine never writes through it.
    expect(t.state.players[0]?.hand.length).toBe(before.players[0]?.hand.length);
    expect(t.state.seq).toBe(before.seq);
  });

  it("a rejected action reports no events and no state, so nothing can be persisted", () => {
    const t = new Table(newGame(3));
    const result = reduce(t.state, { type: "draw_card", actor: pid(0) }, t.now);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("steal_step_not_done");
    expect("value" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Turn rotation
// ---------------------------------------------------------------------------

describe("turn order is clockwise and skips eliminated players", () => {
  it("the next turn belongs to the player on the current player's left", () => {
    const t = new Table(newGame(4));
    expect(t.current()).toBe(pid(0));

    t.playWholeTurn();
    expect(t.current()).toBe(pid(1));
    expect(t.turn().turnNumber).toBe(2);
    expect(t.turn().phase).toBe("steal");

    t.playWholeTurn();
    expect(t.current()).toBe(pid(2));
  });

  it("turn order wraps from the last seat back to the first", () => {
    const t = new Table(newGame(3));
    t.playWholeTurn(); // P0 -> P1
    t.playWholeTurn(); // P1 -> P2
    expect(t.current()).toBe(pid(2));

    t.playWholeTurn(); // P2 (last seat) -> P0
    expect(t.current()).toBe(pid(0));
  });

  it("turn order skips a fully eliminated player", () => {
    let state = newGame(4);
    state = eliminatePlayer(state, pid(1));
    const t = new Table(state);
    expect(t.current()).toBe(pid(0));

    t.playWholeTurn();

    // P1 has both Survivor Character Cards turned over, so play continues to P2.
    expect(t.current()).toBe(pid(2));
  });

  it("turn order skips a run of consecutive eliminated players", () => {
    let state = newGame(6);
    state = eliminatePlayer(state, pid(1));
    state = eliminatePlayer(state, pid(2));
    state = eliminatePlayer(state, pid(3));
    const t = new Table(state);
    expect(t.current()).toBe(pid(0));

    t.playWholeTurn();

    // Three seats to P0's left are out; play continues to the next player still in the game.
    expect(t.current()).toBe(pid(4));
  });

  it("turn order wraps past eliminated players at the end of the seat order", () => {
    let state = newGame(6);
    state = eliminatePlayer(state, pid(4));
    state = eliminatePlayer(state, pid(5));
    const t = new Table(state);
    t.playWholeTurn(); // P0 -> P1
    t.playWholeTurn(); // P1 -> P2
    t.playWholeTurn(); // P2 -> P3
    expect(t.current()).toBe(pid(3));

    t.playWholeTurn(); // P4 and P5 are out, so it wraps to P0

    expect(t.current()).toBe(pid(0));
  });

  it("an eliminated player may not take a turn action at all", () => {
    let state = newGame(4);
    state = eliminatePlayer(state, pid(1));
    const t = new Table(state);
    t.playWholeTurn();
    expect(t.current()).toBe(pid(2));

    const error = t.reject({ type: "steal_random", actor: pid(1), target: pid(0) });

    expect(error.code).toBe("player_eliminated");
  });

  it("an eliminated player is never the victim of the mandatory steal", () => {
    let state = newGame(4);
    state = eliminatePlayer(state, pid(2));
    const t = new Table(state);

    const error = t.reject({ type: "steal_random", actor: pid(0), target: pid(2) });

    expect(error.code).toBe("invalid_target");
  });
});

// ---------------------------------------------------------------------------
// Drawing a Tribal Council card
// ---------------------------------------------------------------------------

describe("drawing a Tribal Council Card starts a council at the END of the drawer's turn", () => {
  it("the council starts immediately on the draw, with the drawer as Leader", () => {
    let state = newGame(4);
    const councilUid = firstCouncilCardInDeck(state);
    state = moveToTopOfDeck(state, councilUid);
    const t = new Table(state);
    expect(t.current()).toBe(pid(0));

    t.steal(pid(1));
    t.do({ type: "skip_play_step", actor: pid(0) });
    const events = t.do({ type: "draw_card", actor: pid(0) });

    expect(eventTypes(events)).toContain("council_started");
    const started = events.find((e) => e.type === "council_started");
    expect(started && "drawerId" in started ? started.drawerId : null).toBe(pid(0));
    // "If you are the player who drew the Tribal Council Card, you are the Tribal Council
    // Leader." (docs/RULES.md, LEADER)
    expect(started && "leaderId" in started ? started.leaderId : null).toBe(pid(0));

    expect(t.state.stage.kind).toBe("council");
    const council = councilOf(t.state.stage);
    expect(council?.drawerId).toBe(pid(0));
    expect(council?.leaderId).toBe(pid(0));
    expect(council?.cardUid).toBe(councilUid);
    expect(council?.phase).toBe("advantages");
  });

  it("the council fires at the end of the turn: not during the steal step and not during the play step", () => {
    let state = newGame(4);
    state = moveToTopOfDeck(state, firstCouncilCardInDeck(state));
    const t = new Table(state);

    t.steal(pid(1));
    expect(t.state.stage.kind).toBe("turn");
    expect(councilOf(t.state.stage)).toBeNull();

    t.do({ type: "skip_play_step", actor: pid(0) });
    expect(t.state.stage.kind).toBe("turn");
    expect(councilOf(t.state.stage)).toBeNull();

    t.do({ type: "draw_card", actor: pid(0) });
    expect(t.state.stage.kind).toBe("council");
    // "This happens at the end of your turn" — the interrupted turn is carried into the council
    // stage with its draw step spent.
    expect(t.turn().playerId).toBe(pid(0));
    expect(t.turn().phase).toBe("ended");
  });

  it("the drawn Tribal Council Card is placed face up on the table, not kept in the drawer's hand", () => {
    let state = newGame(4);
    const councilUid = firstCouncilCardInDeck(state);
    state = moveToTopOfDeck(state, councilUid);
    const t = new Table(state);

    t.playWholeTurn();

    expect(t.state.players.find((p) => p.id === pid(0))?.hand).not.toContain(
      councilUid,
    );
    expect(t.state.zones.inPlay).toContain(councilUid);
    expect(t.state.zones.drawPile).not.toContain(councilUid);
  });

  it("the turn does NOT rotate while the council is in progress", () => {
    let state = newGame(4);
    state = moveToTopOfDeck(state, firstCouncilCardInDeck(state));
    const t = new Table(state);

    t.playWholeTurn();

    // The next turn is decided at council cleanup ("the player on the Leader's LEFT"), never by
    // the draw that started it.
    expect(t.state.stage.kind).toBe("council");
    expect(t.turn().playerId).toBe(pid(0));
    expect(eventTypes(t.lastEvents)).not.toContain("turn_started");
  });

  it("drawing an ordinary Action Card starts no council and hands the turn on", () => {
    let state = newGame(4);
    const plain = state.zones.drawPile.find((u) => !isCouncilCard(state, u));
    if (!plain) throw new Error("no ordinary card in the draw pile");
    state = moveToTopOfDeck(state, plain);
    const t = new Table(state);

    const events = t.do({ type: "steal_random", actor: pid(0), target: pid(1) });
    expect(eventTypes(events)).toContain("take_declared");
    t.closeTakeWindows();
    t.do({ type: "skip_play_step", actor: pid(0) });
    t.do({ type: "draw_card", actor: pid(0) });

    expect(t.state.stage.kind).toBe("turn");
    expect(t.current()).toBe(pid(1));
  });
});
