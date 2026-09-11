/**
 * SNAPSHOT ROUND-TRIP.
 *
 * The property under test is the one `Game.snapshot()` documents:
 *   "Must round-trip: restore(snapshot(g)).state() deep-equals g.state()."
 * and the stronger one the persistence layer actually depends on — a restored game must be
 * INDISTINGUISHABLE from the original, not merely equal at the instant of restore. So every
 * moment tested here is snapshotted, pushed through `JSON.stringify`/`JSON.parse` (the real
 * wire), re-parsed with `parseSnapshot`, restored, deep-compared, and then BOTH games are
 * driven forward with the identical action script and the identical clock, and their event
 * streams and states are compared step for step.
 *
 * docs/RULES.md is the spec for what the moments mean; ARCHITECTURE.md §7 and the header of
 * src/engine/snapshot.ts are the spec for the boundary behaviour (versioning + rejection).
 */

import { beforeAll, describe, expect, it } from "vitest";

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
  SNAPSHOT_SCHEMA_VERSION,
  asGameId,
  asPlayerId,
  isInPlay,
  type Action,
  type CardUid,
  type CouncilState,
  type FingerCount,
  type Game,
  type GameSnapshot,
  type GameState,
  type LegalAction,
  type Pending,
  type PlayerId,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Deterministic scaffolding
// ---------------------------------------------------------------------------

const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eze", "Fen"] as const;
const idOf = (i: number): PlayerId => asPlayerId(`u-${NAMES[i]!.toLowerCase()}`);

/** One shared clock per rig: the restored copy must be driven with the SAME timestamps. */
class Clock {
  ms = 1_700_000_000_000;
  next(): number {
    this.ms += 1000;
    return this.ms;
  }
}

interface Rig {
  readonly game: Game;
  readonly clock: Clock;
  readonly seed: number;
  readonly players: number;
}

interface Strategy {
  /** `spread` votes for the player on your left, which manufactures ties. */
  readonly voteMode: "spread" | "concentrate";
  /** Play turn cards whenever one is legal (reaches Camp Raid / the Reward Challenges). */
  readonly playCards: boolean;
}

const SPREAD: Strategy = { voteMode: "spread", playCards: true };
const CONCENTRATE: Strategy = { voteMode: "concentrate", playCards: true };
const QUIET: Strategy = { voteMode: "concentrate", playCards: false };

function newRig(seed: number, players: number): Rig {
  const clock = new Clock();
  const game = createGame({
    gameId: asGameId(`snap-${seed}-${players}`),
    hostId: idOf(0),
    config: DEFAULT_CONFIG.engine,
    nowMs: clock.next(),
    seed,
  });
  for (let i = 0; i < players; i += 1) {
    const out = game.dispatch(
      { type: "join_game", actor: idOf(i), displayName: NAMES[i]! },
      clock.next(),
    );
    if (!out.ok) throw new Error(`join failed: ${out.error.code}`);
  }
  const started = game.dispatch(
    { type: "start_game", actor: idOf(0), firstPlayer: idOf(0) },
    clock.next(),
  );
  if (!started.ok) throw new Error(`start failed: ${started.error.code}`);
  return { game, clock, seed, players };
}

// ---------------------------------------------------------------------------
// The autopilot — reads `legalActions` and fills in what a human would have chosen
// ---------------------------------------------------------------------------

const PRIORITY: readonly string[] = [
  "play_sorry_for_you",
  "play_inheritance",
  "decline_reaction",
  "discard_card",
  "choose_card",
  "choose_alliance_target",
  "choose_steal_victim",
  "submit_challenge_choice",
  "leader_choose_eliminations",
  "play_immunity_idol",
  "play_idol_nullifier",
  "cast_vote",
  "finish_voting",
  "play_control_the_vote",
  "play_goodwill_gamble",
  "play_im_the_leader_now",
  "advance_council",
  "cast_jury_vote",
  "reveal_hand",
  "juror_ready",
  "final_leader_break_tie",
  "advance_final_council",
  "steal_random",
  "play_camp_raid",
  "play_do_or_die",
  "play_power_pair",
  "play_lets_form_an_alliance",
  "play_spy_shack",
  "play_knowledge_is_power",
  "play_its_a_numbers_game",
  "skip_play_step",
  "draw_card",
];

const TURN_CARD_PLAYS: readonly string[] = [
  "play_camp_raid",
  "play_do_or_die",
  "play_power_pair",
  "play_lets_form_an_alliance",
  "play_spy_shack",
  "play_knowledge_is_power",
  "play_its_a_numbers_game",
];

function voteTarget(state: GameState, voter: PlayerId, strategy: Strategy): PlayerId {
  const alive = state.players
    .filter((p) => isInPlay(p))
    .sort((a, b) => a.seat - b.seat);
  const others = alive.filter((p) => p.id !== voter);
  if (others.length === 0) return alive[0]!.id;
  if (strategy.voteMode === "spread") {
    const me = alive.findIndex((p) => p.id === voter);
    return alive[(me + 1) % alive.length]!.id;
  }
  return others[0]!.id;
}

function buildAction(
  game: Game,
  actor: PlayerId,
  legal: LegalAction,
  strategy: Strategy,
): Action | null {
  const state = game.state();
  const targets = legal.legalTargets ?? [];
  const cards = legal.playableCardUids ?? [];
  const pendingId = legal.pendingId;
  const council = state.stage.kind === "council" ? state.stage.council : null;
  const final = state.stage.kind === "final_council" ? state.stage.finalCouncil : null;

  switch (legal.kind) {
    case "steal_random":
      return targets[0] ? { type: "steal_random", actor, target: targets[0] } : null;
    case "skip_play_step":
      return { type: "skip_play_step", actor };
    case "draw_card":
      return { type: "draw_card", actor };
    case "play_sorry_for_you":
      return pendingId && cards[0]
        ? { type: "play_sorry_for_you", actor, cardUid: cards[0], pendingId }
        : null;
    case "play_inheritance":
      return pendingId && cards[0]
        ? { type: "play_inheritance", actor, cardUid: cards[0], pendingId }
        : null;
    case "decline_reaction":
      return pendingId ? { type: "decline_reaction", actor, pendingId } : null;
    case "discard_card":
      return pendingId && cards[0]
        ? { type: "discard_card", actor, pendingId, cardUid: cards[0] }
        : null;
    case "choose_card": {
      const options = legal.optionCardUids ?? [];
      return pendingId && options[0]
        ? { type: "choose_card", actor, pendingId, cardUid: options[0] }
        : null;
    }
    case "choose_alliance_target":
      return pendingId && targets[0]
        ? { type: "choose_alliance_target", actor, pendingId, target: targets[0] }
        : null;
    case "choose_steal_victim":
      return pendingId && targets[0]
        ? { type: "choose_steal_victim", actor, pendingId, target: targets[0] }
        : null;
    case "submit_challenge_choice": {
      if (!pendingId) return null;
      const pending = state.pending.find((p) => p.id === pendingId);
      if (!pending || pending.kind !== "challenge") return null;
      // A hash, not a rotation: three different numbers every round makes Power Pair replay
      // forever, which is exactly what the card says to do — and never terminates.
      const seat = state.players.find((p) => p.id === actor)?.seat ?? 0;
      const salt = (seat * 31 + pending.round * 17 + 11) >>> 0;
      const roll = (Math.imul(salt, 2654435761) >>> 0) % 1000;
      if (pending.challenge === "do_or_die") {
        const throws = ["rock", "paper", "scissors"] as const;
        return {
          type: "submit_challenge_choice",
          actor,
          pendingId,
          submission: { kind: "rps", throw: throws[roll % 3]! },
        };
      }
      const max = pending.challenge === "power_pair" ? 3 : 5;
      return {
        type: "submit_challenge_choice",
        actor,
        pendingId,
        submission: { kind: "fingers", count: ((roll % max) + 1) as FingerCount },
      };
    }
    case "leader_choose_eliminations":
      return pendingId
        ? {
            type: "leader_choose_eliminations",
            actor,
            pendingId,
            targets: targets.slice(0, legal.chooseCount ?? 1),
          }
        : null;
    case "cast_vote":
      return cards[0]
        ? {
            type: "cast_vote",
            actor,
            cardUid: cards[0],
            target: voteTarget(state, actor, strategy),
          }
        : null;
    case "finish_voting":
      return { type: "finish_voting", actor };
    case "play_immunity_idol": {
      if (!cards[0]) return null;
      const alive = state.players
        .filter((p) => isInPlay(p))
        .sort((a, b) => a.seat - b.seat);
      return {
        type: "play_immunity_idol",
        actor,
        cardUid: cards[0],
        protects: alive[0]!.id,
      };
    }
    case "play_idol_nullifier": {
      const idol = council?.idolPlays.find((i) => i.nullifiedBy === null);
      return cards[0] && idol
        ? {
            type: "play_idol_nullifier",
            actor,
            cardUid: cards[0],
            targetIdolUid: idol.cardUid,
          }
        : null;
    }
    case "advance_council":
      return council ? { type: "advance_council", actor, from: council.phase } : null;
    case "advance_final_council":
      return final ? { type: "advance_final_council", actor, from: final.phase } : null;
    case "juror_ready":
      return { type: "juror_ready", actor };
    case "reveal_hand":
      return { type: "reveal_hand", actor };
    case "cast_jury_vote": {
      if (!final) return null;
      // Jurors split by index, so an even jury ties and the Final Leader must break it.
      const idx = final.jury.indexOf(actor);
      return { type: "cast_jury_vote", actor, finalist: final.finalists[idx % 2]! };
    }
    case "final_leader_break_tie":
      return final
        ? { type: "final_leader_break_tie", actor, winner: final.finalists[0] }
        : null;
    case "play_camp_raid":
      return cards[0] && targets[0]
        ? { type: "play_camp_raid", actor, cardUid: cards[0], target: targets[0] }
        : null;
    case "play_spy_shack":
      return cards[0] && targets[0]
        ? { type: "play_spy_shack", actor, cardUid: cards[0], target: targets[0] }
        : null;
    case "play_knowledge_is_power": {
      if (!cards[0] || !targets[0]) return null;
      const victim = state.players.find((p) => p.id === targets[0]);
      const named =
        victim?.hand
          .map((uid) => game.card(uid)?.kind)
          .find((k): k is CardKind => k !== undefined && k !== CardKind.Vote) ??
        CardKind.SorryForYou;
      return {
        type: "play_knowledge_is_power",
        actor,
        cardUid: cards[0],
        target: targets[0],
        named,
      };
    }
    case "play_lets_form_an_alliance":
      return cards[0] && targets[0] && targets[1]
        ? {
            type: "play_lets_form_an_alliance",
            actor,
            cardUid: cards[0],
            partner: targets[0],
            victim: targets[1],
          }
        : null;
    case "play_do_or_die":
      return cards[0] && targets[0]
        ? { type: "play_do_or_die", actor, cardUid: cards[0], opponent: targets[0] }
        : null;
    case "play_power_pair":
      return cards[0] && targets[0] && targets[1]
        ? {
            type: "play_power_pair",
            actor,
            cardUid: cards[0],
            first: targets[0],
            second: targets[1],
          }
        : null;
    case "play_its_a_numbers_game":
      return cards[0]
        ? { type: "play_its_a_numbers_game", actor, cardUid: cards[0] }
        : null;
    case "play_control_the_vote":
      return cards[0] && targets[0]
        ? {
            type: "play_control_the_vote",
            actor,
            cardUid: cards[0],
            target: targets[0],
          }
        : null;
    case "play_goodwill_gamble":
      return cards[0] && targets[0]
        ? {
            type: "play_goodwill_gamble",
            actor,
            cardUid: cards[0],
            recipient: targets[0],
          }
        : null;
    case "play_im_the_leader_now":
      return cards[0]
        ? { type: "play_im_the_leader_now", actor, cardUid: cards[0] }
        : null;
    // The lobby actions are dealt by the harness itself (join / start), or are deliberately
    // never taken by the autopilot (`abandon_game` would end the run early). Listed rather than
    // left to the `default` so that a 40th ActionKind is a build failure here too.
    case "join_game":
    case "leave_game":
    case "choose_color":
    case "start_game":
    case "abandon_game":
    case "remove_player":
    case "transfer_host":
      return null;
    default:
      return null;
  }
}

/** The next action the autopilot would take, computed purely from `game` — never from a copy. */
function pickAction(game: Game, nowMs: number, strategy: Strategy): Action | null {
  const state = game.state();
  const options: { actor: PlayerId; legal: LegalAction; rank: number }[] = [];
  for (const player of state.players) {
    for (const legal of game.legalActions(player.id, nowMs)) {
      if (!strategy.playCards && TURN_CARD_PLAYS.includes(legal.kind)) continue;
      const rank = PRIORITY.indexOf(legal.kind);
      if (rank < 0) continue;
      options.push({ actor: player.id, legal, rank });
    }
  }
  options.sort((a, b) => a.rank - b.rank || a.actor.localeCompare(b.actor));
  for (const option of options) {
    const action = buildAction(game, option.actor, option.legal, strategy);
    if (action) return action;
  }
  return null;
}

/** Advance one step. Returns false when the game can no longer make progress. */
function step(game: Game, clock: Clock, strategy: Strategy): boolean {
  const probeMs = clock.ms;
  const action = pickAction(game, probeMs, strategy);
  if (action) {
    const out = game.dispatch(action, clock.next());
    return out.ok;
  }
  const ticked = game.tick(clock.next());
  return ticked.ok && ticked.value.changed;
}

type Moment = (game: Game) => boolean;

const SEEDS = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73];
const PLAYER_COUNTS = [4, 5, 3, 6];

/**
 * Drive deterministic games until `moment` holds, and hand back the LIVE game at that instant.
 * No snapshot is involved in getting here, so the tests are not circular.
 */
function reach(label: string, moment: Moment, strategy: Strategy = SPREAD): Rig {
  for (const players of PLAYER_COUNTS) {
    for (const seed of SEEDS) {
      const rig = newRig(seed, players);
      if (moment(rig.game)) return rig;
      for (let i = 0; i < 900; i += 1) {
        if (!step(rig.game, rig.clock, strategy)) break;
        if (moment(rig.game)) return rig;
      }
    }
  }
  throw new Error(`could not reach moment: ${label}`);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Key-sorted JSON. Two states are lossless-equal iff their canonical forms are identical.
 *
 * STRICT about `undefined`: a key present with an undefined value is NOT the same as a key
 * that the round trip dropped, because that is precisely how a field goes missing across a
 * save (audit #100/#101: "silently dropped Camp Raid markers and Inheritance links"). The
 * sentinel keeps such a key visible instead of letting `JSON.stringify` erase the difference.
 */
const UNDEFINED_SENTINEL = "\u0000undefined";
function canonicalize(value: unknown): unknown {
  if (value === undefined) return UNDEFINED_SENTINEL;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}
const canon = (value: unknown): string => JSON.stringify(canonicalize(value));

/** The real wire: a snapshot that never survives `JSON.stringify` has not round-tripped. */
function throughTheWire(snapshot: GameSnapshot): unknown {
  return JSON.parse(JSON.stringify(serializeSnapshot(snapshot))) as unknown;
}

function restoreThroughTheWire(game: Game): Game {
  const snapshot = game.snapshot();
  expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
  const parsed = parseSnapshot(throughTheWire(snapshot));
  if (!parsed.ok)
    throw new Error(`parseSnapshot rejected a live game: ${parsed.error.message}`);
  const restored = restoreGame(parsed.value);
  if (!restored.ok)
    throw new Error(`restoreGame rejected a live game: ${restored.error.message}`);
  return restored.value;
}

/** A restored game's first dispatch carries the `snapshot_restored` banner. Strip it. */
const stripBanner = (events: readonly GameEvent[]): readonly GameEvent[] =>
  events.filter((e) => e.type !== "snapshot_restored");

/**
 * Drive both games with ONE action script and ONE clock, comparing after every step.
 * Returns how many steps actually ran.
 */
function driveTogether(
  original: Game,
  copy: Game,
  clock: Clock,
  strategy: Strategy,
  maxSteps: number,
): number {
  let ran = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    const probeMs = clock.ms;
    // legalActions must agree BEFORE the action, or the renderer would offer different buttons.
    for (const player of original.state().players) {
      expect(canon(copy.legalActions(player.id, probeMs))).toBe(
        canon(original.legalActions(player.id, probeMs)),
      );
    }
    const action = pickAction(original, probeMs, strategy);
    const nowMs = clock.next();
    if (action) {
      const a = original.dispatch(action, nowMs);
      const b = copy.dispatch(action, nowMs);
      expect(b.ok).toBe(a.ok);
      if (a.ok && b.ok) {
        expect(canon(stripBanner(b.value.events))).toBe(canon(a.value.events));
        expect(b.value.changed).toBe(a.value.changed);
      } else if (!a.ok && !b.ok) {
        expect(b.error.code).toBe(a.error.code);
        break;
      }
    } else {
      const a = original.tick(nowMs);
      const b = copy.tick(nowMs);
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) {
        expect(canon(stripBanner(b.value.events))).toBe(canon(a.value.events));
        expect(b.value.changed).toBe(a.value.changed);
        if (!a.value.changed) {
          expect(canon(copy.state())).toBe(canon(original.state()));
          break;
        }
      }
    }
    ran += 1;
    expect(canon(copy.state())).toBe(canon(original.state()));
    expect(canon(copy.view())).toBe(canon(original.view()));
  }
  return ran;
}

/**
 * The whole property, applied at one moment: lossless restore, identity of every card,
 * identity of the RNG stream, and behavioural indistinguishability going forward.
 */
function assertRoundTripsAndContinuesIdentically(
  rig: Rig,
  strategy: Strategy = SPREAD,
  followSteps = 40,
): { copy: Game; steps: number } {
  const before = canon(rig.game.state());
  const copy = restoreThroughTheWire(rig.game);

  // Losslessness.
  expect(canon(copy.state())).toBe(before);
  // Taking a snapshot must not disturb the game it was taken from.
  expect(canon(rig.game.state())).toBe(before);

  // Card identity: same registry, same uids, same order, every uid in exactly one place.
  expect(copy.state().cards.map((c) => c.uid)).toEqual(
    rig.game.state().cards.map((c) => c.uid),
  );
  expect(canon(copy.state().cards)).toBe(canon(rig.game.state().cards));
  expect(censusOf(copy.state())).toEqual([]);
  for (const uid of copy.state().cards.map((c) => c.uid)) {
    expect(canon(copy.card(uid))).toBe(canon(rig.game.card(uid)));
  }

  // RNG position, not merely the seed: `s` and `calls` are what resumption needs.
  expect(copy.state().rng).toEqual(rig.game.state().rng);

  // The clock-driven surface a scheduler reads.
  expect(canon(copy.nextDeadline())).toBe(canon(rig.game.nextDeadline()));

  const steps = driveTogether(rig.game, copy, rig.clock, strategy, followSteps);
  // Guard against a vacuous pass: the comparison above only means anything if the two games
  // actually played on after the restore.
  if (followSteps > 0) expect(steps).toBeGreaterThan(0);
  return { copy, steps };
}

// ---------------------------------------------------------------------------
// The moments
// ---------------------------------------------------------------------------

const councilRaw = (g: Game): CouncilState | null => {
  const stage = g.state().stage;
  return stage.kind === "council" ? stage.council : null;
};

const openTakes = (g: Game): readonly Pending[] =>
  g.state().pending.filter((p) => p.kind === "take");

describe("snapshot round-trip: a restored game is indistinguishable from the original", () => {
  it("a game snapshotted the instant setup finishes restores with the identical deck order and hands", () => {
    const rig = newRig(20250909, 4);
    const state = rig.game.state();
    // Setup actually happened: 3 cards each, a Vote Card each, a stocked draw pile.
    expect(state.players).toHaveLength(4);
    for (const p of state.players) {
      expect(p.hand).toHaveLength(3);
      expect(p.voteCards).toHaveLength(1);
      expect(p.characterCards).toHaveLength(2);
    }
    expect(state.zones.drawPile.length).toBeGreaterThan(0);

    const copy = restoreThroughTheWire(rig.game);
    // The draw pile ORDER is the game: a reshuffle on restore would be a different game.
    expect(copy.state().zones.drawPile).toEqual(state.zones.drawPile);
    for (const [i, p] of copy.state().players.entries()) {
      expect(p.hand).toEqual(state.players[i]!.hand);
      expect(p.voteCards).toEqual(state.players[i]!.voteCards);
    }
    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a turn snapshotted between the mandatory steal and the optional play resumes at the play step", () => {
    const rig = reach("mid-turn at the play step", (g) => {
      const stage = g.state().stage;
      return (
        stage.kind === "turn" &&
        stage.turn.phase === "play" &&
        stage.turn.stealResolved &&
        g.state().pending.length === 0
      );
    });
    const stage = rig.game.state().stage;
    expect(stage.kind).toBe("turn");

    const copy = restoreThroughTheWire(rig.game);
    const restoredStage = copy.state().stage;
    if (restoredStage.kind !== "turn") throw new Error("stage kind lost");
    // docs/RULES.md footer: "Remember: Steal, Play (or don't), then Draw!" Which of the three
    // steps the turn is on is state, and it survives.
    expect(restoredStage.turn.phase).toBe("play");
    expect(restoredStage.turn.stealResolved).toBe(true);
    expect(restoredStage.turn.playerId).toBe(
      stage.kind === "turn" ? stage.turn.playerId : undefined,
    );
    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a take window still open for Sorry For You survives, and the block still blanks the taker", () => {
    const rig = reach("open take the victim can Sorry For You", (g) => {
      const takes = openTakes(g);
      if (takes.length === 0) return false;
      const take = takes[0]!;
      if (take.kind !== "take") return false;
      return g
        .legalActions(take.victimId, g.state().createdAtMs)
        .some((l) => l.kind === "play_sorry_for_you");
    });
    const take = openTakes(rig.game)[0]!;
    if (take.kind !== "take") throw new Error("not a take");

    const copy = restoreThroughTheWire(rig.game);
    const restoredTake = copy.state().pending.find((p) => p.id === take.id);
    expect(restoredTake).toBeDefined();
    if (!restoredTake || restoredTake.kind !== "take")
      throw new Error("take window lost");
    // Everything the reaction needs: who is owed cards, from whom, and how many.
    expect(restoredTake.takerIds).toEqual(take.takerIds);
    expect(restoredTake.victimId).toBe(take.victimId);
    expect(canon(restoredTake.spec)).toBe(canon(take.spec));
    expect(restoredTake.deadlineMs).toBe(take.deadlineMs);
    // The victim's right to react survives too.
    expect(
      copy
        .legalActions(take.victimId, rig.clock.ms)
        .some((l) => l.kind === "play_sorry_for_you"),
    ).toBe(true);

    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a Camp Raid armed on a player survives the round trip and still claims that player's draw", () => {
    const rig = reach(
      "camp raid armed",
      (g) => g.state().players.some((p) => p.campRaid !== null),
      SPREAD,
    );
    const armed = rig.game.state().players.find((p) => p.campRaid !== null)!;

    const copy = restoreThroughTheWire(rig.game);
    const restoredArmed = copy.state().players.find((p) => p.id === armed.id)!;
    // Audit #100/#101 named exactly this: the old restore silently dropped the marker.
    expect(restoredArmed.campRaid).not.toBeNull();
    expect(canon(restoredArmed.campRaid)).toBe(canon(armed.campRaid));
    expect(copy.view().players.find((p) => p.id === armed.id)!.campRaidBy).toBe(
      armed.campRaid!.raiderId,
    );

    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a Reward Challenge with only some submissions in survives without revealing or losing them", () => {
    const rig = reach("challenge with partial submissions", (g) =>
      g
        .state()
        .pending.some(
          (p) =>
            p.kind === "challenge" &&
            p.slots.some((s) => s.submission !== null) &&
            p.slots.some((s) => s.submission === null),
        ),
    );
    const challenge = rig.game
      .state()
      .pending.find(
        (p) => p.kind === "challenge" && p.slots.some((s) => s.submission !== null),
      )!;
    if (challenge.kind !== "challenge") throw new Error("not a challenge");

    const copy = restoreThroughTheWire(rig.game);
    const restored = copy.state().pending.find((p) => p.id === challenge.id);
    if (!restored || restored.kind !== "challenge")
      throw new Error("challenge window lost");
    // Simultaneity is the whole point of all three Reward Challenges: the submissions must
    // survive intact AND stay out of the public view.
    expect(canon(restored.slots)).toBe(canon(challenge.slots));
    expect(restored.challenge).toBe(challenge.challenge);
    expect(restored.round).toBe(challenge.round);
    const submitted = challenge.slots
      .filter((s) => s.submission !== null)
      .map((s) => s.playerId);
    const view = copy.view().openPending.find((p) => p.id === challenge.id)!;
    expect([...view.submittedPlayerIds].sort()).toEqual([...submitted].sort());
    expect(JSON.stringify(copy.view())).not.toContain('"submission"');

    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a council snapshotted in the Advantages phase restores with its Leader, drawer and card", () => {
    const rig = reach(
      "council in advantages",
      (g) => councilRaw(g)?.phase === "advantages",
    );
    const council = councilRaw(rig.game)!;

    const copy = restoreThroughTheWire(rig.game);
    const stage = copy.state().stage;
    if (stage.kind !== "council") throw new Error("council stage lost");
    // Audit #59: the old restore rebuilt half the council and nulled the other half.
    expect(stage.council.phase).toBe("advantages");
    expect(stage.council.leaderId).toBe(council.leaderId);
    expect(stage.council.drawerId).toBe(council.drawerId);
    expect(stage.council.cardUid).toBe(council.cardUid);
    expect(stage.council.kind).toBe(council.kind);
    // A council always interrupts somebody's turn, and that turn must still be there to resume.
    expect(canon(stage.turn)).toBe(
      canon(
        rig.game.state().stage.kind === "council"
          ? (rig.game.state().stage as { turn: unknown }).turn
          : null,
      ),
    );
    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("a council snapshotted mid-vote keeps every cast ballot secret and keeps the obligations to vote", () => {
    const rig = reach("voting with some but not all votes cast", (g) => {
      const c = councilRaw(g);
      if (!c || c.phase !== "voting") return false;
      return c.votes.length > 0 && c.votes.length < c.requiredCasts.length;
    });
    const council = councilRaw(rig.game)!;

    const copy = restoreThroughTheWire(rig.game);
    const stage = copy.state().stage;
    if (stage.kind !== "council") throw new Error("council stage lost");
    expect(stage.council.phase).toBe("voting");
    // docs/RULES.md: "Everyone must vote." / Vote Card: "you MUST place this card in one of the
    // slots in the Voting Box." The obligations are per CARD and must survive a save.
    expect(canon(stage.council.requiredCasts)).toBe(canon(council.requiredCasts));
    expect(canon(stage.council.votes)).toBe(canon(council.votes));
    expect(canon(stage.council.finishedVoting)).toBe(canon(council.finishedVoting));
    expect(copy.state().zones.votingBox).toEqual(rig.game.state().zones.votingBox);
    // The secret ballot is still secret after a restore: the box is not opened before `tally`.
    expect(copy.view().council!.revealedVotes).toBeNull();
    for (const vote of stage.council.votes) {
      const advantage = stage.council.advantagesPlayed.some(
        (a) => a.cardUid === vote.cardUid,
      );
      if (!advantage) expect(JSON.stringify(copy.view())).not.toContain(vote.cardUid);
    }
    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("an Immunity Idol played in the idol window survives, including whom it protects", () => {
    const rig = reach("idol window with an idol played", (g) => {
      const c = councilRaw(g);
      return c !== null && c.phase === "idols" && c.idolPlays.length > 0;
    });
    const council = councilRaw(rig.game)!;
    expect(council.idolPlays.length).toBeGreaterThan(0);

    const copy = restoreThroughTheWire(rig.game);
    const stage = copy.state().stage;
    if (stage.kind !== "council") throw new Error("council stage lost");
    expect(stage.council.phase).toBe("idols");
    // An idol may protect its player OR another player, so the protected id is not derivable
    // from who played it: losing it loses the rule.
    expect(canon(stage.council.idolPlays)).toBe(canon(council.idolPlays));
    for (const play of stage.council.idolPlays) {
      expect(typeof play.protects).toBe("string");
    }
    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("a tie awaiting the Leader's choice survives with the same tier, candidates and count", () => {
    const rig = reach("leader_decision pending open", (g) =>
      g.state().pending.some((p) => p.kind === "leader_decision"),
    );
    const decision = rig.game
      .state()
      .pending.find((p) => p.kind === "leader_decision")!;
    if (decision.kind !== "leader_decision") throw new Error("not a leader decision");

    const copy = restoreThroughTheWire(rig.game);
    const restored = copy.state().pending.find((p) => p.id === decision.id);
    if (!restored || restored.kind !== "leader_decision") {
      throw new Error("leader decision window lost");
    }
    // The tie-break ladder's current rung: descending a tier after a restore would let an
    // Immunity Idol holder be chosen while non-immune candidates still existed.
    expect(canon(restored)).toBe(canon(decision));
    expect(restored.candidates.length).toBeGreaterThan(0);
    expect(restored.choose).toBeGreaterThan(0);
    const offered = copy
      .legalActions(restored.leaderId, rig.clock.ms)
      .find((l) => l.kind === "leader_choose_eliminations");
    expect(offered).toBeDefined();
    expect(offered!.chooseCount).toBe(restored.choose);
    expect([...(offered!.legalTargets ?? [])].sort()).toEqual(
      [...restored.candidates].sort(),
    );

    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("a Final Tribal Council survives with its two finalists, its jury and its Leader", () => {
    const rig = reach(
      "final tribal council in progress",
      (g) => {
        const stage = g.state().stage;
        return (
          stage.kind === "final_council" && stage.finalCouncil.phase !== "complete"
        );
      },
      CONCENTRATE,
    );
    const stage = rig.game.state().stage;
    if (stage.kind !== "final_council") throw new Error("not a final council");
    const final = stage.finalCouncil;

    const copy = restoreThroughTheWire(rig.game);
    const restoredStage = copy.state().stage;
    if (restoredStage.kind !== "final_council")
      throw new Error("final council stage lost");
    const restored = restoredStage.finalCouncil;
    // docs/RULES.md, verbatim: "The player most recently eliminated is a member of the Jury AND
    // the Final Tribal Council Leader."
    expect(restored.leaderId).toBe(final.leaderId);
    expect(restored.jury).toContain(final.leaderId);
    expect(restored.finalists).toHaveLength(2);
    expect(restored.finalists).toEqual(final.finalists);
    expect(restored.jury).toEqual(final.jury);
    expect(restored.phase).toBe(final.phase);
    expect(canon(restored.juryVotes)).toBe(canon(final.juryVotes));
    expect(canon(restored.revealedHands)).toBe(canon(final.revealedHands));

    assertRoundTripsAndContinuesIdentically(rig, CONCENTRATE, 60);
  });

  it("a jury vote cast but not yet revealed survives the round trip still hidden", () => {
    const rig = reach(
      "final council with a partial jury vote",
      (g) => {
        const stage = g.state().stage;
        if (stage.kind !== "final_council") return false;
        const f = stage.finalCouncil;
        return (
          f.phase === "jury_vote" &&
          f.juryVotes.length > 0 &&
          f.juryVotes.length < f.jury.length
        );
      },
      CONCENTRATE,
    );
    const stage = rig.game.state().stage;
    if (stage.kind !== "final_council") throw new Error("not a final council");

    const copy = restoreThroughTheWire(rig.game);
    const restoredStage = copy.state().stage;
    if (restoredStage.kind !== "final_council")
      throw new Error("final council stage lost");
    expect(canon(restoredStage.finalCouncil.juryVotes)).toBe(
      canon(stage.finalCouncil.juryVotes),
    );
    // The jury vote is a simultaneous public reveal, so a partial tally is not public — before
    // or after a restart.
    expect(copy.view().finalCouncil!.juryVotes).toBeNull();
    expect(copy.view().finalCouncil!.castCount).toBe(
      stage.finalCouncil.juryVotes.length,
    );

    assertRoundTripsAndContinuesIdentically(rig, CONCENTRATE, 40);
  });

  it("a finished game restores as finished, keeps its winner, and refuses to be played on", () => {
    const rig = reach(
      "finished game",
      (g) => g.state().stage.kind === "finished",
      CONCENTRATE,
    );
    const stage = rig.game.state().stage;
    if (stage.kind !== "finished") throw new Error("not finished");
    expect(stage.winnerId).not.toBeNull();

    const copy = restoreThroughTheWire(rig.game);
    const restoredStage = copy.state().stage;
    if (restoredStage.kind !== "finished") throw new Error("finished stage lost");
    // Audit #36: `status:'finished'` with a live council stage was a real state in the old code.
    expect(restoredStage.winnerId).toBe(stage.winnerId);
    expect(restoredStage.finishedAtMs).toBe(stage.finishedAtMs);
    expect(copy.view().status).toBe("finished");
    expect(canon(copy.state())).toBe(canon(rig.game.state()));

    // A finished game is over on both sides of the round trip.
    for (const player of copy.state().players) {
      expect(copy.legalActions(player.id, rig.clock.ms)).toEqual([]);
    }
    const after = copy.dispatch(
      { type: "draw_card", actor: idOf(0) },
      rig.clock.next(),
    );
    expect(after.ok).toBe(false);
    const originalAfter = rig.game.dispatch(
      { type: "draw_card", actor: idOf(0) },
      rig.clock.ms,
    );
    expect(originalAfter.ok).toBe(false);
    if (!after.ok && !originalAfter.ok) {
      expect(after.error.code).toBe(originalAfter.error.code);
    }
  });

  it("the once-per-turn card play survives: a restored player still cannot play a second card", () => {
    const rig = reach("a card already played this turn", (g) => {
      const stage = g.state().stage;
      return (
        stage.kind === "turn" &&
        stage.turn.cardPlayedThisTurn !== null &&
        stage.turn.phase !== "ended" &&
        g.state().pending.length === 0
      );
    });
    const stage = rig.game.state().stage;
    if (stage.kind !== "turn") throw new Error("not a turn");
    const actor = stage.turn.playerId;
    const played = stage.turn.cardPlayedThisTurn;

    const copy = restoreThroughTheWire(rig.game);
    const restoredStage = copy.state().stage;
    if (restoredStage.kind !== "turn") throw new Error("turn stage lost");
    // docs/RULES.md step 2: "You don't have to play a card, but you can't play more than one."
    // That you already played one is state, and losing it across a save hands the player a
    // second card play for free.
    expect(restoredStage.turn.cardPlayedThisTurn).toBe(played);
    const stillOffered = copy
      .legalActions(actor, rig.clock.ms)
      .filter((l) => TURN_CARD_PLAYS.includes(l.kind));
    expect(stillOffered).toEqual([]);

    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("an open Inheritance window survives with the eliminated player's hand intact", () => {
    const rig = reach(
      "inheritance window open",
      (g) => g.state().pending.some((p) => p.kind === "inheritance"),
      SPREAD,
    );
    const window = rig.game.state().pending.find((p) => p.kind === "inheritance")!;
    if (window.kind !== "inheritance") throw new Error("not an inheritance window");
    expect(window.hand.length).toBeGreaterThan(0);

    const copy = restoreThroughTheWire(rig.game);
    const restored = copy.state().pending.find((p) => p.id === window.id);
    if (!restored || restored.kind !== "inheritance") {
      throw new Error("inheritance window lost");
    }
    // Inheritance, verbatim in docs/RULES.md: "When that player is eliminated from the game
    // ... you can IMMEDIATELY play this card. You get all of the cards in their hand instead of
    // their cards going in the Discard Pile." Audit #100: the old snapshot linked Inheritance to
    // a Player OBJECT and lost the link on restore.
    expect(restored.eliminatedPlayerId).toBe(window.eliminatedPlayerId);
    expect(restored.color).toBe(window.color);
    expect(restored.hand).toEqual(window.hand);
    expect(restored.claimedBy).toBe(window.claimedBy);
    // A full hand is private and must not ride out on the public view.
    for (const uid of restored.hand) {
      expect(JSON.stringify(copy.view())).not.toContain(uid);
    }

    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("a discard owed for Sorry For You survives with the same debt against the same player", () => {
    const rig = reach("discard window open", (g) =>
      g.state().pending.some((p) => p.kind === "discard"),
    );
    const window = rig.game.state().pending.find((p) => p.kind === "discard")!;
    if (window.kind !== "discard") throw new Error("not a discard window");

    const copy = restoreThroughTheWire(rig.game);
    const restored = copy.state().pending.find((p) => p.id === window.id);
    if (!restored || restored.kind !== "discard")
      throw new Error("discard window lost");
    // Sorry For You, verbatim in docs/RULES.md: "Instead, they get nothing from you and must
    // discard 1 card (regardless of how many cards you owe them)." The debt is exactly 1, it is
    // owed by the taker, and both facts must cross a save.
    expect(restored.playerId).toBe(window.playerId);
    expect(restored.count).toBe(window.count);
    if (window.reason === "sorry_for_you_penalty") expect(restored.count).toBe(1);
    expect(restored.reason).toBe(window.reason);
    expect(restored.chosen).toEqual(window.chosen);

    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a Spy Shack reveal survives, so the spy can still see the hand they were shown", () => {
    const rig = reach("a recorded reveal", (g) => g.state().reveals.length > 0);
    const reveal = rig.game.state().reveals[0]!;

    const copy = restoreThroughTheWire(rig.game);
    // Audit #27/#59/#101: "state that silently evaporates across save/load". The reveal is
    // recorded in state precisely so it does not live in a renderer's message history.
    expect(canon(copy.state().reveals)).toBe(canon(rig.game.state().reveals));
    const mine = copy.privateView(reveal.viewerId)!;
    const theirs = rig.game.privateView(reveal.viewerId)!;
    expect(canon(mine.revealedToMe)).toBe(canon(theirs.revealedToMe));
    expect(mine.revealedToMe.length).toBeGreaterThan(0);
    // And a reveal to one player is not a reveal to the table.
    expect(JSON.stringify(copy.view())).not.toContain(reveal.cardUids[0]!);

    assertRoundTripsAndContinuesIdentically(rig);
  });

  it("a Goodwill Gamble vote granted to another player survives as that player's card", () => {
    const rig = reach("a granted vote", (g) =>
      g.state().players.some((p) => p.grantedVotes.length > 0),
    );
    const holder = rig.game.state().players.find((p) => p.grantedVotes.length > 0)!;

    const copy = restoreThroughTheWire(rig.game);
    const restored = copy.state().players.find((p) => p.id === holder.id)!;
    expect(restored.grantedVotes).toEqual(holder.grantedVotes);
    // Giving a vote away is a public act, so the count is public on both sides of the save.
    expect(copy.view().players.find((p) => p.id === holder.id)!.grantedVoteCount).toBe(
      holder.grantedVotes.length,
    );
    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("a council part-way through a Double Elimination survives with its remaining count", () => {
    const rig = reach("double elimination mid-resolution", (g) => {
      const c = councilRaw(g);
      return c !== null && c.kind === "double" && c.flippedThisCouncil.length > 0;
    });
    const council = councilRaw(rig.game)!;

    const copy = restoreThroughTheWire(rig.game);
    const stage = copy.state().stage;
    if (stage.kind !== "council") throw new Error("council stage lost");
    // Double Elimination: how many eliminations are still owed, and who has already gone this
    // council, are the two facts a resumed double elimination runs on.
    expect(stage.council.eliminationsRemaining).toBe(council.eliminationsRemaining);
    expect(stage.council.flippedThisCouncil).toEqual(council.flippedThisCouncil);
    expect(canon(stage.council.tally)).toBe(canon(council.tally));
    assertRoundTripsAndContinuesIdentically(rig, SPREAD, 60);
  });

  it("a lobby snapshotted before setup restores and deals the identical deck when started", () => {
    const clock = new Clock();
    const game = createGame({
      gameId: asGameId("lobby-rt"),
      hostId: idOf(0),
      config: DEFAULT_CONFIG.engine,
      nowMs: clock.next(),
      seed: 424242,
    });
    for (let i = 0; i < 4; i += 1) {
      const out = game.dispatch(
        { type: "join_game", actor: idOf(i), displayName: NAMES[i]! },
        clock.next(),
      );
      expect(out.ok).toBe(true);
    }
    expect(game.state().stage.kind).toBe("lobby");
    const copy = restoreThroughTheWire(game);
    expect(canon(copy.state())).toBe(canon(game.state()));

    // The deck is dealt from the RNG at `start_game`; the restored lobby must deal the same one.
    const nowMs = clock.next();
    const a = game.dispatch(
      { type: "start_game", actor: idOf(0), firstPlayer: idOf(0) },
      nowMs,
    );
    const b = copy.dispatch(
      { type: "start_game", actor: idOf(0), firstPlayer: idOf(0) },
      nowMs,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canon(stripBanner(b.value.events))).toBe(canon(a.value.events));
    expect(copy.state().zones.drawPile).toEqual(game.state().zones.drawPile);
    expect(canon(copy.state())).toBe(canon(game.state()));
  });

  it("an abandoned game restores as abandoned and stays refused", () => {
    const rig = newRig(101, 4);
    const abandoned = rig.game.dispatch(
      { type: "abandon_game", actor: idOf(0) },
      rig.clock.next(),
    );
    expect(abandoned.ok).toBe(true);
    expect(rig.game.state().stage.kind).toBe("abandoned");

    const copy = restoreThroughTheWire(rig.game);
    const stage = copy.state().stage;
    if (stage.kind !== "abandoned") throw new Error("abandoned stage lost");
    expect(stage.abandonedById).toBe(idOf(0));
    const after = copy.dispatch(
      { type: "draw_card", actor: idOf(0) },
      rig.clock.next(),
    );
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("game_abandoned");
  });

  it("deadlines are absolute, so a game restored an hour later expires the same windows", () => {
    const rig = reach("open take", (g) => openTakes(g).length > 0);
    const copy = restoreThroughTheWire(rig.game);
    const later = rig.clock.ms + 60 * 60 * 1000;
    rig.clock.ms = later;
    const a = rig.game.tick(later);
    const b = copy.tick(later);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.changed).toBe(true);
    expect(canon(stripBanner(b.value.events))).toBe(canon(a.value.events));
    expect(canon(copy.state())).toBe(canon(rig.game.state()));
  });
});

describe("snapshot round-trip: card identity and the RNG stream", () => {
  it("every card uid survives the round trip in exactly one place", () => {
    const rig = reach(
      "mid-game with a discard pile",
      (g) => g.state().zones.discardPile.length > 4,
    );
    const before = rig.game.state();
    const copy = restoreThroughTheWire(rig.game);
    const after = copy.state();

    expect(after.cards.length).toBe(before.cards.length);
    const locate = (state: GameState): Map<string, string> => {
      const where = new Map<string, string>();
      for (const [zone, uids] of Object.entries(state.zones)) {
        for (const uid of uids as readonly CardUid[]) where.set(uid, zone);
      }
      for (const p of state.players) {
        for (const uid of p.hand) where.set(uid, `hand:${p.id}`);
        for (const uid of p.voteCards) where.set(uid, `vote:${p.id}`);
        for (const uid of p.grantedVotes) where.set(uid, `granted:${p.id}`);
        for (const c of p.characterCards) where.set(c.uid, `character:${p.id}`);
      }
      return where;
    };
    const beforeWhere = locate(before);
    const afterWhere = locate(after);
    expect(afterWhere.size).toBe(beforeWhere.size);
    for (const [uid, place] of beforeWhere) expect(afterWhere.get(uid)).toBe(place);
    expect(censusOf(after)).toEqual([]);
  });

  it("the RNG stream position survives, so the next random steal takes the same card", () => {
    const rig = reach("about to make the mandatory steal", (g) => {
      const stage = g.state().stage;
      return (
        stage.kind === "turn" &&
        stage.turn.phase === "steal" &&
        !stage.turn.stealResolved &&
        g.state().pending.length === 0 &&
        g.state().zones.discardPile.length > 2
      );
    });
    const stage = rig.game.state().stage;
    if (stage.kind !== "turn") throw new Error("not a turn");
    const actor = stage.turn.playerId;
    const victim = rig.game
      .legalActions(actor, rig.clock.ms)
      .find((l) => l.kind === "steal_random")!.legalTargets![0]!;

    const copy = restoreThroughTheWire(rig.game);
    // `seed` alone is not resumption state; `s` and `calls` are.
    expect(copy.state().rng.s).toBe(rig.game.state().rng.s);
    expect(copy.state().rng.calls).toBe(rig.game.state().rng.calls);

    const nowMs = rig.clock.next();
    const a = rig.game.dispatch({ type: "steal_random", actor, target: victim }, nowMs);
    const b = copy.dispatch({ type: "steal_random", actor, target: victim }, nowMs);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Resolve the reaction window the same way on both, which is where the shuffle happens.
    const pendingId = rig.game.state().pending.find((p) => p.kind === "take")!.id;
    const takeVictim = rig.game.state().pending.find((p) => p.kind === "take")!;
    if (takeVictim.kind !== "take") throw new Error("not a take");
    const declineMs = rig.clock.next();
    const ra = rig.game.dispatch(
      { type: "decline_reaction", actor: takeVictim.victimId, pendingId },
      declineMs,
    );
    const rb = copy.dispatch(
      { type: "decline_reaction", actor: takeVictim.victimId, pendingId },
      declineMs,
    );
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    const takenA = ra.value.events.filter((e) => e.type === "take_resolved");
    expect(takenA.length).toBeGreaterThan(0);
    // The identity of the randomly-stolen card is drawn from the RNG. Same stream, same card.
    expect(canon(stripBanner(rb.value.events))).toBe(canon(ra.value.events));
    expect(canon(copy.state())).toBe(canon(rig.game.state()));
  });

  it("a snapshot restored twice from the same bytes produces two identical games", () => {
    const rig = reach(
      "council in advantages",
      (g) => councilRaw(g)?.phase === "advantages",
    );
    const wire = throughTheWire(rig.game.snapshot());
    const first = parseSnapshot(wire);
    const second = parseSnapshot(JSON.parse(JSON.stringify(wire)) as unknown);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const a = restoreGame(first.value);
    const b = restoreGame(second.value);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canon(b.value.state())).toBe(canon(a.value.state()));
    // And they do not share mutable structure: driving one must not move the other.
    const drivenMs = rig.clock.next();
    a.value.tick(drivenMs + 10_000_000);
    expect(canon(b.value.state())).toBe(canon(first.value.state));
  });

  it("the config the game was STARTED under is what comes back, not the ambient default", () => {
    const rig = reach("mid-game", (g) => g.state().zones.discardPile.length > 2);
    const snapshot = rig.game.snapshot();
    const copy = restoreThroughTheWire(rig.game);
    expect(canon(copy.config)).toBe(canon(snapshot.state.config));
    expect(canon(copy.state().config)).toBe(canon(rig.game.state().config));
  });
});

describe("snapshot schema version", () => {
  it("a snapshot carries the engine's schema version, and it survives serialization", () => {
    const rig = newRig(3, 4);
    const snapshot = rig.game.snapshot();
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    const wire = throughTheWire(snapshot) as Record<string, unknown>;
    expect(wire.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(typeof wire.savedAtMs).toBe("number");
    expect(wire.state).toBeDefined();
  });

  it("restoring announces the schema version it restored from", () => {
    const rig = reach("mid-game", (g) => g.state().zones.discardPile.length > 2);
    const copy = restoreThroughTheWire(rig.game);
    // The banner rides on the next dispatch; a tick is the cheapest way to collect it.
    const out = copy.tick(rig.clock.next());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const banner = out.value.events.find((e) => e.type === "snapshot_restored");
    expect(banner).toBeDefined();
    expect((banner as { schemaVersion: number }).schemaVersion).toBe(
      SNAPSHOT_SCHEMA_VERSION,
    );
  });

  it("a snapshot from a newer or older schema is refused, not guessed at", () => {
    const rig = newRig(4, 4);
    const wire = throughTheWire(rig.game.snapshot()) as Record<string, unknown>;
    for (const version of [0, SNAPSHOT_SCHEMA_VERSION + 1, 99]) {
      const parsed = parseSnapshot({ ...wire, schemaVersion: version });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.code).toBe("snapshot_version_unsupported");
      expect(parsed.error.details?.found).toBe(version);
    }
  });
});

describe("snapshot rejection: a bad file is reported as a bad file, never loaded", () => {
  let wire: Record<string, unknown>;
  let rig: Rig;

  beforeAll(() => {
    rig = reach("council in advantages", (g) => councilRaw(g)?.phase === "advantages");
    wire = throughTheWire(rig.game.snapshot()) as Record<string, unknown>;
  });

  const mutate = (path: string[], value: unknown): unknown => {
    const clone = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    let node: Record<string, unknown> = clone;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
    const last = path[path.length - 1]!;
    if (value === undefined) delete node[last];
    else node[last] = value;
    return clone;
  };

  it("a non-object, a string and an array are all refused as malformed", () => {
    for (const raw of [null, undefined, 7, "a save file", [], true]) {
      const parsed = parseSnapshot(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
    }
  });

  it("a save file from a foreign format is refused rather than half-loaded", () => {
    // Shaped like the OLD save this rewrite replaces: no schema version, its own field names.
    const foreign = {
      version: "1.0",
      players: [{ name: "Ari", cards: ["camp_raid"], lives: 2 }],
      deck: ["sorry_for_you"],
      tribalCouncilState: "voting",
    };
    const parsed = parseSnapshot(foreign);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
  });

  it("a missing envelope field is refused", () => {
    for (const field of ["schemaVersion", "savedAtMs", "state"]) {
      const parsed = parseSnapshot(mutate([field], undefined));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
    }
  });

  it("a missing or corrupted RNG position is refused, because the game could not be resumed", () => {
    for (const rng of [
      undefined,
      {},
      { seed: 1 },
      { seed: 1, s: "x", calls: 0 },
      null,
    ]) {
      const parsed = parseSnapshot(mutate(["state", "rng"], rng));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
    }
  });

  it("an unknown stage kind is refused rather than treated as a lobby", () => {
    const parsed = parseSnapshot(
      mutate(["state", "stage"], { kind: "tribal_council" }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
  });

  it("a council stage with no council payload is refused — audit #59's wedged game", () => {
    const parsed = parseSnapshot(
      mutate(["state", "stage"], {
        kind: "council",
        turn: {
          playerId: "u-ari",
          phase: "draw",
          stealResolved: true,
          cardPlayedThisTurn: null,
          startedAtMs: 1,
          deadlineMs: null,
          turnNumber: 1,
        },
        council: null,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
  });

  it("a council phase outside the state machine is refused", () => {
    const parsed = parseSnapshot(
      mutate(["state", "stage", "council", "phase"], "deliberating"),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
  });

  it("a Final Tribal Council with other than exactly two finalists is refused", () => {
    const base = {
      kind: "final_council",
      finalCouncil: {
        phase: "jury_vote",
        leaderId: "u-cyd",
        finalists: ["u-ari", "u-bex"],
        jury: ["u-cyd"],
        juryVotes: [],
        readyJurors: [],
        revealedHands: [],
        winnerId: null,
        winnerDecidedByLeaderTieBreak: false,
        phaseDeadlineMs: null,
      },
    };
    for (const finalists of [[], ["u-ari"], ["u-ari", "u-bex", "u-cyd"]]) {
      const stage = { ...base, finalCouncil: { ...base.finalCouncil, finalists } };
      const parsed = parseSnapshot(mutate(["state", "stage"], stage));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
    }
  });

  it("a pending window saved in a terminal status is refused — the pruning invariant is a rule", () => {
    const rigWithPending = reach("open take", (g) => openTakes(g).length > 0);
    const raw = throughTheWire(rigWithPending.game.snapshot()) as Record<
      string,
      unknown
    >;
    const state = raw.state as Record<string, unknown>;
    const pendings = (state.pending as Record<string, unknown>[]).map((p) => ({
      ...p,
      status: "resolved",
    }));
    const parsed = parseSnapshot({ ...raw, state: { ...state, pending: pendings } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");
  });

  it("a card that vanished from a hand is refused as a census mismatch", () => {
    const clone = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const state = clone.state as Record<string, unknown>;
    const players = state.players as Record<string, unknown>[];
    // Whoever is actually holding cards: which seat that is depends on how the fixture played
    // out, and pinning it to seat 0 made this test a hostage to the driver's card choices.
    const hand = players
      .map((p) => p.hand as string[])
      .find((cards) => cards.length > 0);
    expect(hand, "the fixture must leave somebody holding a card").toBeDefined();
    if (!hand) throw new Error("fixture");
    hand.pop();
    const parsed = parseSnapshot(clone);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_card_census_mismatch");
  });

  it("the same card in two hands at once is refused as a census mismatch", () => {
    const clone = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const state = clone.state as Record<string, unknown>;
    const players = state.players as Record<string, unknown>[];
    const hands = players.map((p) => p.hand as string[]);
    const donor = hands.find((cards) => cards.length > 0);
    const thief = hands.find((cards) => cards !== donor);
    expect(donor, "the fixture must leave somebody holding a card").toBeDefined();
    if (!donor || !thief) throw new Error("fixture");
    thief.push(donor[0]!);
    const parsed = parseSnapshot(clone);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_card_census_mismatch");
  });

  it("a card uid the registry never minted is refused as a census mismatch", () => {
    const clone = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const state = clone.state as Record<string, unknown>;
    const players = state.players as Record<string, unknown>[];
    (players[0]!.hand as string[]).push("c999:forged_immunity_idol");
    const parsed = parseSnapshot(clone);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_card_census_mismatch");
  });

  it("restoreGame refuses an unbalanced state even if a caller skipped parseSnapshot", () => {
    const snapshot = rig.game.snapshot();
    const robbed = snapshot.state.players.find((p) => p.hand.length > 0);
    expect(robbed, "the fixture must leave somebody holding a card").toBeDefined();
    const broken: GameSnapshot = {
      ...snapshot,
      state: {
        ...snapshot.state,
        players: snapshot.state.players.map((p) =>
          p.id === robbed?.id ? { ...p, hand: p.hand.slice(1) } : p,
        ),
      },
    };
    const restored = restoreGame(broken);
    expect(restored.ok).toBe(false);
    if (!restored.ok) expect(restored.error.code).toBe("snapshot_card_census_mismatch");
  });

  it("a rejected snapshot leaves the running game untouched and still playable", () => {
    const live = reach("mid-turn at the play step", (g) => {
      const stage = g.state().stage;
      return (
        stage.kind === "turn" &&
        stage.turn.phase === "play" &&
        g.state().pending.length === 0
      );
    });
    const before = canon(live.game.state());
    for (const bad of [
      null,
      {},
      { schemaVersion: 42 },
      mutate(["state", "rng"], null),
    ]) {
      expect(parseSnapshot(bad).ok).toBe(false);
    }
    expect(canon(live.game.state())).toBe(before);
    const ran = driveTogether(
      live.game,
      restoreThroughTheWire(live.game),
      live.clock,
      SPREAD,
      10,
    );
    expect(ran).toBeGreaterThan(0);
  });

  it("a config with no pending-window timings is refused: a resumed game could never expire", () => {
    const clone = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const state = clone.state as Record<string, unknown>;
    const config = state.config as Record<string, unknown>;
    delete (config.timings as Record<string, unknown>).pendingWindows;
    const parsed = parseSnapshot(clone);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("snapshot_malformed");

    for (const section of ["limits", "deck", "timings", "houseRules"]) {
      const missing = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
      const s = missing.state as Record<string, unknown>;
      delete (s.config as Record<string, unknown>)[section];
      const out = parseSnapshot(missing);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error.code).toBe("snapshot_malformed");
    }
  });

  it("parseSnapshot is total: no corruption of a real save makes it throw", () => {
    // Every key path in a real snapshot, deleted and type-swapped seven ways. The contract is
    // that a bad file comes back as a bad file — "reported as a bad file rather than as an
    // internal invariant break, which the old code logged as a crash" (snapshot.ts header).
    const paths: string[][] = [];
    const walk = (value: unknown, at: string[]): void => {
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) {
          paths.push([...at, key]);
          walk((value as Record<string, unknown>)[key], [...at, key]);
        }
      }
    };
    walk(wire, []);
    expect(paths.length).toBeGreaterThan(100);

    const mutations: readonly unknown[] = [undefined, null, "x", -1, [], {}, true];
    let accepted = 0;
    let refused = 0;
    for (const path of paths) {
      for (const value of mutations) {
        const clone = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
        let node = clone;
        for (const key of path.slice(0, -1))
          node = node[key] as Record<string, unknown>;
        const last = path[path.length - 1]!;
        if (value === undefined) delete node[last];
        else node[last] = value;

        const parsed = parseSnapshot(clone);
        if (!parsed.ok) {
          refused += 1;
          // Always one of the three documented codes, never a leaked internal error.
          expect([
            "snapshot_malformed",
            "snapshot_version_unsupported",
            "snapshot_card_census_mismatch",
          ]).toContain(parsed.error.code);
          expect(typeof parsed.error.message).toBe("string");
          continue;
        }
        accepted += 1;
        // Anything that got past the gate must still be a usable game, not a crash later on.
        const restored = restoreGame(parsed.value);
        if (!restored.ok) continue;
        restored.value.view();
        for (const player of restored.value.state().players) {
          restored.value.privateView(player.id);
          restored.value.legalActions(player.id, rig.clock.ms);
        }
      }
    }
    expect(refused).toBeGreaterThan(accepted);
  });
});

describe("snapshot round-trip: stability", () => {
  it("re-snapshotting a restored game reproduces the identical bytes", () => {
    const rig = reach("mid-council", (g) => councilRaw(g)?.phase === "voting");
    const first = serializeSnapshot(rig.game.snapshot());
    const copy = restoreThroughTheWire(rig.game);
    const second = serializeSnapshot(copy.snapshot());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("game state is plain JSON at every stage, so a round trip cannot need a fixup pass", () => {
    const moments: { label: string; game: Game }[] = [
      { label: "lobby", game: newRig(5, 4).game },
      {
        label: "turn",
        game: reach("mid-turn", (g) => g.state().stage.kind === "turn").game,
      },
      {
        label: "council",
        game: reach("council", (g) => councilRaw(g) !== null).game,
      },
      {
        label: "final council",
        game: reach(
          "final council",
          (g) => g.state().stage.kind === "final_council",
          CONCENTRATE,
        ).game,
      },
      {
        label: "finished",
        game: reach("finished", (g) => g.state().stage.kind === "finished", CONCENTRATE)
          .game,
      },
    ];
    const assertPlainJson = (value: unknown, at: string): void => {
      if (value === null) return;
      const kind = typeof value;
      if (kind === "string" || kind === "boolean") return;
      if (kind === "number") {
        expect(Number.isFinite(value as number), `${at} is not a finite number`).toBe(
          true,
        );
        return;
      }
      // "no Map, no Set, no class instance and no object reference that has to be re-linked"
      // is what makes a round trip a deep copy. A Date or a class instance here would survive
      // `JSON.stringify` as something else entirely and come back wrong.
      expect(kind, `${at} is ${kind}`).toBe("object");
      const proto: unknown = Object.getPrototypeOf(value);
      expect(
        Array.isArray(value) ? proto === Array.prototype : proto === Object.prototype,
        `${at} is not a plain object or array`,
      ).toBe(true);
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertPlainJson(v, `${at}[${i}]`));
        return;
      }
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        expect(v, `${at}.${key} is undefined`).not.toBe(undefined);
        assertPlainJson(v, `${at}.${key}`);
      }
    };
    for (const { label, game } of moments)
      assertPlainJson(game.state(), `${label}:state`);
    expect(moments).toHaveLength(5);
  });

  it("restoring a restored game is still the same game", () => {
    const rig = reach("mid-council", (g) => councilRaw(g)?.phase === "voting");
    const once = restoreThroughTheWire(rig.game);
    const twice = restoreThroughTheWire(once);
    const thrice = restoreThroughTheWire(twice);
    expect(canon(thrice.state())).toBe(canon(rig.game.state()));
    // And it still plays identically to the original after three trips through the disk.
    driveTogether(rig.game, thrice, rig.clock, SPREAD, 30);
  });

  it("createSnapshot stamps the current schema version onto any state handed to it", () => {
    const quiet = reach(
      "mid-game",
      (g) => g.state().zones.discardPile.length > 2,
      QUIET,
    );
    const snapshot = createSnapshot(quiet.game.state(), 1_234_567);
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.savedAtMs).toBe(1_234_567);
    const parsed = parseSnapshot(throughTheWire(snapshot));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.savedAtMs).toBe(1_234_567);
    expect(canon(parsed.value.state)).toBe(canon(quiet.game.state()));
  });
});
