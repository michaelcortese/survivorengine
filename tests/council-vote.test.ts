/**
 * COUNCIL VOTING & IDOLS
 *
 * The Tribal Council pipeline: Advantages -> Discussion -> Voting -> Idols -> Nullifiers -> Tally.
 *
 * Every assertion below is traceable to docs/RULES.md. The load-bearing quotations:
 *
 *  - "You can play as many Tribal Advantage Cards as you would like during this discussion, but
 *    NOT once voting has started!"                                          (RULES.md:92, 342)
 *  - Control the Vote: "Play this card during a Tribal Council before voting begins to take any
 *    player's Vote Card. You MUST use that Vote Card in addition to your Vote Card during the
 *    Tribal Council at which this card is played." / "If the player you pick has more than 1
 *    Vote Card, you only take 1."                                                 (RULES.md:218)
 *  - Goodwill Gamble: "Give this card to another player during a Tribal Council before voting
 *    begins. This card counts as 1 vote, and MUST be used during the Tribal Council at which it
 *    is played (just like a Vote Card). They can use it to vote for any player they want."
 *                                                                                (RULES.md:226)
 *  - I'm the Leader Now: "Play this card during a Tribal Council before voting begins to become
 *    the Tribal Council Leader. It's your turn when the Tribal Council ends (or the player after
 *    you if you are eliminated)."                                                (RULES.md:234)
 *  - Vote Card: "you MUST place this card in one of the slots in the Voting Box. You must vote
 *    for a player in the current Tribal Council."                           (RULES.md:178, 402)
 *  - Extra Vote: "you MAY place this card in one of the slots in the Voting Box (or save it for
 *    later)" / "you can use them against the same player, a different player, or save them for
 *    later."                                                                (RULES.md:186, 102)
 *  - Immunity Idol: "Can only be played at Tribal Council AFTER all players have voted, but
 *    BEFORE votes are tallied. Any votes cast for you (or the player you choose) do not count."
 *                                                                                (RULES.md:194)
 *  - Idol Nullifier: "Can only be played after an immunity idol, but before votes are tallied.
 *    Cancels that immunity idol."                                           (RULES.md:426, 356)
 *
 * HOW THE TESTS DRIVE THE ENGINE. `reduce` is a pure function of (state, action, now), so each
 * test builds a real game through `createGame` + real actions, then edits the state between
 * actions to plant exactly the cards the rule under test needs. Every edit preserves the card
 * census (a uid only ever moves between zones/hands, never appears twice and never vanishes),
 * which `expectCensus` re-checks after every mutation. The RNG seed is fixed, so every run is
 * identical.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, withOverrides, type EngineConfig } from "../src/config.js";
import { advance, createGame, legalActionsFor, reduce } from "../src/engine/game.js";
import type { GameEvent } from "../src/engine/events.js";
import {
  CardKind,
  asCardUid,
  asGameId,
  asPendingId,
  asPlayerId,
  councilOf,
  turnOf,
  type Action,
  type CardUid,
  type CouncilPhase,
  type CouncilState,
  type GameErrorCode,
  type GameState,
  type PlayerId,
  type VoteTallyRow,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED = 20250909;
const T0 = 1_700_000_000_000;

const P = (name: string): PlayerId => asPlayerId(name);

const engineConfig = (
  houseRules: Partial<EngineConfig["houseRules"]> = {},
): EngineConfig => withOverrides(DEFAULT_CONFIG, { engine: { houseRules } }).engine;

/** A structurally-loose mirror of `GameState`, used only to plant cards between actions. */
interface LooseCharacter {
  uid: string;
  flipped: boolean;
  flippedAtSeq: number | null;
}
interface LoosePlayer {
  id: string;
  color: string;
  seat: number;
  characterCards: LooseCharacter[];
  hand: string[];
  voteCards: string[];
  grantedVotes: string[];
  eliminatedAtSeq: number | null;
  leftAtSeq: number | null;
}
interface LooseZones {
  drawPile: string[];
  discardPile: string[];
  removedFromGame: string[];
  voteCardBank: string[];
  votingBox: string[];
  inPlay: string[];
}
interface LooseState {
  players: LoosePlayer[];
  cards: { uid: string; kind: string; color?: string }[];
  zones: LooseZones;
}

const ZONE_KEYS: readonly (keyof LooseZones)[] = [
  "drawPile",
  "discardPile",
  "removedFromGame",
  "voteCardBank",
  "votingBox",
  "inPlay",
];

/**
 * Every uid in the registry must sit in exactly one place. Run after every hand-edit so that a
 * broken fixture can never be mistaken for a broken engine.
 */
function expectCensus(state: GameState): void {
  const loose = state as unknown as LooseState;
  const seen = new Map<string, number>();
  const bump = (uid: string): void => {
    seen.set(uid, (seen.get(uid) ?? 0) + 1);
  };
  for (const key of ZONE_KEYS) for (const uid of loose.zones[key]) bump(uid);
  for (const player of loose.players) {
    for (const uid of player.hand) bump(uid);
    for (const uid of player.voteCards) bump(uid);
    for (const uid of player.grantedVotes) bump(uid);
    for (const card of player.characterCards) bump(card.uid);
  }
  const problems = loose.cards
    .map((c) => ({ uid: c.uid, at: seen.get(c.uid) ?? 0 }))
    .filter((row) => row.at !== 1);
  expect(problems).toEqual([]);
  expect(seen.size).toBe(loose.cards.length);
}

class Table {
  state: GameState;
  readonly names: readonly string[];
  events: GameEvent[] = [];
  readonly now = T0;

  constructor(names: readonly string[], config: EngineConfig = engineConfig()) {
    this.names = names;
    const first = names[0];
    if (!first) throw new Error("a table needs players");
    const game = createGame({
      gameId: asGameId("channel-1"),
      hostId: P(first),
      config,
      nowMs: T0,
      seed: SEED,
    });
    for (const name of names) {
      const joined = game.dispatch(
        { type: "join_game", actor: P(name), displayName: name },
        T0,
      );
      if (!joined.ok) throw new Error(`join failed: ${joined.error.code}`);
    }
    const started = game.dispatch(
      { type: "start_game", actor: P(first), firstPlayer: P(first) },
      T0,
    );
    if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
    this.state = game.state();
    expectCensus(this.state);
  }

  // --- dispatch ------------------------------------------------------------

  /** Apply an action that is expected to succeed. Throws loudly if the engine refuses. */
  do(action: Action): readonly GameEvent[] {
    const result = reduce(this.state, action, this.now);
    if (!result.ok) {
      throw new Error(
        `${action.type} was refused: ${result.error.code} — ${result.error.message}`,
      );
    }
    this.state = result.value.state;
    this.events.push(...result.value.events);
    expectCensus(this.state);
    return result.value.events;
  }

  /** Apply an action that is expected to be refused; returns the error code. */
  refuse(action: Action): GameErrorCode {
    const before = JSON.stringify(this.state);
    const result = reduce(this.state, action, this.now);
    if (result.ok) {
      throw new Error(`${action.type} was allowed but should have been refused`);
    }
    // Audit #49: a rejected action must not have mutated anything.
    expect(JSON.stringify(this.state)).toBe(before);
    return result.error.code;
  }

  // --- reading -------------------------------------------------------------

  get loose(): LooseState {
    return this.state as unknown as LooseState;
  }

  council(): CouncilState {
    const council = councilOf(this.state.stage);
    if (!council) throw new Error("no council in progress");
    return council;
  }

  player(name: string): LoosePlayer {
    const found = this.loose.players.find((p) => p.id === name);
    if (!found) throw new Error(`no player ${name}`);
    return found;
  }

  kindOf(uid: string): string {
    const card = this.loose.cards.find((c) => c.uid === uid);
    if (!card) throw new Error(`no card ${uid}`);
    return card.kind;
  }

  turnPlayer(): string {
    const turn = turnOf(this.state.stage);
    if (!turn) throw new Error("no turn in progress");
    return turn.playerId;
  }

  openTakeId(): ReturnType<typeof asPendingId> {
    const take = this.state.pending.find((p) => p.kind === "take");
    if (!take) throw new Error("no open take window");
    return take.id;
  }

  // --- fixture surgery -----------------------------------------------------

  /** Edit the state in place (via a JSON round-trip), then re-check the card census. */
  edit(fn: (state: LooseState) => void): void {
    const draft = JSON.parse(JSON.stringify(this.state)) as LooseState;
    fn(draft);
    this.state = draft as unknown as GameState;
    expectCensus(this.state);
  }

  private static detach(state: LooseState, uid: string): void {
    for (const key of ZONE_KEYS) {
      const at = state.zones[key].indexOf(uid);
      if (at >= 0) state.zones[key].splice(at, 1);
    }
    for (const player of state.players) {
      for (const list of [player.hand, player.voteCards, player.grantedVotes]) {
        const at = list.indexOf(uid);
        if (at >= 0) list.splice(at, 1);
      }
    }
  }

  /**
   * Find a card of `kind` somewhere it is not needed: the draw pile first, then the piles that
   * are out of play, and finally another player's hand. Never mints a card — the number of each
   * kind in a fixture is always the number the real box contains.
   */
  private static findSpare(state: LooseState, kind: string, skip: Set<string>): string {
    const pools: string[][] = [
      state.zones.drawPile,
      state.zones.removedFromGame,
      state.zones.discardPile,
      ...state.players.map((p) => p.hand),
    ];
    for (const pool of pools) {
      for (const uid of pool) {
        if (skip.has(uid)) continue;
        const card = state.cards.find((c) => c.uid === uid);
        if (card?.kind === kind) return uid;
      }
    }
    throw new Error(`no spare ${kind} card available`);
  }

  /** Cards this fixture has already planted, so a later `give` never steals one back. */
  private readonly planted = new Set<string>();

  /** Put a card of `kind` into a player's hand (or vote zone, for a Vote Card). Returns its uid. */
  give(name: string, kind: string, count = 1): CardUid[] {
    const planted: string[] = [];
    this.edit((state) => {
      const player = state.players.find((p) => p.id === name);
      if (!player) throw new Error(`no player ${name}`);
      const skip = new Set<string>(this.planted);
      for (let i = 0; i < count; i += 1) {
        const uid = Table.findSpare(state, kind, skip);
        skip.add(uid);
        Table.detach(state, uid);
        if (kind === CardKind.Vote) player.voteCards.push(uid);
        else player.hand.push(uid);
        planted.push(uid);
      }
    });
    for (const uid of planted) this.planted.add(uid);
    return planted.map(asCardUid);
  }

  /** Move every card of `kind` out of every hand, so no test is surprised by a stray reaction. */
  purgeFromHands(kind: string): void {
    this.edit((state) => {
      for (const player of state.players) {
        for (const uid of [...player.hand]) {
          const card = state.cards.find((c) => c.uid === uid);
          if (card?.kind !== kind) continue;
          Table.detach(state, uid);
          state.zones.removedFromGame.push(uid);
        }
      }
    });
  }

  /** Empty a player's hand into the discard pile. */
  emptyHand(name: string): void {
    this.edit((state) => {
      const player = state.players.find((p) => p.id === name);
      if (!player) throw new Error(`no player ${name}`);
      for (const uid of [...player.hand]) {
        Table.detach(state, uid);
        state.zones.discardPile.push(uid);
      }
    });
  }

  /** Turn over one of a player's Survivor Character Cards without a council. */
  preFlip(name: string): void {
    this.edit((state) => {
      const player = state.players.find((p) => p.id === name);
      const card = player?.characterCards.find((c) => !c.flipped);
      if (!card) throw new Error(`no unflipped character card for ${name}`);
      card.flipped = true;
      card.flippedAtSeq = 2;
    });
  }

  /** Make the next card drawn a Tribal Council card of the given kind. */
  stackCouncil(kind: "single" | "double" = "single"): void {
    const wanted =
      kind === "single" ? CardKind.TribalCouncilSingle : CardKind.TribalCouncilDouble;
    this.edit((state) => {
      const at = state.zones.drawPile.findIndex(
        (uid) => state.cards.find((c) => c.uid === uid)?.kind === wanted,
      );
      if (at < 0) throw new Error(`no ${wanted} left in the draw pile`);
      const [uid] = state.zones.drawPile.splice(at, 1);
      if (uid) state.zones.drawPile.unshift(uid);
    });
  }

  // --- driving -------------------------------------------------------------

  /** Steal (mandatory), decline the Sorry For You window, skip the play step, then draw. */
  takeTurn(stealFrom?: string): void {
    const actor = this.turnPlayer();
    const victim =
      stealFrom ??
      this.loose.players.find(
        (p) => p.id !== actor && p.leftAtSeq === null && p.eliminatedAtSeq === null,
      )?.id;
    if (!victim) throw new Error("nobody to steal from");
    this.do({ type: "steal_random", actor: P(actor), target: P(victim) });
    this.do({
      type: "decline_reaction",
      actor: P(victim),
      pendingId: this.openTakeId(),
    });
    this.do({ type: "skip_play_step", actor: P(actor) });
    this.do({ type: "draw_card", actor: P(actor) });
  }

  /** Start a council on the current player's draw. Leaves the council in `advantages`. */
  openCouncil(kind: "single" | "double" = "single", stealFrom?: string): CouncilState {
    this.stackCouncil(kind);
    this.takeTurn(stealFrom);
    return this.council();
  }

  advance(from: CouncilPhase): void {
    this.do({ type: "advance_council", actor: P(this.council().leaderId), from });
  }

  /** advantages -> discussion -> voting. */
  openVoting(): void {
    this.advance("advantages");
    this.advance("discussion");
    expect(this.council().phase).toBe("voting");
  }

  /** Cast one Vote Card per player at the given target, then close the box. */
  voteAndClose(targets: Record<string, string>): void {
    for (const [voter, target] of Object.entries(targets)) {
      const card = this.player(voter).voteCards[0];
      if (!card) throw new Error(`${voter} has no Vote Card`);
      this.do({
        type: "cast_vote",
        actor: P(voter),
        cardUid: asCardUid(card),
        target: P(target),
      });
    }
    for (const player of this.loose.players) {
      if (player.eliminatedAtSeq !== null || player.leftAtSeq !== null) continue;
      this.do({ type: "finish_voting", actor: P(player.id) });
    }
  }
}

const tallyOf = (events: readonly GameEvent[]): readonly VoteTallyRow[] => {
  const row = [...events].reverse().find((e) => e.type === "tally_computed");
  if (!row || row.type !== "tally_computed") throw new Error("no tally_computed event");
  return row.rows;
};

const eventTypes = (events: readonly GameEvent[]): string[] =>
  events.map((e) => e.type);

const NAMES = ["Ari", "Bex", "Cyd", "Dov"] as const;

// ---------------------------------------------------------------------------
// Phase 1 — Tribal Advantages
// ---------------------------------------------------------------------------

describe("the Tribal Advantage window", () => {
  it("accepts any number of Tribal Advantage cards while the council is before voting", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [gamble1] = t.give("Bex", CardKind.GoodwillGamble);
    const [gamble2] = t.give("Bex", CardKind.GoodwillGamble);
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    if (!gamble1 || !gamble2 || !control) throw new Error("fixture");

    // Two in `advantages`...
    t.do({
      type: "play_goodwill_gamble",
      actor: P("Bex"),
      cardUid: gamble1,
      recipient: P("Cyd"),
    });
    t.do({
      type: "play_goodwill_gamble",
      actor: P("Bex"),
      cardUid: gamble2,
      recipient: P("Dov"),
    });
    // ...and a third in `discussion`, which is the same window ("now or anytime before we vote").
    t.advance("advantages");
    expect(t.council().phase).toBe("discussion");
    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: control,
      target: P("Ari"),
    });

    expect(t.council().advantagesPlayed).toHaveLength(3);
    expect(t.council().advantagesPlayed.map((a) => a.kind)).toEqual([
      CardKind.GoodwillGamble,
      CardKind.GoodwillGamble,
      CardKind.ControlTheVote,
    ]);
  });

  it("refuses every Tribal Advantage card once voting has started", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    const [gamble] = t.give("Bex", CardKind.GoodwillGamble);
    const [leader] = t.give("Bex", CardKind.ImTheLeaderNow);
    if (!control || !gamble || !leader) throw new Error("fixture");

    t.openVoting();

    expect(
      t.refuse({
        type: "play_control_the_vote",
        actor: P("Bex"),
        cardUid: control,
        target: P("Ari"),
      }),
    ).toBe("card_not_playable_now");
    expect(
      t.refuse({
        type: "play_goodwill_gamble",
        actor: P("Bex"),
        cardUid: gamble,
        recipient: P("Cyd"),
      }),
    ).toBe("card_not_playable_now");
    expect(
      t.refuse({ type: "play_im_the_leader_now", actor: P("Bex"), cardUid: leader }),
    ).toBe("card_not_playable_now");
  });

  it("refuses a Tribal Advantage card during the Immunity Idol window as well", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [leader] = t.give("Bex", CardKind.ImTheLeaderNow);
    if (!leader) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Bex", Bex: "Cyd", Cyd: "Bex", Dov: "Bex" });
    expect(t.council().phase).toBe("idols");

    expect(
      t.refuse({ type: "play_im_the_leader_now", actor: P("Bex"), cardUid: leader }),
    ).toBe("card_not_playable_now");
  });
});

// ---------------------------------------------------------------------------
// Control the Vote
// ---------------------------------------------------------------------------

describe("Control the Vote", () => {
  it("takes exactly 1 Vote Card from a player who is holding several", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.give("Ari", CardKind.Vote); // Ari now holds two Vote Cards.
    expect(t.player("Ari").voteCards).toHaveLength(2);
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    if (!control) throw new Error("fixture");

    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: control,
      target: P("Ari"),
    });
    // The take is offered to a Sorry For You first (a disclosed house rule); Ari declines.
    t.do({ type: "decline_reaction", actor: P("Ari"), pendingId: t.openTakeId() });

    expect(t.player("Ari").voteCards).toHaveLength(1);
    expect(t.player("Bex").voteCards).toHaveLength(2);
  });

  it("obliges the taker to cast BOTH Vote Cards during this council", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    if (!control) throw new Error("fixture");
    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: control,
      target: P("Ari"),
    });
    t.do({ type: "decline_reaction", actor: P("Ari"), pendingId: t.openTakeId() });

    t.openVoting();
    const owed = t.council().requiredCasts.filter((c) => c.playerId === "Bex");
    expect(owed).toHaveLength(2);
    expect(owed.map((c) => c.source).sort()).toEqual(["stolen_vote_card", "vote_card"]);

    // One cast is not enough: Bex still owes the stolen card.
    const [firstCard] = t.player("Bex").voteCards;
    if (!firstCard) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(firstCard),
      target: P("Cyd"),
    });
    expect(t.refuse({ type: "finish_voting", actor: P("Bex") })).toBe(
      "must_cast_mandatory_vote",
    );
    expect(
      t.refuse({
        type: "advance_council",
        actor: P(t.council().leaderId),
        from: "voting",
      }),
    ).toBe("must_cast_mandatory_vote");

    const [secondCard] = t.player("Bex").voteCards;
    if (!secondCard) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(secondCard),
      target: P("Dov"),
    });
    t.do({ type: "finish_voting", actor: P("Bex") });
    expect(t.council().requiredCasts.filter((c) => c.playerId === "Bex")).toHaveLength(
      0,
    );
  });

  it("leaves its victim owing no vote at all this council", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    if (!control) throw new Error("fixture");
    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: control,
      target: P("Ari"),
    });
    t.do({ type: "decline_reaction", actor: P("Ari"), pendingId: t.openTakeId() });
    t.openVoting();

    expect(t.council().requiredCasts.filter((c) => c.playerId === "Ari")).toHaveLength(
      0,
    );
    // "pass the box to the player on your left (even if they don't have a Vote Card)" — the
    // victim still passes the box, they simply put nothing in it.
    t.do({ type: "finish_voting", actor: P("Ari") });
    expect(t.council().finishedVoting).toContain("Ari");
  });

  it("cannot take the same physical Vote Card twice in one council", () => {
    // Both copies of Control the Vote can be played at one council (RULES.md:317). Cards have
    // identity, so the second theft must not conjure a duplicate of the first one's Vote Card.
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [first] = t.give("Bex", CardKind.ControlTheVote);
    const [second] = t.give("Cyd", CardKind.ControlTheVote);
    if (!first || !second) throw new Error("fixture");

    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: first,
      target: P("Ari"),
    });
    t.do({ type: "decline_reaction", actor: P("Ari"), pendingId: t.openTakeId() });
    expect(t.player("Ari").voteCards).toHaveLength(0);

    // Ari has nothing left to take, so the second Control the Vote finds no target.
    expect(
      t.refuse({
        type: "play_control_the_vote",
        actor: P("Cyd"),
        cardUid: second,
        target: P("Ari"),
      }),
    ).toBe("invalid_target");

    t.openVoting();
    const holders = t.loose.players.map((p) => p.voteCards.length);
    expect(holders.reduce((a, b) => a + b, 0)).toBe(4);
    expect(t.council().requiredCasts).toHaveLength(4);
  });

  it("gives its player nothing, and no second obligation, when Sorry For You blocks it", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    const [sorry] = t.give("Ari", CardKind.SorryForYou);
    if (!control || !sorry) throw new Error("fixture");

    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: control,
      target: P("Ari"),
    });
    t.do({
      type: "play_sorry_for_you",
      actor: P("Ari"),
      cardUid: sorry,
      pendingId: t.openTakeId(),
    });

    expect(t.player("Ari").voteCards).toHaveLength(1);
    expect(t.player("Bex").voteCards).toHaveLength(1);
    // The taker must discard 1 card — "regardless of how many cards you were owed".
    const discard = t.state.pending.find((p) => p.kind === "discard");
    expect(discard && discard.kind === "discard" ? discard.playerId : null).toBe("Bex");
    const toss = t.player("Bex").hand[0];
    if (!toss || !discard) throw new Error("fixture");
    t.do({
      type: "discard_card",
      actor: P("Bex"),
      pendingId: discard.id,
      cardUid: asCardUid(toss),
    });

    t.openVoting();
    expect(t.council().requiredCasts.filter((c) => c.playerId === "Bex")).toHaveLength(
      1,
    );
    expect(t.council().requiredCasts.filter((c) => c.playerId === "Ari")).toHaveLength(
      1,
    );
  });

  it("returns exactly one Vote Card to every survivor once the council is over", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    const [control] = t.give("Bex", CardKind.ControlTheVote);
    if (!control) throw new Error("fixture");
    t.do({
      type: "play_control_the_vote",
      actor: P("Bex"),
      cardUid: control,
      target: P("Ari"),
    });
    t.do({ type: "decline_reaction", actor: P("Ari"), pendingId: t.openTakeId() });
    t.openVoting();

    const [v1, v2] = t.player("Bex").voteCards;
    if (!v1 || !v2) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(v1),
      target: P("Cyd"),
    });
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(v2),
      target: P("Cyd"),
    });
    for (const name of ["Cyd", "Dov"]) {
      const card = t.player(name).voteCards[0];
      if (!card) throw new Error("fixture");
      t.do({
        type: "cast_vote",
        actor: P(name),
        cardUid: asCardUid(card),
        target: P("Cyd"),
      });
    }
    for (const name of NAMES) t.do({ type: "finish_voting", actor: P(name) });
    t.advance("idols");

    // The council resolved; the Control the Vote theft lasted exactly one council.
    expect(councilOf(t.state.stage)).toBeNull();
    for (const name of NAMES) expect(t.player(name).voteCards).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Goodwill Gamble
// ---------------------------------------------------------------------------

describe("Goodwill Gamble", () => {
  it("hands the vote to the recipient, who MUST cast it at this council", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [gamble] = t.give("Bex", CardKind.GoodwillGamble);
    if (!gamble) throw new Error("fixture");

    t.do({
      type: "play_goodwill_gamble",
      actor: P("Bex"),
      cardUid: gamble,
      recipient: P("Cyd"),
    });
    expect(t.player("Bex").hand).not.toContain(gamble);
    expect(t.player("Cyd").grantedVotes).toEqual([gamble]);

    t.openVoting();
    const owed = t.council().requiredCasts.filter((c) => c.playerId === "Cyd");
    expect(owed).toHaveLength(2);
    expect(owed.map((c) => c.source).sort()).toEqual(["goodwill_gamble", "vote_card"]);

    // Casting only the Vote Card leaves the granted vote outstanding.
    const own = t.player("Cyd").voteCards[0];
    if (!own) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Cyd"),
      cardUid: asCardUid(own),
      target: P("Ari"),
    });
    expect(t.refuse({ type: "finish_voting", actor: P("Cyd") })).toBe(
      "must_cast_mandatory_vote",
    );

    // "They can use it to vote for any player they want" — including the giver.
    t.do({ type: "cast_vote", actor: P("Cyd"), cardUid: gamble, target: P("Bex") });
    t.do({ type: "finish_voting", actor: P("Cyd") });
    expect(
      t.council().votes.filter((v) => v.source === "goodwill_gamble"),
    ).toHaveLength(1);
    expect(
      t.council().votes.find((v) => v.source === "goodwill_gamble")?.targetId,
    ).toBe("Bex");
  });

  it("cannot be given to yourself", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [gamble] = t.give("Bex", CardKind.GoodwillGamble);
    if (!gamble) throw new Error("fixture");
    expect(
      t.refuse({
        type: "play_goodwill_gamble",
        actor: P("Bex"),
        cardUid: gamble,
        recipient: P("Bex"),
      }),
    ).toBe("self_target_not_allowed");
  });

  it("is spent by the council, never recycled like a Vote Card", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    const [gamble] = t.give("Bex", CardKind.GoodwillGamble);
    if (!gamble) throw new Error("fixture");
    t.do({
      type: "play_goodwill_gamble",
      actor: P("Bex"),
      cardUid: gamble,
      recipient: P("Cyd"),
    });
    t.openVoting();
    const own = t.player("Cyd").voteCards[0];
    if (!own) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Cyd"),
      cardUid: asCardUid(own),
      target: P("Ari"),
    });
    t.do({ type: "cast_vote", actor: P("Cyd"), cardUid: gamble, target: P("Ari") });
    for (const name of ["Ari", "Bex", "Dov"]) {
      const card = t.player(name).voteCards[0];
      if (!card) throw new Error("fixture");
      t.do({
        type: "cast_vote",
        actor: P(name),
        cardUid: asCardUid(card),
        target: P("Ari"),
      });
    }
    for (const name of NAMES) t.do({ type: "finish_voting", actor: P(name) });
    t.advance("idols");

    expect(t.loose.zones.discardPile).toContain(gamble);
    expect(t.player("Cyd").grantedVotes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// I'm the Leader Now
// ---------------------------------------------------------------------------

describe("I'm the Leader Now", () => {
  it("transfers the Leader role away from the drawer", () => {
    const t = new Table(NAMES);
    const council = t.openCouncil("single");
    expect(council.leaderId).toBe("Ari");
    const [card] = t.give("Cyd", CardKind.ImTheLeaderNow);
    if (!card) throw new Error("fixture");

    t.do({ type: "play_im_the_leader_now", actor: P("Cyd"), cardUid: card });
    expect(t.council().leaderId).toBe("Cyd");
    expect(t.council().drawerId).toBe("Ari"); // the drawer never changes
    // The old Leader can no longer drive the council.
    expect(
      t.refuse({ type: "advance_council", actor: P("Ari"), from: "advantages" }),
    ).toBe("not_council_leader");
    t.do({ type: "advance_council", actor: P("Cyd"), from: "advantages" });
    expect(t.council().phase).toBe("discussion");
  });

  it("gives its player the next turn, overriding the player to the Leader's left", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    // Without the card the next turn would go to Bex (seat to Ari's left).
    const [card] = t.give("Cyd", CardKind.ImTheLeaderNow);
    if (!card) throw new Error("fixture");
    t.do({ type: "play_im_the_leader_now", actor: P("Cyd"), cardUid: card });
    expect(t.council().nextTurnOverride).toBe("Cyd");

    t.openVoting();
    t.voteAndClose({ Ari: "Dov", Bex: "Dov", Cyd: "Dov", Dov: "Ari" });
    const events = t.do({ type: "advance_council", actor: P("Cyd"), from: "idols" });

    const ended = events.find((e) => e.type === "council_ended");
    expect(
      ended && ended.type === "council_ended" ? ended.nextTurnFromOverride : null,
    ).toBe(true);
    expect(t.turnPlayer()).toBe("Cyd");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — Voting
// ---------------------------------------------------------------------------

describe("the vote", () => {
  it("is not open before the Leader opens it", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const card = t.player("Bex").voteCards[0];
    if (!card) throw new Error("fixture");
    expect(
      t.refuse({
        type: "cast_vote",
        actor: P("Bex"),
        cardUid: asCardUid(card),
        target: P("Ari"),
      }),
    ).toBe("voting_not_open");
  });

  it("obliges every player holding a Vote Card to cast it", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.openVoting();

    const opened = [...t.events].reverse().find((e) => e.type === "voting_opened");
    expect(
      opened && opened.type === "voting_opened"
        ? [...opened.requiredVoterIds].sort()
        : [],
    ).toEqual(["Ari", "Bex", "Cyd", "Dov"]);
    expect(t.council().requiredCasts).toHaveLength(4);

    for (const name of NAMES) {
      expect(t.refuse({ type: "finish_voting", actor: P(name) })).toBe(
        "must_cast_mandatory_vote",
      );
    }
  });

  it("rejects a vote for someone who is not in this game", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.openVoting();
    const card = t.player("Bex").voteCards[0];
    if (!card) throw new Error("fixture");
    expect(
      t.refuse({
        type: "cast_vote",
        actor: P("Bex"),
        cardUid: asCardUid(card),
        target: P("Nobody"),
      }),
    ).toBe("target_not_in_game");
  });

  it("rejects a vote for a player who has already been voted out", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    // Dov is one flip from elimination and holds nothing, so no Inheritance window can open.
    t.preFlip("Dov");
    t.emptyHand("Dov");

    // Council 1 sends Dov home.
    t.openCouncil("single", "Bex");
    t.openVoting();
    t.voteAndClose({ Ari: "Dov", Bex: "Dov", Cyd: "Dov", Dov: "Ari" });
    t.advance("idols");
    expect(t.player("Dov").eliminatedAtSeq).not.toBeNull();
    expect(councilOf(t.state.stage)).toBeNull();

    // Council 2: Dov is on the Jury and is no longer a legal vote target.
    expect(t.turnPlayer()).toBe("Bex");
    t.openCouncil("single", "Cyd");
    t.openVoting();
    const card = t.player("Cyd").voteCards[0];
    if (!card) throw new Error("fixture");
    expect(
      t.refuse({
        type: "cast_vote",
        actor: P("Cyd"),
        cardUid: asCardUid(card),
        target: P("Dov"),
      }),
    ).toBe("invalid_target");
  });

  it("treats an Extra Vote as optional and lets it name a different player", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [extra] = t.give("Bex", CardKind.ExtraVote);
    const [spare] = t.give("Cyd", CardKind.ExtraVote);
    if (!extra || !spare) throw new Error("fixture");
    t.openVoting();

    // "you MAY place this card in one of the slots... (or save it for later)": no obligation.
    expect(
      t.council().requiredCasts.filter((c) => c.source === "extra_vote"),
    ).toHaveLength(0);
    expect(t.council().requiredCasts).toHaveLength(4);

    // Bex casts their Vote Card at Ari and their Extra Vote at Dov — a different player.
    const own = t.player("Bex").voteCards[0];
    if (!own) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(own),
      target: P("Ari"),
    });
    t.do({ type: "cast_vote", actor: P("Bex"), cardUid: extra, target: P("Dov") });
    t.do({ type: "finish_voting", actor: P("Bex") });

    // Cyd saves theirs for later: finishing with the Extra Vote still in hand is legal.
    const cydVote = t.player("Cyd").voteCards[0];
    if (!cydVote) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Cyd"),
      cardUid: asCardUid(cydVote),
      target: P("Ari"),
    });
    t.do({ type: "finish_voting", actor: P("Cyd") });
    expect(t.player("Cyd").hand).toContain(spare);

    const bexVotes = t.council().votes.filter((v) => v.voterId === "Bex");
    expect(bexVotes.map((v) => `${v.source}->${v.targetId}`)).toEqual([
      "vote_card->Ari",
      "extra_vote->Dov",
    ]);
  });

  it("closes a player's ballot once they pass the Voting Box on", () => {
    // "When the Voting Box is in front of you… put your Vote Card in the slot… Then, pass the
    // box to the player on your left" (RULES.md:100). Your ballot is the moment the box is in
    // front of you; once it has moved on you cannot add to it, which is exactly what
    // `finish_voting` ("I have added every Extra Vote I intend to") declares.
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [extra] = t.give("Bex", CardKind.ExtraVote);
    if (!extra) throw new Error("fixture");
    t.openVoting();

    const own = t.player("Bex").voteCards[0];
    if (!own) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(own),
      target: P("Ari"),
    });
    t.do({ type: "finish_voting", actor: P("Bex") });
    expect(t.council().finishedVoting).toContain("Bex");

    // Others are still voting; Bex must not be able to reopen their ballot and add a vote —
    // neither through the reducer nor as an affordance the renderer would keep enabled.
    expect(legalActionsFor(t.state, P("Bex"), T0).map((a) => a.kind)).not.toContain(
      "cast_vote",
    );
    t.refuse({ type: "cast_vote", actor: P("Bex"), cardUid: extra, target: P("Dov") });
  });

  it("never closes the box while a mandatory Vote Card is still uncast", () => {
    // "Voting is compulsory. Every player with a Vote Card must cast it, at this council, for a
    // player." (RULES.md:351; also RULES.md:100 "Everyone must vote.") The interactive paths
    // enforce it with `must_cast_mandatory_vote`; the safety backstop must not be a way around
    // the rule, because skipping votes changes who goes home.
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.openVoting();
    expect(t.council().requiredCasts).toHaveLength(4);

    // Well inside the backstop: nothing may close on its own yet.
    const early = advance(
      t.state,
      T0 + DEFAULT_CONFIG.engine.timings.councilVotingSafetyTimeout - 1,
    );
    t.state = early.state;
    expect(councilOf(t.state.stage)?.phase).toBe("voting");
    expect(councilOf(t.state.stage)?.requiredCasts).toHaveLength(4);
  });

  it("forfeits the vote rather than freezing the council when a player never votes", () => {
    // "Everyone must vote" is a rule about a physical table where the box is handed to the next
    // seat. It is not a rule that the game STOPS if somebody walks away, and that is what used
    // to happen: the backstop re-armed the phase clock forever while anything was outstanding,
    // `advance_council` and `finish_voting` both refused with `must_cast_mandatory_vote`, and
    // the council could never be resolved by anyone. Fifty simulated hours later the phase was
    // still `voting`. The only escapes were destructive — abandon the game, or remove the
    // absent player, which also takes them off the Jury.
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.openVoting();
    expect(t.council().requiredCasts).toHaveLength(4);

    // Three of the four vote and say they are done. The fourth has closed Discord.
    for (const name of ["Ari", "Bex", "Cyd"]) {
      const own = t.player(name).voteCards[0];
      if (!own) throw new Error("fixture");
      t.do({
        type: "cast_vote",
        actor: P(name),
        cardUid: asCardUid(own),
        target: P("Dov"),
      });
      t.do({ type: "finish_voting", actor: P(name) });
    }
    expect(t.council().phase).toBe("voting");
    expect(t.council().requiredCasts).toHaveLength(1);
    expect(t.council().requiredCasts[0]?.playerId).toBe(P("Dov"));

    const outcome = advance(
      t.state,
      T0 + DEFAULT_CONFIG.engine.timings.councilVotingSafetyTimeout + 1,
    );
    t.state = outcome.state;

    // The table is TOLD, by name — a forfeited vote changes who goes home.
    const forfeited = outcome.events.find((e) => e.type === "votes_forfeited");
    expect(forfeited, "the table must be told who did not vote").toBeDefined();
    if (forfeited?.type === "votes_forfeited") {
      expect(forfeited.playerIds).toEqual([P("Dov")]);
      expect(forfeited.casts).toHaveLength(1);
    }

    // …and the council moves on, with the votes that are in the box.
    const council = councilOf(t.state.stage);
    expect(council?.requiredCasts).toHaveLength(0);
    expect(council?.phase, "the box closes rather than re-arming forever").not.toBe(
      "voting",
    );
    expect(outcome.events.some((e) => e.type === "voting_closed")).toBe(true);

    // The game really does reach an outcome from here rather than sliding forever.
    let state = t.state;
    for (let hop = 0; hop < 20; hop += 1) {
      const next = advance(state, T0 + (hop + 2) * 60 * 60_000);
      state = next.state;
      if (councilOf(state.stage) === null) break;
    }
    expect(
      councilOf(state.stage),
      "the council must finish rather than tick forever",
    ).toBeNull();
  });

  it("counts every Extra Vote in the tally", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [extra] = t.give("Bex", CardKind.ExtraVote);
    if (!extra) throw new Error("fixture");
    t.openVoting();
    const own = t.player("Bex").voteCards[0];
    if (!own) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(own),
      target: P("Dov"),
    });
    t.do({ type: "cast_vote", actor: P("Bex"), cardUid: extra, target: P("Dov") });
    for (const name of ["Ari", "Cyd", "Dov"]) {
      const card = t.player(name).voteCards[0];
      if (!card) throw new Error("fixture");
      t.do({
        type: "cast_vote",
        actor: P(name),
        cardUid: asCardUid(card),
        target: P("Cyd"),
      });
    }
    for (const name of NAMES) t.do({ type: "finish_voting", actor: P(name) });

    const events = t.do({ type: "advance_council", actor: P("Ari"), from: "idols" });
    const rows = tallyOf(events);
    expect(rows.find((r) => r.playerId === "Dov")?.rawVotes).toBe(2);
    expect(rows.find((r) => r.playerId === "Cyd")?.rawVotes).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — Immunity Idols
// ---------------------------------------------------------------------------

describe("the Immunity Idol window", () => {
  it("opens only after every vote is in", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    if (!idol) throw new Error("fixture");

    // Before voting even opens.
    expect(
      t.refuse({
        type: "play_immunity_idol",
        actor: P("Bex"),
        cardUid: idol,
        protects: P("Bex"),
      }),
    ).toBe("card_not_playable_now");

    t.openVoting();
    // Mid-vote: still refused. "AFTER all players have voted, but BEFORE votes are tallied."
    const own = t.player("Bex").voteCards[0];
    if (!own) throw new Error("fixture");
    t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(own),
      target: P("Ari"),
    });
    expect(
      t.refuse({
        type: "play_immunity_idol",
        actor: P("Bex"),
        cardUid: idol,
        protects: P("Bex"),
      }),
    ).toBe("card_not_playable_now");

    for (const name of ["Ari", "Cyd", "Dov"]) {
      const card = t.player(name).voteCards[0];
      if (!card) throw new Error("fixture");
      t.do({
        type: "cast_vote",
        actor: P(name),
        cardUid: asCardUid(card),
        target: P("Bex"),
      });
    }
    for (const name of NAMES) t.do({ type: "finish_voting", actor: P(name) });

    expect(t.council().phase).toBe("idols");
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Bex"),
    });
    expect(t.council().idolPlays).toHaveLength(1);
  });

  it("lets an Immunity Idol protect ANOTHER player", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    if (!idol) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });

    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Cyd"),
    });
    const play = t.council().idolPlays[0];
    expect(play?.playedBy).toBe("Bex");
    expect(play?.protects).toBe("Cyd");
  });

  it("zeroes every vote cast at a player a live Immunity Idol protects", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    if (!idol) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Cyd"),
    });

    t.advance("idols"); // an idol was played, so the nullifier window opens first
    const events = t.do({
      type: "advance_council",
      actor: P("Ari"),
      from: "nullifiers",
    });
    const rows = tallyOf(events);
    const cyd = rows.find((r) => r.playerId === "Cyd");
    expect(cyd?.rawVotes).toBe(3);
    expect(cyd?.countedVotes).toBe(0);
    expect(cyd?.immune).toBe(true);
    expect(cyd?.protectedByIdolUids).toEqual([idol]);
    // Ari, with 1 counted vote, is now the top vote-getter and goes home instead.
    expect(rows.find((r) => r.playerId === "Ari")?.countedVotes).toBe(1);
    expect(t.player("Ari").characterCards.filter((c) => c.flipped)).toHaveLength(1);
    expect(t.player("Cyd").characterCards.filter((c) => c.flipped)).toHaveLength(0);
  });

  it("is simply wasted on a player who received no votes", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    if (!idol) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Dov"),
    });
    t.advance("idols");
    const events = t.do({
      type: "advance_council",
      actor: P("Ari"),
      from: "nullifiers",
    });
    const rows = tallyOf(events);
    expect(rows.find((r) => r.playerId === "Dov")).toMatchObject({
      rawVotes: 0,
      immune: true,
    });
    // Cyd still has the most counted votes and still goes home.
    expect(rows.find((r) => r.playerId === "Cyd")?.countedVotes).toBe(3);
    expect(t.player("Cyd").characterCards.filter((c) => c.flipped)).toHaveLength(1);
  });

  it("does not protect its player when every other tier of the ladder is exhausted", () => {
    // "Finally, if there's not enough of them… Choose from the players who played Immunity
    // Idols." (RULES.md:126) An Immunity Idol is NOT absolute protection: a council can never
    // end with nobody voted out.
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    const idols = Object.fromEntries(
      NAMES.map((name) => [name, t.give(name, CardKind.ImmunityIdol)[0]]),
    );
    t.openVoting();
    t.voteAndClose({ Ari: "Bex", Bex: "Cyd", Cyd: "Dov", Dov: "Ari" });

    for (const name of NAMES) {
      const idol = idols[name];
      if (!idol) throw new Error("fixture");
      t.do({
        type: "play_immunity_idol",
        actor: P(name),
        cardUid: idol,
        protects: P(name),
      });
    }
    t.advance("idols");
    const events = t.do({
      type: "advance_council",
      actor: P("Ari"),
      from: "nullifiers",
    });

    // Every vote is zeroed, so the ladder descends all the way to the idol players.
    for (const row of tallyOf(events)) {
      expect(row.rawVotes).toBe(1);
      expect(row.countedVotes).toBe(0);
      expect(row.immune).toBe(true);
    }
    const descents = events
      .filter((e) => e.type === "tie_break_tier_descended")
      .map((e) => (e.type === "tie_break_tier_descended" ? `${e.from}->${e.to}` : ""));
    expect(descents).toEqual([
      "voted_non_immune->unvoted_non_immune",
      "unvoted_non_immune->played_or_protected_by_idol",
    ]);
    const required = events.find((e) => e.type === "tie_break_required");
    if (!required || required.type !== "tie_break_required")
      throw new Error("no tie break");
    expect(required.tier).toBe("played_or_protected_by_idol");
    expect([...required.candidates].sort()).toEqual(["Ari", "Bex", "Cyd", "Dov"]);
    expect(required.choose).toBe(1);

    // The Leader picks an idol holder, and that idol holder is turned over anyway.
    t.do({
      type: "leader_choose_eliminations",
      actor: P("Ari"),
      pendingId: required.pendingId,
      targets: [P("Dov")],
    });
    expect(t.player("Dov").characterCards.filter((c) => c.flipped)).toHaveLength(1);
    expect(councilOf(t.state.stage)).toBeNull();
  });

  it("does not reopen after the votes have been tallied", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    if (!idol) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    t.advance("idols"); // no idol played: straight to the tally, and the council resolves

    expect(councilOf(t.state.stage)).toBeNull();
    expect(
      t.refuse({
        type: "play_immunity_idol",
        actor: P("Bex"),
        cardUid: idol,
        protects: P("Bex"),
      }),
    ).toBe("no_council_in_progress");
  });
});

// ---------------------------------------------------------------------------
// Phase 4b — the Idol Nullifier
// ---------------------------------------------------------------------------

describe("the Idol Nullifier window", () => {
  it("never opens when no Immunity Idol was played", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    const [nullifier] = t.give("Dov", CardKind.IdolNullifier);
    if (!nullifier) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });

    // Refused during the idol window: there is nothing to answer yet.
    expect(
      t.refuse({
        type: "play_idol_nullifier",
        actor: P("Dov"),
        cardUid: nullifier,
        targetIdolUid: asCardUid("nope"),
      }),
    ).toBe("card_not_playable_now");

    const events = t.do({ type: "advance_council", actor: P("Ari"), from: "idols" });
    expect(eventTypes(events)).not.toContain("nullifier_window_opened");
    const phases = events
      .filter((e) => e.type === "council_phase_changed")
      .map((e) => (e.type === "council_phase_changed" ? e.to : ""));
    expect(phases).not.toContain("nullifiers");
    expect(phases[0]).toBe("tally");
  });

  it("opens as soon as an Immunity Idol has been played", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    if (!idol) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Cyd"),
    });

    const events = t.do({ type: "advance_council", actor: P("Ari"), from: "idols" });
    expect(eventTypes(events)).toContain("nullifier_window_opened");
    expect(t.council().phase).toBe("nullifiers");
  });

  it("cancels exactly the Immunity Idol it names and no other", () => {
    const t = new Table(NAMES, engineConfig({ nullifierCancelsAllIdols: false }));
    t.openCouncil("single");
    const [idolA] = t.give("Bex", CardKind.ImmunityIdol);
    const [idolB] = t.give("Dov", CardKind.ImmunityIdol);
    const [nullifier] = t.give("Ari", CardKind.IdolNullifier);
    if (!idolA || !idolB || !nullifier) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Bex", Dov: "Cyd" });

    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idolA,
      protects: P("Cyd"),
    });
    t.do({
      type: "play_immunity_idol",
      actor: P("Dov"),
      cardUid: idolB,
      protects: P("Bex"),
    });
    t.advance("idols");
    expect(t.council().phase).toBe("nullifiers");

    t.do({
      type: "play_idol_nullifier",
      actor: P("Ari"),
      cardUid: nullifier,
      targetIdolUid: idolA,
    });
    const plays = t.council().idolPlays;
    expect(plays.find((p) => p.cardUid === idolA)?.nullifiedBy).toBe(nullifier);
    expect(plays.find((p) => p.cardUid === idolB)?.nullifiedBy).toBeNull();

    const events = t.do({
      type: "advance_council",
      actor: P("Ari"),
      from: "nullifiers",
    });
    const rows = tallyOf(events);
    // Cyd's idol was cancelled, so their 3 votes count again.
    expect(rows.find((r) => r.playerId === "Cyd")).toMatchObject({
      rawVotes: 3,
      countedVotes: 3,
      immune: false,
    });
    // Bex's idol survived, so their 1 vote is still zeroed.
    expect(rows.find((r) => r.playerId === "Bex")).toMatchObject({
      rawVotes: 1,
      countedVotes: 0,
      immune: true,
    });
  });

  it("cancels one idol, not a player's immunity, when two idols protect the same player", () => {
    // "Cancels THAT immunity idol." Two idols on one player, one nullifier: the second idol is
    // untouched, so the player stays immune. There is only one Idol Nullifier in the box, so a
    // double protection cannot be undone.
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idolA] = t.give("Bex", CardKind.ImmunityIdol);
    const [idolB] = t.give("Dov", CardKind.ImmunityIdol);
    const [nullifier] = t.give("Ari", CardKind.IdolNullifier);
    if (!idolA || !idolB || !nullifier) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idolA,
      protects: P("Cyd"),
    });
    t.do({
      type: "play_immunity_idol",
      actor: P("Dov"),
      cardUid: idolB,
      protects: P("Cyd"),
    });
    t.advance("idols");
    t.do({
      type: "play_idol_nullifier",
      actor: P("Ari"),
      cardUid: nullifier,
      targetIdolUid: idolA,
    });

    const events = t.do({
      type: "advance_council",
      actor: P("Ari"),
      from: "nullifiers",
    });
    const rows = tallyOf(events);
    expect(rows.find((r) => r.playerId === "Cyd")).toMatchObject({
      rawVotes: 3,
      countedVotes: 0,
      immune: true,
    });
    expect(rows.find((r) => r.playerId === "Cyd")?.protectedByIdolUids).toEqual([
      idolB,
    ]);
  });

  it("spends the nullifier card, so one council can never see two nullifications", () => {
    // There is exactly one Idol Nullifier in the box and playing it puts it in front of you, so
    // `idol_already_nullified` is unreachable in a real game: a replay is refused earlier, for
    // the card no longer being in hand. Here the disclosed `nullifierCancelsAllIdols` house rule
    // is on, which is the only way one nullifier can answer two idols.
    const t = new Table(NAMES, engineConfig({ nullifierCancelsAllIdols: true }));
    t.openCouncil("single");
    const [idolA] = t.give("Bex", CardKind.ImmunityIdol);
    const [idolB] = t.give("Dov", CardKind.ImmunityIdol);
    const [nullifier] = t.give("Ari", CardKind.IdolNullifier);
    if (!idolA || !idolB || !nullifier) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idolA,
      protects: P("Cyd"),
    });
    t.do({
      type: "play_immunity_idol",
      actor: P("Dov"),
      cardUid: idolB,
      protects: P("Bex"),
    });
    t.advance("idols");
    t.do({
      type: "play_idol_nullifier",
      actor: P("Ari"),
      cardUid: nullifier,
      targetIdolUid: idolA,
    });

    // The house rule took both idols down.
    for (const play of t.council().idolPlays) expect(play.nullifiedBy).toBe(nullifier);
    expect(
      t.refuse({
        type: "play_idol_nullifier",
        actor: P("Ari"),
        cardUid: nullifier,
        targetIdolUid: idolB,
      }),
    ).toBe("card_not_in_hand");
    expect(t.loose.zones.inPlay).toContain(nullifier);
  });

  it("refuses a nullifier that names an idol nobody played", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    const [nullifier] = t.give("Ari", CardKind.IdolNullifier);
    if (!idol || !nullifier) throw new Error("fixture");
    t.openVoting();
    t.voteAndClose({ Ari: "Bex", Bex: "Ari", Cyd: "Bex", Dov: "Bex" });
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Bex"),
    });
    t.advance("idols");

    expect(
      t.refuse({
        type: "play_idol_nullifier",
        actor: P("Ari"),
        cardUid: nullifier,
        targetIdolUid: asCardUid("not-a-real-idol"),
      }),
    ).toBe("no_idol_to_nullify");
  });
});

// ---------------------------------------------------------------------------
// Ordering of the whole pipeline
// ---------------------------------------------------------------------------

describe("the council pipeline", () => {
  it("runs Advantages -> Discussion -> Voting -> Idols -> Nullifiers -> Tally in order", () => {
    const t = new Table(NAMES);
    t.purgeFromHands(CardKind.Inheritance);
    t.openCouncil("single");
    const [idol] = t.give("Bex", CardKind.ImmunityIdol);
    const [nullifier] = t.give("Ari", CardKind.IdolNullifier);
    if (!idol || !nullifier) throw new Error("fixture");
    const seen: CouncilPhase[] = [t.council().phase];

    t.advance("advantages");
    seen.push(t.council().phase);
    t.advance("discussion");
    seen.push(t.council().phase);
    t.voteAndClose({ Ari: "Cyd", Bex: "Cyd", Cyd: "Ari", Dov: "Cyd" });
    seen.push(t.council().phase);
    t.do({
      type: "play_immunity_idol",
      actor: P("Bex"),
      cardUid: idol,
      protects: P("Cyd"),
    });
    t.advance("idols");
    seen.push(t.council().phase);
    t.do({
      type: "play_idol_nullifier",
      actor: P("Ari"),
      cardUid: nullifier,
      targetIdolUid: idol,
    });
    const events = t.do({
      type: "advance_council",
      actor: P("Ari"),
      from: "nullifiers",
    });

    expect(seen).toEqual(["advantages", "discussion", "voting", "idols", "nullifiers"]);
    const phases = events
      .filter((e) => e.type === "council_phase_changed")
      .map((e) => (e.type === "council_phase_changed" ? e.to : ""));
    expect(phases.slice(0, 2)).toEqual(["tally", "cleanup"]);
    // Cyd's protection was cancelled, so Cyd's three votes stand and Cyd is flipped.
    expect(t.player("Cyd").characterCards.filter((c) => c.flipped)).toHaveLength(1);
  });

  it("rejects a stale advance that names a phase the council has already left", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.advance("advantages");
    expect(
      t.refuse({ type: "advance_council", actor: P("Ari"), from: "advantages" }),
    ).toBe("stale_phase");
  });

  it("keeps the ballot secret until the box is opened", () => {
    const t = new Table(NAMES);
    t.openCouncil("single");
    t.openVoting();
    const card = t.player("Bex").voteCards[0];
    if (!card) throw new Error("fixture");
    const events = t.do({
      type: "cast_vote",
      actor: P("Bex"),
      cardUid: asCardUid(card),
      target: P("Ari"),
    });
    const cast = events.find((e) => e.type === "vote_cast");
    expect(cast).toBeDefined();
    expect(cast?.audience.kind).not.toBe("public");
    expect(cast?.audience.kind === "players" ? cast.audience.playerIds : []).toEqual([
      "Bex",
    ]);
    // The public council view knows only how many cards are in the box.
    expect(t.council().phase).toBe("voting");
  });
});
