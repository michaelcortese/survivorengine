/**
 * REWARD CHALLENGES — Do or Die, Power Pair, It's a Numbers Game.
 *
 * All three are simultaneous secret-submission machines, and every test here asserts against the
 * printed card text as transcribed in docs/RULES.md:
 *
 *   Do or Die       "Pick any player to play a single game of Rock Paper Scissors against. If you
 *                    tie, you each swap 1 card of your choice. BUT if either player wins, they
 *                    steal 2 random cards from the loser."
 *   Power Pair      "Pick 2 other players. On the count of three, all 3 players (including you)
 *                    hold out 1, 2, or 3 fingers. If EXACTLY 2 players show the same number of
 *                    fingers, they each steal 1 random card from the 3rd player. If ALL players
 *                    show the same number, each player discards 1 card. If everyone shows a
 *                    different number of fingers, play again."
 *   Numbers Game    "On the count of three, all players (including you) will show 1-5 fingers. The
 *                    player who shows the lowest UNIQUE number gets to steal 2 random cards from
 *                    any player. If necessary, repeat until there's a single winner."
 *
 * Every game is built from a FIXED SEED and every hand is set explicitly, so each test is
 * deterministic. Hands are rearranged by moving uids between the draw pile and hands, which keeps
 * the card census balanced — `expectCensusBalances` proves it.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config.js";
import {
  censusOf,
  buildPrivateView,
  buildView,
  createGame,
  legalActionsFor,
  reduce,
} from "../src/engine/game.js";
import { challengeChoices, submissionIsLegal } from "../src/engine/challenges.js";
import type { GameEvent } from "../src/engine/events.js";
import {
  CardKind,
  asGameId,
  asPlayerId,
  type Action,
  type CardUid,
  type ChallengeSubmission,
  type FingerCount,
  type GameError,
  type GameState,
  type PendingChallenge,
  type PendingDiscard,
  type PendingStealVictim,
  type PendingTake,
  type PendingCardChoice,
  type PlayerColor,
  type PlayerId,
  type RpsThrow,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const SEED = 20250909;
const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eli", "Fay"] as const;
const COLORS: readonly PlayerColor[] = [
  "red",
  "orange",
  "magenta",
  "green",
  "teal",
  "yellow",
];

/** Mutable projections of the state we are allowed to rearrange while building a scenario. */
interface MutPlayer {
  id: PlayerId;
  seat: number;
  hand: CardUid[];
  voteCards: CardUid[];
  grantedVotes: CardUid[];
}
type ZoneKey = keyof GameState["zones"];

const zonesOf = (s: GameState): Record<ZoneKey, CardUid[]> =>
  s.zones as unknown as Record<ZoneKey, CardUid[]>;
const playersOf = (s: GameState): MutPlayer[] => s.players as unknown as MutPlayer[];

function eventsOf<T extends GameEvent["type"]>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

/**
 * Every submission this viewer can see that is not their own. The three Reward Challenges are
 * simultaneous secret submissions — "you can discuss what you're going to do before starting, but
 * you don't have to tell the truth!" only means anything if nobody can look first — so this must
 * be empty for every viewer until the last slot is filled and the reveal happens.
 */
function foreignSubmissionsVisibleTo(state: GameState, viewer: PlayerId): unknown[] {
  const view = buildPrivateView(state, viewer);
  const fromPrivate = (view?.myPending ?? []).flatMap((p) =>
    p.kind === "challenge"
      ? p.slots.filter((s) => s.playerId !== viewer && s.submission !== null)
      : [],
  );
  const fromPublic = buildView(state).openPending.flatMap((p) =>
    Object.entries(p).filter(([key]) => key === "slots" || key === "submissions"),
  );
  return [...fromPrivate, ...fromPublic];
}

/** A hand slot: a specific card kind, or "any" ordinary action card. */
type HandSpec = readonly (CardKind | "any")[];

const rps = (t: RpsThrow): ChallengeSubmission => ({ kind: "rps", throw: t });
const fingers = (count: FingerCount): ChallengeSubmission => ({
  kind: "fingers",
  count,
});

class Table {
  state: GameState;
  last: readonly GameEvent[] = [];
  readonly ids: PlayerId[];
  readonly now = NOW;

  constructor(playerCount: number, seed = SEED) {
    this.ids = NAMES.slice(0, playerCount).map((n) => asPlayerId(n));
    const host = this.ids[0]!;
    this.state = createGame({
      gameId: asGameId("g1"),
      hostId: host,
      config: DEFAULT_CONFIG.engine,
      nowMs: NOW,
      seed,
    }).state();
    this.ids.forEach((id, i) => {
      this.must({
        type: "join_game",
        actor: id,
        displayName: NAMES[i]!,
        color: COLORS[i]!,
      });
    });
    this.must({ type: "start_game", actor: host, firstPlayer: host });
  }

  /** Apply an action that must succeed. Returns the events it produced. */
  must(action: Action): readonly GameEvent[] {
    const result = reduce(this.state, action, this.now);
    if (!result.ok) {
      throw new Error(
        `expected ${action.type} to succeed, got ${result.error.code}: ${result.error.message}`,
      );
    }
    this.state = result.value.state;
    this.last = result.value.events;
    return result.value.events;
  }

  /** Apply an action that must be refused. Returns the error; state is left untouched. */
  reject(action: Action): GameError {
    const before = JSON.stringify(this.state);
    const result = reduce(this.state, action, this.now);
    if (result.ok)
      throw new Error(`expected ${action.type} to be refused, but it succeeded`);
    // Audit #49: a rejected action must not mutate anything.
    expect(JSON.stringify(this.state)).toBe(before);
    return result.error;
  }

  player(id: PlayerId): MutPlayer {
    const p = playersOf(this.state).find((x) => x.id === id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  }

  hand(id: PlayerId): readonly CardUid[] {
    return [...this.player(id).hand];
  }

  kindOf(uid: CardUid): CardKind {
    const card = this.state.cards.find((c) => c.uid === uid);
    if (!card) throw new Error(`no card ${uid}`);
    return card.kind;
  }

  /** The uid of the nth card of a given kind in a player's hand. */
  uidInHand(id: PlayerId, kind: CardKind, nth = 0): CardUid {
    const matches = this.hand(id).filter((u) => this.kindOf(u) === kind);
    const uid = matches[nth];
    if (!uid) throw new Error(`${id} has no ${kind} at index ${nth}`);
    return uid;
  }

  view() {
    return buildView(this.state);
  }

  privateView(viewer: PlayerId) {
    const v = buildPrivateView(this.state, viewer);
    if (!v) throw new Error(`no private view for ${viewer}`);
    return v;
  }

  legalActions(viewer: PlayerId) {
    return legalActionsFor(this.state, viewer, this.now);
  }

  challenge(): PendingChallenge {
    const p = this.state.pending.find(
      (x): x is PendingChallenge => x.kind === "challenge",
    );
    if (!p) throw new Error("no open challenge");
    return p;
  }

  maybeChallenge(): PendingChallenge | null {
    return (
      this.state.pending.find((x): x is PendingChallenge => x.kind === "challenge") ??
      null
    );
  }

  takes(): PendingTake[] {
    return this.state.pending.filter((x): x is PendingTake => x.kind === "take");
  }

  discards(): PendingDiscard[] {
    return this.state.pending.filter((x): x is PendingDiscard => x.kind === "discard");
  }

  cardChoices(): PendingCardChoice[] {
    return this.state.pending.filter(
      (x): x is PendingCardChoice => x.kind === "card_choice",
    );
  }

  stealVictimWindow(): PendingStealVictim {
    const p = this.state.pending.find(
      (x): x is PendingStealVictim => x.kind === "steal_victim",
    );
    if (!p) throw new Error("no open steal-victim window");
    return p;
  }

  /**
   * Turn step 1 is mandatory, so every scenario spends it before the play step. The victim
   * declines the Sorry For You window, which resolves the steal immediately.
   */
  toPlayStep(): this {
    const actor = this.ids[0]!;
    const victim = this.ids[1]!;
    this.must({ type: "steal_random", actor, target: victim });
    const take = this.takes()[0];
    if (take)
      this.must({ type: "decline_reaction", actor: victim, pendingId: take.id });
    const turn = this.view().turn;
    expect(turn?.phase).toBe("play");
    return this;
  }

  /**
   * Replace the named players' hands with exactly these cards, drawing them out of the draw pile.
   * `"any"` means any ordinary action card. Card identities move between zones, so the census
   * still balances.
   */
  setHands(spec: readonly (readonly [PlayerId, HandSpec])[]): this {
    const next = structuredClone(this.state);
    const zones = zonesOf(next);
    const players = playersOf(next);
    const kinds = new Map(next.cards.map((c) => [c.uid, c.kind] as const));
    const dealable = (uid: CardUid): boolean => {
      const kind = kinds.get(uid);
      return (
        kind !== CardKind.TribalCouncilSingle &&
        kind !== CardKind.TribalCouncilDouble &&
        kind !== CardKind.Vote &&
        kind !== CardKind.SurvivorCharacter
      );
    };
    for (const [id] of spec) {
      const p = players.find((x) => x.id === id);
      if (!p) throw new Error(`no player ${id}`);
      zones.drawPile.push(...p.hand);
      p.hand = [];
    }
    for (const [id, wanted] of spec) {
      const p = players.find((x) => x.id === id)!;
      for (const want of wanted) {
        const at = zones.drawPile.findIndex((u) =>
          want === "any" ? dealable(u) : kinds.get(u) === want,
        );
        if (at < 0) throw new Error(`no spare ${want} to deal`);
        const [uid] = zones.drawPile.splice(at, 1);
        p.hand.push(uid!);
      }
    }
    this.state = next;
    return this;
  }

  expectCensusBalances(): void {
    expect(censusOf(this.state)).toEqual([]);
  }
}

/** Set up a game whose current player is about to play `kind` as their one card play. */
function tableReadyToPlay(
  playerCount: number,
  hands: readonly (readonly [number, HandSpec])[],
  seed = SEED,
): Table {
  const t = new Table(playerCount, seed);
  t.toPlayStep();
  t.setHands(hands.map(([i, kinds]) => [t.ids[i]!, kinds] as const));
  return t;
}

const FILLER: HandSpec = ["any", "any", "any"];

// ---------------------------------------------------------------------------
// The shared simultaneous-secret-submission machine
// ---------------------------------------------------------------------------

describe("challengeChoices() is exactly what submissionIsLegal() accepts", () => {
  // The Discord layer builds its menus from `challengeChoices`. If the two ever disagree the
  // menu offers a choice the engine rejects, which is the defect the export exists to prevent.
  const kinds = ["do_or_die", "power_pair", "its_a_numbers_game"] as const;

  for (const kind of kinds) {
    it(`offers only legal submissions for ${kind}`, () => {
      const choices = challengeChoices(kind);
      expect(choices.length).toBeGreaterThan(0);
      for (const choice of choices) {
        expect(submissionIsLegal(kind, choice)).toBe(true);
      }
    });
  }

  it("offers every legal finger count, not a subset", () => {
    const everyCount = [1, 2, 3, 4, 5] as const;
    for (const kind of ["power_pair", "its_a_numbers_game"] as const) {
      const offered = new Set(
        challengeChoices(kind).flatMap((choice) =>
          choice.kind === "fingers" ? [choice.count] : [],
        ),
      );
      for (const count of everyCount) {
        const isLegal = submissionIsLegal(kind, { kind: "fingers", count });
        expect(offered.has(count)).toBe(isLegal);
      }
    }
  });

  it("offers all three throws for Do or Die and no finger counts", () => {
    const choices = challengeChoices("do_or_die");
    expect(
      choices.map((choice) => (choice.kind === "rps" ? choice.throw : "?")),
    ).toEqual(["rock", "paper", "scissors"]);
  });
});

describe("every Reward Challenge is a simultaneous secret submission", () => {
  /** Ari plays Do or Die against Bex; nobody has thrown yet. */
  function doOrDieOpen(): Table {
    const t = tableReadyToPlay(3, [
      [0, [CardKind.DoOrDie, ...FILLER]],
      [1, FILLER],
      [2, FILLER],
    ]);
    t.must({
      type: "play_do_or_die",
      actor: t.ids[0]!,
      cardUid: t.uidInHand(t.ids[0]!, CardKind.DoOrDie),
      opponent: t.ids[1]!,
    });
    return t;
  }

  function powerPairOpen(playerCount = 3): Table {
    const t = tableReadyToPlay(
      playerCount,
      Array.from({ length: playerCount }, (_, i) =>
        i === 0
          ? ([0, [CardKind.PowerPair, ...FILLER]] as const)
          : ([i, FILLER] as const),
      ),
    );
    t.must({
      type: "play_power_pair",
      actor: t.ids[0]!,
      cardUid: t.uidInHand(t.ids[0]!, CardKind.PowerPair),
      first: t.ids[1]!,
      second: t.ids[2]!,
    });
    return t;
  }

  function numbersGameOpen(playerCount = 4): Table {
    const t = tableReadyToPlay(
      playerCount,
      Array.from({ length: playerCount }, (_, i) =>
        i === 0
          ? ([0, [CardKind.ItsANumbersGame, ...FILLER]] as const)
          : ([i, FILLER] as const),
      ),
    );
    t.must({
      type: "play_its_a_numbers_game",
      actor: t.ids[0]!,
      cardUid: t.uidInHand(t.ids[0]!, CardKind.ItsANumbersGame),
    });
    return t;
  }

  it("a Do or Die throw is hidden from the opponent until both players have thrown", () => {
    const t = doOrDieOpen();
    const [ari, bex] = [t.ids[0]!, t.ids[1]!];
    t.must({
      type: "submit_challenge_choice",
      actor: ari,
      pendingId: t.challenge().id,
      submission: rps("rock"),
    });

    // Public: THAT Ari submitted, never WHAT.
    const pendingView = t.view().openPending.find((p) => p.kind === "challenge")!;
    expect(pendingView.submittedPlayerIds).toEqual([ari]);
    expect(JSON.stringify(t.view())).not.toContain("rock");
    expect(eventsOf(t.last, "challenge_revealed")).toHaveLength(0);

    // Private: Bex is still to throw, and must not be able to see what Ari threw.
    expect(foreignSubmissionsVisibleTo(t.state, bex)).toEqual([]);
    expect(JSON.stringify(t.privateView(bex))).not.toContain("rock");
  });

  it("a Power Pair show is hidden from the other participants until all 3 have shown", () => {
    const t = powerPairOpen();
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: t.challenge().id,
      submission: fingers(3),
    });
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[1]!,
      pendingId: t.challenge().id,
      submission: fingers(1),
    });
    const view = t.view().openPending.find((p) => p.kind === "challenge")!;
    expect(view.submittedPlayerIds).toEqual([t.ids[0], t.ids[1]]);
    expect(view.waitingOnIds).toEqual([t.ids[2]]);
    // Cyd is still to show and must learn nothing about the other two.
    expect(foreignSubmissionsVisibleTo(t.state, t.ids[2]!)).toEqual([]);
  });

  it("an It's a Numbers Game show is hidden from the other players until everyone has shown", () => {
    const t = numbersGameOpen(4);
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: t.challenge().id,
      submission: fingers(5),
    });
    const stillToShow = t.ids[3]!;
    expect(foreignSubmissionsVisibleTo(t.state, stillToShow)).toEqual([]);
    // A player who has already shown may not peek at the rest of the table either.
    expect(foreignSubmissionsVisibleTo(t.state, t.ids[1]!)).toEqual([]);
    expect(JSON.stringify(t.view())).not.toContain('"count":5');
  });

  it("a player cannot submit twice to the same challenge", () => {
    const t = doOrDieOpen();
    const id = t.challenge().id;
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: id,
      submission: rps("rock"),
    });
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: id,
      submission: rps("rock"),
    });
    expect(error.code).toBe("already_submitted");
  });

  it("a player cannot change a submission once it is made", () => {
    const t = powerPairOpen();
    const id = t.challenge().id;
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[1]!,
      pendingId: id,
      submission: fingers(2),
    });
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: t.ids[1]!,
      pendingId: id,
      submission: fingers(3),
    });
    expect(error.code).toBe("already_submitted");
    const slot = t.challenge().slots.find((s) => s.playerId === t.ids[1]!)!;
    expect(slot.submission).toEqual({ kind: "fingers", count: 2 });
  });

  it("a Do or Die does not resolve while either throw is outstanding", () => {
    const t = doOrDieOpen();
    const events = t.must({
      type: "submit_challenge_choice",
      actor: t.ids[1]!,
      pendingId: t.challenge().id,
      submission: rps("paper"),
    });
    expect(eventsOf(events, "challenge_resolved")).toHaveLength(0);
    expect(eventsOf(events, "challenge_revealed")).toHaveLength(0);
    expect(t.maybeChallenge()).not.toBeNull();
    expect(t.takes()).toHaveLength(0);
  });

  it("a Power Pair does not resolve while any of the three shows is outstanding", () => {
    const t = powerPairOpen();
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: t.challenge().id,
      submission: fingers(2),
    });
    const events = t.must({
      type: "submit_challenge_choice",
      actor: t.ids[1]!,
      pendingId: t.challenge().id,
      submission: fingers(2),
    });
    // Two of three match already, but the third player has not shown: nothing may resolve.
    expect(eventsOf(events, "challenge_resolved")).toHaveLength(0);
    expect(t.takes()).toHaveLength(0);
    expect(t.maybeChallenge()).not.toBeNull();
  });

  it("It's a Numbers Game does not resolve while any player's show is outstanding", () => {
    const t = numbersGameOpen(4);
    for (const i of [0, 1, 2]) {
      const events = t.must({
        type: "submit_challenge_choice",
        actor: t.ids[i]!,
        pendingId: t.challenge().id,
        submission: fingers((i + 1) as FingerCount),
      });
      expect(eventsOf(events, "challenge_resolved")).toHaveLength(0);
    }
    expect(t.maybeChallenge()).not.toBeNull();
    expect(t.state.pending.filter((p) => p.kind === "steal_victim")).toHaveLength(0);
  });

  it("a player who is not a participant cannot submit to a challenge", () => {
    const t = powerPairOpen(4);
    const outsider = t.ids[3]!;
    expect(t.challenge().slots.map((s) => s.playerId)).not.toContain(outsider);
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: outsider,
      pendingId: t.challenge().id,
      submission: fingers(1),
    });
    expect(error.code).toBe("not_a_participant");
  });

  it("a submission naming a window that is already closed is refused", () => {
    const t = doOrDieOpen();
    const id = t.challenge().id;
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: id,
      submission: rps("rock"),
    });
    t.must({
      type: "submit_challenge_choice",
      actor: t.ids[1]!,
      pendingId: id,
      submission: rps("scissors"),
    });
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: id,
      submission: rps("paper"),
    });
    expect(error.code).toBe("pending_not_found");
  });

  it("the turn cannot advance to the draw step while a challenge is unresolved", () => {
    const t = doOrDieOpen();
    expect(t.view().turn?.phase).toBe("play");
    const error = t.reject({ type: "draw_card", actor: t.ids[0]! });
    expect(error.code).toBe("wrong_turn_phase");
    expect(t.legalActions(t.ids[0]!).map((a) => a.kind)).not.toContain("draw_card");
  });
});

// ---------------------------------------------------------------------------
// Do or Die
// ---------------------------------------------------------------------------

describe("Do or Die: a single game of Rock Paper Scissors", () => {
  interface DoOrDie {
    readonly t: Table;
    readonly ari: PlayerId;
    readonly bex: PlayerId;
  }

  function setup(opts?: {
    readonly ariHand?: HandSpec;
    readonly bexHand?: HandSpec;
  }): DoOrDie {
    const ariExtra = opts?.ariHand ?? FILLER;
    const bexHand: HandSpec = opts?.bexHand ?? ["any", "any", "any", "any"];
    const t = tableReadyToPlay(3, [
      [0, [CardKind.DoOrDie, ...ariExtra]],
      [1, bexHand],
      [2, FILLER],
    ]);
    const ari = t.ids[0]!;
    const bex = t.ids[1]!;
    t.must({
      type: "play_do_or_die",
      actor: ari,
      cardUid: t.uidInHand(ari, CardKind.DoOrDie),
      opponent: bex,
    });
    return { t, ari, bex };
  }

  function throwBoth(g: DoOrDie, a: RpsThrow, b: RpsThrow): readonly GameEvent[] {
    const id = g.t.challenge().id;
    g.t.must({
      type: "submit_challenge_choice",
      actor: g.ari,
      pendingId: id,
      submission: rps(a),
    });
    return g.t.must({
      type: "submit_challenge_choice",
      actor: g.bex,
      pendingId: id,
      submission: rps(b),
    });
  }

  it("rock beats scissors, paper beats rock and scissors beats paper", () => {
    const cycle: readonly (readonly [RpsThrow, RpsThrow])[] = [
      ["rock", "scissors"],
      ["paper", "rock"],
      ["scissors", "paper"],
    ];
    for (const [winning, losing] of cycle) {
      // The player who played the card wins.
      const first = setup();
      const eventsA = throwBoth(first, winning, losing);
      expect(eventsOf(eventsA, "challenge_resolved")[0]?.outcome).toEqual({
        kind: "rps_decisive",
        winnerId: first.ari,
        loserId: first.bex,
      });
      // The same pair of throws the other way round: the opponent wins.
      const second = setup();
      const eventsB = throwBoth(second, losing, winning);
      expect(eventsOf(eventsB, "challenge_resolved")[0]?.outcome).toEqual({
        kind: "rps_decisive",
        winnerId: second.bex,
        loserId: second.ari,
      });
    }
  });

  it("the winner steals 2 random cards from the loser", () => {
    const g = setup();
    const loserHandBefore = g.t.hand(g.bex);
    const winnerHandBefore = g.t.hand(g.ari);
    throwBoth(g, "rock", "scissors");

    const take = g.t.takes()[0];
    expect(take).toBeDefined();
    expect(take!.origin.kind).toBe("challenge");
    expect(take!.takerIds).toEqual([g.ari]);
    expect(take!.victimId).toBe(g.bex);
    // "they steal 2 RANDOM cards from the loser" — the count and the selection are both printed.
    expect(take!.spec).toEqual({ kind: "random", count: 2 });

    g.t.must({ type: "decline_reaction", actor: g.bex, pendingId: take!.id });
    const gained = g.t.hand(g.ari).filter((u) => !winnerHandBefore.includes(u));
    expect(gained).toHaveLength(2);
    expect(gained.every((u) => loserHandBefore.includes(u))).toBe(true);
    expect(g.t.hand(g.bex)).toHaveLength(loserHandBefore.length - 2);
    g.t.expectCensusBalances();
  });

  it("the player who played the card can lose: the opponent steals 2 cards from them", () => {
    const g = setup({ ariHand: ["any", "any", "any"] });
    const ariBefore = g.t.hand(g.ari);
    throwBoth(g, "rock", "paper");
    const take = g.t.takes()[0]!;
    expect(take.takerIds).toEqual([g.bex]);
    expect(take.victimId).toBe(g.ari);
    g.t.must({ type: "decline_reaction", actor: g.ari, pendingId: take.id });
    expect(g.t.hand(g.ari)).toHaveLength(ariBefore.length - 2);
  });

  it("a tie makes each player swap 1 card of their OWN choice and steals nothing", () => {
    const g = setup();
    const events = throwBoth(g, "paper", "paper");
    expect(eventsOf(events, "challenge_resolved")[0]?.outcome).toEqual({
      kind: "rps_tie",
      playerIds: [g.ari, g.bex],
    });
    // A tie is not a steal: no take window, therefore no Sorry For You window either.
    expect(g.t.takes()).toHaveLength(0);

    const choices = g.t.cardChoices();
    expect(choices).toHaveLength(2);
    for (const choice of choices) {
      expect(choice.reason).toBe("do_or_die_swap");
      // Each player picks from their OWN hand — "you each swap 1 card of your choice".
      expect([...choice.options].sort()).toEqual(
        [...g.t.hand(choice.chooserId)].sort(),
      );
    }

    const ariChoice = choices.find((c) => c.chooserId === g.ari)!;
    const bexChoice = choices.find((c) => c.chooserId === g.bex)!;
    const ariGives = g.t.hand(g.ari)[1]!;
    const bexGives = g.t.hand(g.bex)[2]!;

    g.t.must({
      type: "choose_card",
      actor: g.ari,
      pendingId: ariChoice.id,
      cardUid: ariGives,
    });
    g.t.must({
      type: "choose_card",
      actor: g.bex,
      pendingId: bexChoice.id,
      cardUid: bexGives,
    });

    // Exactly the two chosen cards changed hands, one for one.
    expect(g.t.hand(g.bex)).toContain(ariGives);
    expect(g.t.hand(g.ari)).toContain(bexGives);
    expect(g.t.hand(g.ari)).not.toContain(ariGives);
    expect(g.t.hand(g.bex)).not.toContain(bexGives);
    g.t.expectCensusBalances();
  });

  it("the tie swap does not complete until both players have chosen", () => {
    const g = setup();
    throwBoth(g, "rock", "rock");
    const ariChoice = g.t.cardChoices().find((c) => c.chooserId === g.ari)!;
    const bexHandBefore = g.t.hand(g.bex);
    const events = g.t.must({
      type: "choose_card",
      actor: g.ari,
      pendingId: ariChoice.id,
      cardUid: g.t.hand(g.ari)[0]!,
    });
    expect(eventsOf(events, "challenge_swap_completed")).toHaveLength(0);
    expect(eventsOf(events, "cards_transferred")).toHaveLength(0);
    expect(g.t.hand(g.bex)).toEqual(bexHandBefore);
    expect(g.t.cardChoices()).toHaveLength(2);
  });

  it("a player may only offer a card from their own hand in the tie swap", () => {
    const g = setup();
    throwBoth(g, "scissors", "scissors");
    const ariChoice = g.t.cardChoices().find((c) => c.chooserId === g.ari)!;
    const error = g.t.reject({
      type: "choose_card",
      actor: g.ari,
      pendingId: ariChoice.id,
      cardUid: g.t.hand(g.bex)[0]!,
    });
    expect(error.code).toBe("invalid_target");
  });

  it("a tie is a defined outcome, not a replay: Do or Die is a SINGLE round", () => {
    const g = setup();
    const events = throwBoth(g, "rock", "rock");
    expect(eventsOf(events, "challenge_replayed")).toHaveLength(0);
    expect(g.t.maybeChallenge()).toBeNull();
    expect(eventsOf(events, "challenge_revealed")[0]?.round).toBe(1);
  });

  it("Sorry For You blocks the Do or Die steal: the winner gets nothing and discards 1", () => {
    const g = setup({
      bexHand: [CardKind.SorryForYou, "any", "any"],
    });
    const bexBefore = g.t.hand(g.bex);
    const ariBefore = g.t.hand(g.ari);
    throwBoth(g, "paper", "rock");
    const take = g.t.takes()[0]!;
    const sorry = g.t.uidInHand(g.bex, CardKind.SorryForYou);
    const events = g.t.must({
      type: "play_sorry_for_you",
      actor: g.bex,
      cardUid: sorry,
      pendingId: take.id,
    });
    const blocked = eventsOf(events, "take_blocked")[0];
    expect(blocked?.blockedTakerIds).toEqual([g.ari]);

    // "they get nothing from you and must discard 1 card (regardless of how many cards you owe)".
    expect(g.t.hand(g.ari).filter((u) => !ariBefore.includes(u))).toHaveLength(0);
    expect(g.t.hand(g.bex)).toEqual(bexBefore.filter((u) => u !== sorry));
    const discard = g.t.discards();
    expect(discard).toHaveLength(1);
    expect(discard[0]!.playerId).toBe(g.ari);
    expect(discard[0]!.count).toBe(1);
    g.t.expectCensusBalances();
  });

  it("a Rock Paper Scissors throw is the only legal submission to Do or Die", () => {
    const g = setup();
    const error = g.t.reject({
      type: "submit_challenge_choice",
      actor: g.ari,
      pendingId: g.t.challenge().id,
      submission: fingers(2),
    });
    expect(error.code).toBe("wrong_number_of_choices");
  });
});

// ---------------------------------------------------------------------------
// Power Pair
// ---------------------------------------------------------------------------

describe("Power Pair: three players, 1 to 3 fingers", () => {
  interface Pair {
    readonly t: Table;
    readonly ids: readonly [PlayerId, PlayerId, PlayerId];
  }

  function setup(playerCount = 4, oddHand?: HandSpec): Pair {
    const hands: (readonly [number, HandSpec])[] = [];
    for (let i = 0; i < playerCount; i += 1) {
      if (i === 0) hands.push([0, [CardKind.PowerPair, ...FILLER]] as const);
      else if (i === 2 && oddHand) hands.push([2, oddHand] as const);
      else hands.push([i, FILLER] as const);
    }
    const t = tableReadyToPlay(playerCount, hands);
    t.must({
      type: "play_power_pair",
      actor: t.ids[0]!,
      cardUid: t.uidInHand(t.ids[0]!, CardKind.PowerPair),
      first: t.ids[1]!,
      second: t.ids[2]!,
    });
    return { t, ids: [t.ids[0]!, t.ids[1]!, t.ids[2]!] };
  }

  function showAll(
    g: Pair,
    a: FingerCount,
    b: FingerCount,
    c: FingerCount,
  ): readonly GameEvent[] {
    const id = g.t.challenge().id;
    g.t.must({
      type: "submit_challenge_choice",
      actor: g.ids[0],
      pendingId: id,
      submission: fingers(a),
    });
    g.t.must({
      type: "submit_challenge_choice",
      actor: g.ids[1],
      pendingId: id,
      submission: fingers(b),
    });
    return g.t.must({
      type: "submit_challenge_choice",
      actor: g.ids[2],
      pendingId: id,
      submission: fingers(c),
    });
  }

  it("exactly 2 matching numbers means those two each steal 1 random card from the 3rd", () => {
    const g = setup();
    const [ari, bex, cyd] = g.ids;
    const cydBefore = g.t.hand(cyd);
    const ariBefore = g.t.hand(ari);
    const bexBefore = g.t.hand(bex);
    const events = showAll(g, 2, 2, 3);

    expect(eventsOf(events, "challenge_resolved")[0]?.outcome).toEqual({
      kind: "power_pair_matched",
      matchedIds: [ari, bex],
      oddOneOutId: cyd,
    });
    // ONE take with TWO takers, so one Sorry For You can blank both (Survival Guide sidebar).
    const takes = g.t.takes();
    expect(takes).toHaveLength(1);
    expect(takes[0]!.takerIds).toEqual([ari, bex]);
    expect(takes[0]!.victimId).toBe(cyd);
    expect(takes[0]!.spec).toEqual({ kind: "random", count: 2 });

    g.t.must({ type: "decline_reaction", actor: cyd, pendingId: takes[0]!.id });
    // "they EACH steal 1 random card from the 3rd player" — one each, two in total.
    expect(g.t.hand(ari).filter((u) => !ariBefore.includes(u))).toHaveLength(1);
    expect(g.t.hand(bex).filter((u) => !bexBefore.includes(u))).toHaveLength(1);
    expect(g.t.hand(cyd)).toHaveLength(cydBefore.length - 2);
    g.t.expectCensusBalances();
  });

  it("all 3 showing the same number means each player discards 1 and nobody steals", () => {
    const g = setup();
    const events = showAll(g, 1, 1, 1);
    expect(eventsOf(events, "challenge_resolved")[0]?.outcome).toEqual({
      kind: "power_pair_all_same",
      playerIds: [...g.ids],
    });
    expect(g.t.takes()).toHaveLength(0);
    const discards = g.t.discards();
    expect(discards.map((d) => d.playerId).sort()).toEqual([...g.ids].sort());
    expect(discards.every((d) => d.count === 1)).toBe(true);
    expect(discards.every((d) => d.reason === "power_pair_all_same")).toBe(true);

    for (const d of discards) {
      const before = g.t.hand(d.playerId);
      g.t.must({
        type: "discard_card",
        actor: d.playerId,
        pendingId: d.id,
        cardUid: before[0]!,
      });
      expect(g.t.hand(d.playerId)).toHaveLength(before.length - 1);
      expect(g.t.state.zones.discardPile).toContain(before[0]!);
    }
    g.t.expectCensusBalances();
  });

  it("everyone showing a different number means play again with the same 3 players", () => {
    const g = setup();
    const events = showAll(g, 1, 2, 3);
    const replayed = eventsOf(events, "challenge_replayed")[0];
    expect(replayed?.reason).toBe("all_different");
    expect(replayed?.nextRound).toBe(2);
    expect(eventsOf(events, "challenge_resolved")).toHaveLength(0);
    expect(g.t.takes()).toHaveLength(0);
    expect(g.t.discards()).toHaveLength(0);

    const round2 = g.t.challenge();
    expect(round2.round).toBe(2);
    expect(round2.slots.map((s) => s.playerId)).toEqual([...g.ids]);
    expect(round2.slots.every((s) => s.submission === null)).toBe(true);

    // The replay is a real round that can decide the challenge.
    const decided = showAll(g, 3, 3, 1);
    expect(eventsOf(decided, "challenge_resolved")[0]?.outcome).toMatchObject({
      kind: "power_pair_matched",
      oddOneOutId: g.ids[2],
    });
  });

  it("one Sorry For You from the odd one out blanks BOTH stealers and each discards 1", () => {
    const g = setup(4, [CardKind.SorryForYou, "any", "any"]);
    const [ari, bex, cyd] = g.ids;
    const ariBefore = g.t.hand(ari);
    const bexBefore = g.t.hand(bex);
    showAll(g, 3, 3, 1);
    const take = g.t.takes()[0]!;
    const events = g.t.must({
      type: "play_sorry_for_you",
      actor: cyd,
      cardUid: g.t.uidInHand(cyd, CardKind.SorryForYou),
      pendingId: take.id,
    });
    expect(eventsOf(events, "take_blocked")[0]?.blockedTakerIds).toEqual([ari, bex]);
    expect(g.t.hand(ari)).toEqual(ariBefore);
    expect(g.t.hand(bex)).toEqual(bexBefore);
    const discards = g.t.discards();
    expect(discards.map((d) => d.playerId).sort()).toEqual([ari, bex].sort());
    expect(discards.every((d) => d.count === 1)).toBe(true);
    g.t.expectCensusBalances();
  });

  it("Power Pair is played by exactly 3 players regardless of table size", () => {
    const g = setup(6);
    expect(g.t.state.players).toHaveLength(6);
    expect(g.t.challenge().slots.map((s) => s.playerId)).toEqual([...g.ids]);
  });

  it("Power Pair accepts 1, 2 or 3 fingers and nothing else", () => {
    const g = setup();
    for (const legal of [1, 2, 3] as FingerCount[]) {
      const probe = setup();
      probe.t.must({
        type: "submit_challenge_choice",
        actor: probe.ids[0],
        pendingId: probe.t.challenge().id,
        submission: fingers(legal),
      });
    }
    for (const illegal of [4, 5] as FingerCount[]) {
      const error = g.t.reject({
        type: "submit_challenge_choice",
        actor: g.ids[0],
        pendingId: g.t.challenge().id,
        submission: fingers(illegal),
      });
      expect(error.code).toBe("wrong_number_of_choices");
    }
  });

  it("a number of fingers outside the printed range is not a legal Power Pair show", () => {
    const g = setup();
    // The printed card says "hold out 1, 2, or 3 fingers"; 0 fingers is not a show.
    const error = g.t.reject({
      type: "submit_challenge_choice",
      actor: g.ids[0],
      pendingId: g.t.challenge().id,
      submission: { kind: "fingers", count: 0 as FingerCount },
    });
    expect(error.code).toBe("wrong_number_of_choices");
  });

  it("the two players who match may be the two opponents, who then steal from the player who played the card", () => {
    const g = setup();
    const [ari, bex, cyd] = g.ids;
    const ariBefore = g.t.hand(ari);
    showAll(g, 1, 3, 3);
    const take = g.t.takes()[0]!;
    expect(take.takerIds).toEqual([bex, cyd]);
    expect(take.victimId).toBe(ari);
    g.t.must({ type: "decline_reaction", actor: ari, pendingId: take.id });
    expect(g.t.hand(ari)).toHaveLength(ariBefore.length - 2);
  });
});

// ---------------------------------------------------------------------------
// It's a Numbers Game
// ---------------------------------------------------------------------------

describe("It's a Numbers Game: every player, 1 to 5 fingers, lowest unique wins", () => {
  function setup(playerCount = 4): Table {
    const hands: (readonly [number, HandSpec])[] = [];
    for (let i = 0; i < playerCount; i += 1) {
      hands.push(
        i === 0
          ? ([0, [CardKind.ItsANumbersGame, ...FILLER]] as const)
          : ([i, FILLER] as const),
      );
    }
    const t = tableReadyToPlay(playerCount, hands);
    t.must({
      type: "play_its_a_numbers_game",
      actor: t.ids[0]!,
      cardUid: t.uidInHand(t.ids[0]!, CardKind.ItsANumbersGame),
    });
    return t;
  }

  function showAll(t: Table, shows: readonly FingerCount[]): readonly GameEvent[] {
    const id = t.challenge().id;
    let events: readonly GameEvent[] = [];
    shows.forEach((count, i) => {
      events = t.must({
        type: "submit_challenge_choice",
        actor: t.ids[i]!,
        pendingId: id,
        submission: fingers(count),
      });
    });
    return events;
  }

  it("every player in the game participates, including the player who played the card", () => {
    const t = setup(5);
    expect(t.challenge().slots.map((s) => s.playerId)).toEqual(t.ids);
    expect(t.challenge().initiatorId).toBe(t.ids[0]);
  });

  it("the LOWEST UNIQUE number wins, not the lowest number", () => {
    const t = setup(4);
    // 1, 1, 2, 3 — the two 1s cancel, so the 2 wins.
    const events = showAll(t, [1, 1, 2, 3]);
    expect(eventsOf(events, "challenge_resolved")[0]?.outcome).toEqual({
      kind: "numbers_game_winner",
      winnerId: t.ids[2],
      number: 2,
    });
  });

  it("the challenge replays when no number is unique", () => {
    const t = setup(4);
    // 1, 1, 2, 2 — every number is duplicated, so there is no winner and the whole thing replays.
    const events = showAll(t, [1, 1, 2, 2]);
    const replay = eventsOf(events, "challenge_replayed")[0];
    expect(replay?.reason).toBe("no_unique_lowest");
    expect(replay?.nextRound).toBe(2);
    expect(eventsOf(events, "challenge_resolved")).toHaveLength(0);
    expect(t.state.pending.filter((p) => p.kind === "steal_victim")).toHaveLength(0);

    const round2 = t.challenge();
    expect(round2.round).toBe(2);
    expect(round2.slots.map((s) => s.playerId)).toEqual(t.ids);
    expect(round2.slots.every((s) => s.submission === null)).toBe(true);

    // "If necessary, repeat until there's a single winner."
    const decided = showAll(t, [5, 5, 4, 4]);
    expect(eventsOf(decided, "challenge_replayed")[0]?.nextRound).toBe(3);
    const finished = showAll(t, [3, 3, 3, 1]);
    expect(eventsOf(finished, "challenge_resolved")[0]?.outcome).toEqual({
      kind: "numbers_game_winner",
      winnerId: t.ids[3],
      number: 1,
    });
  });

  it("the winner steals 2 random cards from any player they name", () => {
    const t = setup(4);
    showAll(t, [4, 1, 2, 3]);
    const winner = t.ids[1]!;
    const window = t.stealVictimWindow();
    expect(window.chooserId).toBe(winner);
    expect(window.count).toBe(2);
    // The victim is the winner's choice and need not be the player who played the card.
    const victim = t.ids[3]!;
    const victimBefore = t.hand(victim);
    const winnerBefore = t.hand(winner);
    t.must({
      type: "choose_steal_victim",
      actor: winner,
      pendingId: window.id,
      target: victim,
    });
    const take = t.takes()[0]!;
    expect(take.victimId).toBe(victim);
    expect(take.spec).toEqual({ kind: "random", count: 2 });
    t.must({ type: "decline_reaction", actor: victim, pendingId: take.id });
    expect(t.hand(winner).filter((u) => !winnerBefore.includes(u))).toHaveLength(2);
    expect(t.hand(victim)).toHaveLength(victimBefore.length - 2);
    t.expectCensusBalances();
  });

  it("only the winner may name the victim of the steal", () => {
    const t = setup(4);
    showAll(t, [4, 1, 2, 3]);
    const window = t.stealVictimWindow();
    const error = t.reject({
      type: "choose_steal_victim",
      actor: t.ids[0]!,
      pendingId: window.id,
      target: t.ids[2]!,
    });
    expect(error.code).toBe("not_a_participant");
  });

  it("Sorry For You blocks the Numbers Game steal: 2 cards saved for 1 discard", () => {
    const t = setup(4);
    const victim = t.ids[3]!;
    t.setHands([[victim, [CardKind.SorryForYou, "any", "any"]]]);
    showAll(t, [4, 1, 2, 3]);
    const winner = t.ids[1]!;
    const winnerBefore = t.hand(winner);
    t.must({
      type: "choose_steal_victim",
      actor: winner,
      pendingId: t.stealVictimWindow().id,
      target: victim,
    });
    const take = t.takes()[0]!;
    const events = t.must({
      type: "play_sorry_for_you",
      actor: victim,
      cardUid: t.uidInHand(victim, CardKind.SorryForYou),
      pendingId: take.id,
    });
    expect(eventsOf(events, "take_blocked")[0]?.blockedTakerIds).toEqual([winner]);
    expect(t.hand(winner)).toEqual(winnerBefore);
    // "regardless of how many cards you owe them" — 2 cards blocked, exactly 1 discard.
    const discards = t.discards();
    expect(discards).toHaveLength(1);
    expect(discards[0]!.playerId).toBe(winner);
    expect(discards[0]!.count).toBe(1);
    t.expectCensusBalances();
  });

  it("It's a Numbers Game accepts 1 through 5 fingers and nothing else", () => {
    for (const legal of [1, 2, 3, 4, 5] as FingerCount[]) {
      const t = setup(4);
      t.must({
        type: "submit_challenge_choice",
        actor: t.ids[0]!,
        pendingId: t.challenge().id,
        submission: fingers(legal),
      });
    }
    const t = setup(4);
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: t.challenge().id,
      submission: { kind: "fingers", count: 6 as FingerCount },
    });
    expect(error.code).toBe("wrong_number_of_choices");
  });

  it("a number of fingers below 1 is not a legal show", () => {
    const t = setup(4);
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: t.challenge().id,
      submission: { kind: "fingers", count: 0 as FingerCount },
    });
    expect(error.code).toBe("wrong_number_of_choices");
  });

  it("a Rock Paper Scissors throw is not a legal show in a finger challenge", () => {
    const t = setup(4);
    const error = t.reject({
      type: "submit_challenge_choice",
      actor: t.ids[0]!,
      pendingId: t.challenge().id,
      submission: rps("rock"),
    });
    expect(error.code).toBe("wrong_number_of_choices");
  });
});

// ---------------------------------------------------------------------------
// Playing a Reward Challenge card
// ---------------------------------------------------------------------------

describe("a Reward Challenge is played as your one card play on your turn", () => {
  it("playing a Reward Challenge card consumes the turn's single card play", () => {
    const t = tableReadyToPlay(4, [
      [0, [CardKind.DoOrDie, CardKind.PowerPair, "any"]],
      [1, FILLER],
      [2, FILLER],
      [3, FILLER],
    ]);
    const ari = t.ids[0]!;
    const doOrDie = t.uidInHand(ari, CardKind.DoOrDie);
    const powerPair = t.uidInHand(ari, CardKind.PowerPair);
    t.must({
      type: "play_do_or_die",
      actor: ari,
      cardUid: doOrDie,
      opponent: t.ids[1]!,
    });
    expect(t.view().turn?.cardPlayedThisTurn).toBe(doOrDie);
    const error = t.reject({
      type: "play_power_pair",
      actor: ari,
      cardUid: powerPair,
      first: t.ids[1]!,
      second: t.ids[2]!,
    });
    expect(error.code).toBe("card_already_played_this_turn");
  });

  it("Do or Die is played against another player, never yourself", () => {
    const t = tableReadyToPlay(3, [
      [0, [CardKind.DoOrDie, "any", "any"]],
      [1, FILLER],
      [2, FILLER],
    ]);
    const ari = t.ids[0]!;
    const error = t.reject({
      type: "play_do_or_die",
      actor: ari,
      cardUid: t.uidInHand(ari, CardKind.DoOrDie),
      opponent: ari,
    });
    expect(error.code).toBe("self_target_not_allowed");
  });

  it("Power Pair picks 2 OTHER players, and never the same player twice", () => {
    const t = tableReadyToPlay(4, [
      [0, [CardKind.PowerPair, "any", "any"]],
      [1, FILLER],
      [2, FILLER],
      [3, FILLER],
    ]);
    const ari = t.ids[0]!;
    const card = t.uidInHand(ari, CardKind.PowerPair);
    expect(
      t.reject({
        type: "play_power_pair",
        actor: ari,
        cardUid: card,
        first: t.ids[1]!,
        second: t.ids[1]!,
      }).code,
    ).toBe("duplicate_target");
    expect(
      t.reject({
        type: "play_power_pair",
        actor: ari,
        cardUid: card,
        first: ari,
        second: t.ids[1]!,
      }).code,
    ).toBe("self_target_not_allowed");
  });

  it("the turn reaches the draw step only once the challenge and its payout are settled", () => {
    const t = tableReadyToPlay(3, [
      [0, [CardKind.DoOrDie, "any", "any"]],
      [1, FILLER],
      [2, FILLER],
    ]);
    const [ari, bex] = [t.ids[0]!, t.ids[1]!];
    t.must({
      type: "play_do_or_die",
      actor: ari,
      cardUid: t.uidInHand(ari, CardKind.DoOrDie),
      opponent: bex,
    });
    const id = t.challenge().id;
    t.must({
      type: "submit_challenge_choice",
      actor: ari,
      pendingId: id,
      submission: rps("rock"),
    });
    t.must({
      type: "submit_challenge_choice",
      actor: bex,
      pendingId: id,
      submission: rps("scissors"),
    });
    // The steal window is still open, so the turn is still on the play step.
    expect(t.view().turn?.phase).toBe("play");
    t.must({ type: "decline_reaction", actor: bex, pendingId: t.takes()[0]!.id });
    expect(t.view().turn?.phase).toBe("draw");
    expect(t.state.pending).toHaveLength(0);
    t.expectCensusBalances();
  });
});
