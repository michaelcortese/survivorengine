/**
 * GLOBAL INVARIANTS & FUZZING
 *
 * This file drives large numbers of random-but-legal games to completion and asserts, after
 * EVERY dispatch and EVERY tick, the properties that must hold in every reachable state of the
 * engine. Nothing here is a happy-path scenario test; every assertion is a universally
 * quantified statement about the state machine.
 *
 * The rules being enforced, quoted from docs/RULES.md:
 *
 *  - CARD CONSERVATION. "Gather all 67 Action Cards..." plus the 12 Survivor Character Cards
 *    and the hidden 68th. "Put away any unused Tribal Council Cards - you won't need them"
 *    and "Give each player 1 Vote Card, and put the extras away" mean the unused cards are
 *    still accounted for (they are physically in the box), so the total is fixed for the whole
 *    game. And: "There is no reshuffle rule. The Draw Pile is never rebuilt from the Discard
 *    Pile." (docs/RULES.md:80) - the deck only ever shrinks; cards are never created.
 *
 *  - ONE CARD, ONE PLACE. A physical card is in exactly one location. The contract states it
 *    as the CARD CENSUS invariant on `Zones`; this file re-derives it independently of
 *    `censusOf` so a bug in the census helper cannot hide a bug in the engine.
 *
 *  - LIVENESS OF THE TURN HOLDER. "As long as you have at least one Survivor Character Card,
 *    you're still in the game. When both your Survivor Character Cards are gone, you're out"
 *    (docs/RULES.md:23) and "After Tribal, continue play with the player on your left"
 *    (docs/RULES.md:128) - turn order runs over players still in the game, so an eliminated or
 *    departed player can never hold the turn.
 *
 *  - COUNCIL PHASE ORDER. The rulebook prints a four-phase Leader script (docs/RULES.md:88-108)
 *    that runs strictly forward: Tribal Advantages -> Discussion -> Vote -> Idol window ->
 *    (Nullifier) -> Tally -> tie-break -> cleanup. A council never goes backwards and never
 *    skips the vote.
 *
 *  - REJECTION IS PURE. An illegal attempt is not a move: it changes nothing about the
 *    physical table.
 *
 *  - TERMINATION. "The moment there are only 2 players left in the game... it's time to
 *    IMMEDIATELY start the Final Tribal Council to determine the winner of the game"
 *    (docs/RULES.md:133), and one Tribal Council card is always the literal bottom card of the
 *    Draw Pile, so every game must end. No game may hang, deadlock, or sit in a state from
 *    which nothing at all is legal.
 *
 * Everything is deterministic: the harness has its own seeded PRNG and never calls
 * `Math.random()`, `Date.now()` or any wall clock.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type EngineConfig } from "../src/config.js";
import {
  CARD_CATALOG,
  CHARACTER_CARDS_IN_BOX,
  deckCompositionFor,
} from "../src/engine/cards.js";
import type { GameEvent } from "../src/engine/events.js";
import { censusOf, createGame } from "../src/engine/game.js";
import {
  COUNCIL_PHASE_ORDER,
  FINAL_COUNCIL_PHASE_ORDER,
  CardKind,
  asGameId,
  asCardUid,
  asPendingId,
  asPlayerId,
  councilOf,
  finalCouncilOf,
  isInPlay,
  statusOf,
  turnOf,
  type Action,
  type ActionKind,
  type CardUid,
  type CouncilPhase,
  type FingerCount,
  type FinalCouncilPhase,
  type Game,
  type GameState,
  type LegalAction,
  type PlayerCount,
  type PlayerId,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Deterministic harness PRNG (never the engine's)
// ---------------------------------------------------------------------------

/** mulberry32. Separate stream from the engine so the fuzzer's choices are independent. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eze", "Fen"] as const;
const idFor = (i: number): PlayerId => asPlayerId(`u-${NAMES[i]!.toLowerCase()}`);

const ENGINE: EngineConfig = DEFAULT_CONFIG.engine;

/**
 * Every card in the box, whether or not this player count uses it: 12 Survivor Character
 * Cards + 6 Vote Cards + 9 Tribal Council Cards + the 52 shuffled Action Cards + the hidden
 * Idol Nullifier. Fixed for the whole game - the census must equal this from `start_game`
 * until the last event.
 */
function expectedRegistryTotal(playerCount: PlayerCount, config: EngineConfig): number {
  return (
    CHARACTER_CARDS_IN_BOX +
    CARD_CATALOG[CardKind.Vote].quantityInBox +
    CARD_CATALOG[CardKind.TribalCouncilSingle].quantityInBox +
    CARD_CATALOG[CardKind.TribalCouncilDouble].quantityInBox +
    deckCompositionFor(playerCount, config).shuffledTotal
  );
}

// ---------------------------------------------------------------------------
// Independent card-location audit (does not trust `censusOf`)
// ---------------------------------------------------------------------------

const ZONE_KEYS = [
  "drawPile",
  "discardPile",
  "removedFromGame",
  "voteCardBank",
  "votingBox",
  "inPlay",
] as const;

interface LocationAudit {
  /** uid -> every place it was found. */
  readonly places: Map<CardUid, string[]>;
  /** Sum of the lengths of every location array. */
  readonly slotCount: number;
}

function auditLocations(state: GameState): LocationAudit {
  const places = new Map<CardUid, string[]>();
  let slotCount = 0;
  const record = (uid: CardUid, place: string): void => {
    slotCount += 1;
    const found = places.get(uid);
    if (found) found.push(place);
    else places.set(uid, [place]);
  };
  for (const zone of ZONE_KEYS) {
    for (const uid of state.zones[zone]) record(uid, zone);
  }
  for (const player of state.players) {
    for (const uid of player.hand) record(uid, `${player.id}.hand`);
    for (const uid of player.voteCards) record(uid, `${player.id}.voteCards`);
    for (const uid of player.grantedVotes) record(uid, `${player.id}.grantedVotes`);
    for (const card of player.characterCards)
      record(card.uid, `${player.id}.characterCards`);
  }
  return { places, slotCount };
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

type ViolationKind =
  | "threw"
  | "registry_total"
  | "duplicate_registry_uid"
  | "card_in_two_places"
  | "card_missing"
  | "card_unregistered"
  | "conservation"
  | "census_helper"
  | "dead_player_holds_turn"
  | "turn_holder_not_a_player"
  | "unsatisfiable_vote_obligation"
  | "council_phase_edge"
  | "final_council_phase_edge"
  | "rejection_mutated_state"
  | "rejection_threw"
  | "illegal_action_accepted"
  | "legal_action_rejected"
  | "tick_failed"
  | "changed_flag"
  | "no_progress_loop"
  | "deadlock"
  | "did_not_terminate"
  | "unreachable_terminal_state"
  | "winner_not_a_finalist";

interface Violation {
  readonly kind: ViolationKind;
  readonly seed: number;
  readonly playerCount: number;
  readonly step: number;
  readonly after: string;
  readonly detail: string;
}

interface RunResult {
  readonly seed: number;
  readonly playerCount: PlayerCount;
  readonly steps: number;
  readonly status: string;
  readonly stage: string;
  readonly winnerId: PlayerId | null;
  readonly councilsPlayed: number;
  readonly finalCouncilReached: boolean;
  readonly rejectionProbes: number;
  readonly violations: readonly Violation[];
}

// ---------------------------------------------------------------------------
// Building a legal action out of a LegalAction affordance
// ---------------------------------------------------------------------------

/** Actions the fuzzer never takes: they end or reshape the game outside normal play. */
const OUT_OF_SCOPE: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "join_game",
  "leave_game",
  "choose_color",
  "name_castaways",
  "start_game",
  "abandon_game",
  "remove_player",
  "transfer_host",
]);

function buildAction(
  state: GameState,
  actor: PlayerId,
  legal: LegalAction,
  rand: () => number,
): Action | null {
  const pick = <T>(xs: readonly T[]): T | null =>
    xs.length === 0 ? null : (xs[Math.floor(rand() * xs.length)] ?? null);
  const pickTwo = <T>(xs: readonly T[]): [T, T] | null => {
    if (xs.length < 2) return null;
    const i = Math.floor(rand() * xs.length);
    let j = Math.floor(rand() * (xs.length - 1));
    if (j >= i) j += 1;
    return [xs[i]!, xs[j]!];
  };
  const targets = legal.legalTargets ?? [];
  const cards = legal.playableCardUids ?? [];
  const pendingId = legal.pendingId;

  switch (legal.kind) {
    case "steal_random": {
      const t = pick(targets);
      return t ? { type: "steal_random", actor, target: t } : null;
    }
    case "skip_play_step":
      return { type: "skip_play_step", actor };
    case "draw_card":
      return { type: "draw_card", actor };
    case "play_sorry_for_you": {
      const c = pick(cards);
      return pendingId && c
        ? { type: "play_sorry_for_you", actor, cardUid: c, pendingId }
        : null;
    }
    case "play_inheritance": {
      const c = pick(cards);
      return pendingId && c
        ? { type: "play_inheritance", actor, cardUid: c, pendingId }
        : null;
    }
    case "decline_reaction":
      return pendingId ? { type: "decline_reaction", actor, pendingId } : null;
    case "discard_card": {
      const c = pick(cards);
      return pendingId && c
        ? { type: "discard_card", actor, pendingId, cardUid: c }
        : null;
    }
    case "choose_card": {
      const c = pick(legal.optionCardUids ?? []);
      return pendingId && c
        ? { type: "choose_card", actor, pendingId, cardUid: c }
        : null;
    }
    case "choose_alliance_target": {
      const t = pick(targets);
      return pendingId && t
        ? { type: "choose_alliance_target", actor, pendingId, target: t }
        : null;
    }
    case "choose_steal_victim": {
      const t = pick(targets);
      return pendingId && t
        ? { type: "choose_steal_victim", actor, pendingId, target: t }
        : null;
    }
    case "submit_challenge_choice": {
      if (!pendingId) return null;
      const pending = state.pending.find((p) => p.id === pendingId);
      if (!pending || pending.kind !== "challenge") return null;
      if (pending.challenge === "do_or_die") {
        const throws = ["rock", "paper", "scissors"] as const;
        return {
          type: "submit_challenge_choice",
          actor,
          pendingId,
          submission: { kind: "rps", throw: throws[Math.floor(rand() * 3)]! },
        };
      }
      const max = pending.challenge === "power_pair" ? 3 : 5;
      const count = (Math.floor(rand() * max) + 1) as FingerCount;
      return {
        type: "submit_challenge_choice",
        actor,
        pendingId,
        submission: { kind: "fingers", count },
      };
    }
    case "leader_choose_eliminations": {
      if (!pendingId) return null;
      const want = legal.chooseCount ?? 1;
      const pool = [...targets];
      // Fisher-Yates on the harness stream so the Leader's pick is not seat-biased.
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      const chosen = pool.slice(0, want);
      return chosen.length === want
        ? { type: "leader_choose_eliminations", actor, pendingId, targets: chosen }
        : null;
    }
    case "cast_vote": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "cast_vote", actor, cardUid: c, target: t } : null;
    }
    case "finish_voting":
      return { type: "finish_voting", actor };
    case "play_immunity_idol": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t
        ? { type: "play_immunity_idol", actor, cardUid: c, protects: t }
        : null;
    }
    case "play_idol_nullifier": {
      const c = pick(cards);
      const council = councilOf(state.stage);
      const idol = council?.idolPlays.find((i) => i.nullifiedBy === null);
      return c && idol
        ? {
            type: "play_idol_nullifier",
            actor,
            cardUid: c,
            targetIdolUid: idol.cardUid,
          }
        : null;
    }
    case "advance_council": {
      const council = councilOf(state.stage);
      return council ? { type: "advance_council", actor, from: council.phase } : null;
    }
    case "advance_final_council": {
      const final = finalCouncilOf(state.stage);
      return final ? { type: "advance_final_council", actor, from: final.phase } : null;
    }
    case "juror_ready":
      return { type: "juror_ready", actor };
    case "reveal_hand":
      return { type: "reveal_hand", actor };
    case "cast_jury_vote": {
      const final = finalCouncilOf(state.stage);
      if (!final) return null;
      return {
        type: "cast_jury_vote",
        actor,
        finalist: final.finalists[rand() < 0.5 ? 0 : 1],
      };
    }
    case "final_leader_break_tie": {
      const final = finalCouncilOf(state.stage);
      if (!final) return null;
      return {
        type: "final_leader_break_tie",
        actor,
        winner: final.finalists[rand() < 0.5 ? 0 : 1],
      };
    }
    case "play_camp_raid": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "play_camp_raid", actor, cardUid: c, target: t } : null;
    }
    case "play_spy_shack": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "play_spy_shack", actor, cardUid: c, target: t } : null;
    }
    case "play_knowledge_is_power": {
      const c = pick(cards);
      const t = pick(targets);
      if (!c || !t) return null;
      const victim = state.players.find((p) => p.id === t);
      const known = victim?.hand
        .map((uid) => state.cards.find((card) => card.uid === uid)?.kind)
        .filter((k): k is CardKind => k !== undefined && k !== CardKind.Vote);
      // Half the time name a card they really hold, half the time guess - both are legal plays
      // and the two branches take different code paths in the engine.
      const named =
        known && known.length > 0 && rand() < 0.5
          ? known[Math.floor(rand() * known.length)]!
          : CardKind.SorryForYou;
      return { type: "play_knowledge_is_power", actor, cardUid: c, target: t, named };
    }
    case "play_lets_form_an_alliance": {
      const c = pick(cards);
      const pair = pickTwo(targets);
      return c && pair
        ? {
            type: "play_lets_form_an_alliance",
            actor,
            cardUid: c,
            partner: pair[0],
            victim: pair[1],
          }
        : null;
    }
    case "play_do_or_die": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "play_do_or_die", actor, cardUid: c, opponent: t } : null;
    }
    case "play_power_pair": {
      const c = pick(cards);
      const pair = pickTwo(targets);
      return c && pair
        ? {
            type: "play_power_pair",
            actor,
            cardUid: c,
            first: pair[0],
            second: pair[1],
          }
        : null;
    }
    case "play_its_a_numbers_game": {
      const c = pick(cards);
      return c ? { type: "play_its_a_numbers_game", actor, cardUid: c } : null;
    }
    case "play_control_the_vote": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t
        ? { type: "play_control_the_vote", actor, cardUid: c, target: t }
        : null;
    }
    case "play_goodwill_gamble": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t
        ? { type: "play_goodwill_gamble", actor, cardUid: c, recipient: t }
        : null;
    }
    case "play_im_the_leader_now": {
      const c = pick(cards);
      return c ? { type: "play_im_the_leader_now", actor, cardUid: c } : null;
    }
    // The lobby actions are dealt by the harness itself (join / start), or are deliberately
    // never taken by the autopilot (`abandon_game` would end the run early). Listed rather than
    // left to the `default` so that a 41st ActionKind is a build failure here too.
    case "join_game":
    case "leave_game":
    case "choose_color":
    case "name_castaways":
    case "start_game":
    case "abandon_game":
    case "remove_player":
    case "transfer_host":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Illegal probes: one attempt of every action kind, by somebody who is not in the game
// ---------------------------------------------------------------------------

const GHOST = asPlayerId("u-ghost-not-in-this-game");
const GHOST_CARD = asCardUid("c999:not-a-real-card");
const GHOST_PENDING = asPendingId("pend-not-a-real-window");

/**
 * Every one of the engine's action types, attempted by a player who is not in the game. All 40
 * must be refused, and none may leave a fingerprint on the state.
 */
function ghostProbes(state: GameState): readonly Action[] {
  const someone = state.players[0]?.id ?? GHOST;
  const council = councilOf(state.stage);
  const final = finalCouncilOf(state.stage);
  return [
    { type: "join_game", actor: GHOST, displayName: "Ghost" },
    { type: "leave_game", actor: GHOST },
    { type: "choose_color", actor: GHOST, color: "red" },
    { type: "name_castaways", actor: GHOST, castaways: ["Ghost", null] },
    { type: "start_game", actor: GHOST },
    { type: "abandon_game", actor: GHOST },
    { type: "remove_player", actor: GHOST, target: someone },
    { type: "transfer_host", actor: GHOST, target: someone },
    { type: "steal_random", actor: GHOST, target: someone },
    { type: "play_camp_raid", actor: GHOST, cardUid: GHOST_CARD, target: someone },
    {
      type: "play_knowledge_is_power",
      actor: GHOST,
      cardUid: GHOST_CARD,
      target: someone,
      named: CardKind.SorryForYou,
    },
    { type: "play_spy_shack", actor: GHOST, cardUid: GHOST_CARD, target: someone },
    {
      type: "play_lets_form_an_alliance",
      actor: GHOST,
      cardUid: GHOST_CARD,
      partner: someone,
      victim: someone,
    },
    { type: "play_do_or_die", actor: GHOST, cardUid: GHOST_CARD, opponent: someone },
    {
      type: "play_power_pair",
      actor: GHOST,
      cardUid: GHOST_CARD,
      first: someone,
      second: someone,
    },
    { type: "play_its_a_numbers_game", actor: GHOST, cardUid: GHOST_CARD },
    { type: "skip_play_step", actor: GHOST },
    { type: "draw_card", actor: GHOST },
    {
      type: "play_sorry_for_you",
      actor: GHOST,
      cardUid: GHOST_CARD,
      pendingId: GHOST_PENDING,
    },
    {
      type: "play_inheritance",
      actor: GHOST,
      cardUid: GHOST_CARD,
      pendingId: GHOST_PENDING,
    },
    { type: "decline_reaction", actor: GHOST, pendingId: GHOST_PENDING },
    {
      type: "submit_challenge_choice",
      actor: GHOST,
      pendingId: GHOST_PENDING,
      submission: { kind: "rps", throw: "rock" },
    },
    {
      type: "choose_alliance_target",
      actor: GHOST,
      pendingId: GHOST_PENDING,
      target: someone,
    },
    {
      type: "choose_card",
      actor: GHOST,
      pendingId: GHOST_PENDING,
      cardUid: GHOST_CARD,
    },
    {
      type: "choose_steal_victim",
      actor: GHOST,
      pendingId: GHOST_PENDING,
      target: someone,
    },
    {
      type: "discard_card",
      actor: GHOST,
      pendingId: GHOST_PENDING,
      cardUid: GHOST_CARD,
    },
    { type: "advance_council", actor: GHOST, from: council?.phase ?? "advantages" },
    {
      type: "play_control_the_vote",
      actor: GHOST,
      cardUid: GHOST_CARD,
      target: someone,
    },
    {
      type: "play_goodwill_gamble",
      actor: GHOST,
      cardUid: GHOST_CARD,
      recipient: someone,
    },
    { type: "play_im_the_leader_now", actor: GHOST, cardUid: GHOST_CARD },
    { type: "cast_vote", actor: GHOST, cardUid: GHOST_CARD, target: someone },
    { type: "finish_voting", actor: GHOST },
    {
      type: "play_immunity_idol",
      actor: GHOST,
      cardUid: GHOST_CARD,
      protects: someone,
    },
    {
      type: "play_idol_nullifier",
      actor: GHOST,
      cardUid: GHOST_CARD,
      targetIdolUid: GHOST_CARD,
    },
    {
      type: "leader_choose_eliminations",
      actor: GHOST,
      pendingId: GHOST_PENDING,
      targets: [],
    },
    { type: "advance_final_council", actor: GHOST, from: final?.phase ?? "opening" },
    { type: "reveal_hand", actor: GHOST },
    { type: "juror_ready", actor: GHOST },
    { type: "cast_jury_vote", actor: GHOST, finalist: someone },
    { type: "final_leader_break_tie", actor: GHOST, winner: someone },
  ];
}

// ---------------------------------------------------------------------------
// Legal council-phase edges
// ---------------------------------------------------------------------------

/**
 * The rulebook's Leader script (docs/RULES.md:88-108) in order, with the two documented skips:
 * the nullifier window "exists only if there is something to nullify", and the tie-break rung
 * is only entered when it is "unclear who is voted out".
 */
const LEGAL_COUNCIL_EDGES: ReadonlySet<string> = new Set([
  "advantages->discussion",
  "discussion->voting",
  "voting->idols",
  "idols->nullifiers",
  "idols->tally",
  "nullifiers->tally",
  "tally->tie_break",
  "tally->cleanup",
  "tie_break->cleanup",
]);

const councilIndex = (p: CouncilPhase): number => COUNCIL_PHASE_ORDER.indexOf(p);
const finalIndex = (p: FinalCouncilPhase): number =>
  FINAL_COUNCIL_PHASE_ORDER.indexOf(p);

/**
 * Who an open window is waiting on, and whether that player is still in the game. A window
 * addressed to a player the engine will never offer an action to is unresolvable by hand.
 */
function waitingOnOf(state: GameState, pending: GameState["pending"][number]): string {
  const who: PlayerId[] = [];
  if ("leaderId" in pending) who.push(pending.leaderId);
  if ("victimId" in pending) who.push(pending.victimId);
  if ("playerId" in pending) who.push(pending.playerId);
  if ("chooserId" in pending) who.push(pending.chooserId);
  if ("partnerId" in pending) who.push(pending.partnerId);
  if (who.length === 0) return "?";
  return who
    .map((id) => {
      const p = state.players.find((q) => q.id === id);
      return `${id}${p && !isInPlay(p) ? "(ELIMINATED)" : ""}`;
    })
    .join("+");
}

/** Where in the state machine something happened, for a violation message. */
function describeWhere(state: GameState): string {
  const council = councilOf(state.stage);
  if (council) return `council phase ${council.phase}`;
  const final = finalCouncilOf(state.stage);
  if (final) return `final council phase ${final.phase}`;
  const turn = turnOf(state.stage);
  if (turn) return `turn phase ${turn.phase}`;
  return state.stage.kind;
}

// ---------------------------------------------------------------------------
// The fuzz driver
// ---------------------------------------------------------------------------

interface RunOptions {
  readonly seed: number;
  readonly playerCount: PlayerCount;
  /** How often (in steps) to fire the full illegal-probe battery. */
  readonly probeEvery: number;
  readonly maxSteps: number;
}

function runGame(options: RunOptions): RunResult {
  const { seed, playerCount, probeEvery, maxSteps } = options;
  const rand = makeRandom(seed ^ 0x5bf03635);
  const violations: Violation[] = [];
  const ids = Array.from({ length: playerCount }, (_, i) => idFor(i));
  const expectedTotal = expectedRegistryTotal(playerCount, ENGINE);

  let step = 0;
  let after = "create_game";
  let clock = 1_700_000_000_000;
  const now = (): number => (clock += 1000);
  let rejectionProbes = 0;
  const councilIds = new Set<string>();
  let finalCouncilReached = false;
  let finalists: PlayerId[] = [];

  // One report per distinct problem per game, so a systematic defect does not drown the output
  // in thousands of copies of itself.
  const reported = new Set<string>();
  const flag = (kind: ViolationKind, detail: string): void => {
    const key = `${kind}|${detail}`;
    if (reported.has(key) || violations.length >= 12) return;
    reported.add(key);
    violations.push({ kind, seed, playerCount, step, after, detail });
  };

  // --- the per-step invariant battery -------------------------------------
  const checkState = (state: GameState): void => {
    // 1. The registry itself: no duplicate uids, and the box never gains or loses a card.
    const registry = new Set<CardUid>();
    for (const card of state.cards) {
      if (registry.has(card.uid))
        flag("duplicate_registry_uid", `uid ${card.uid} minted twice`);
      registry.add(card.uid);
    }
    if (state.stage.kind !== "lobby" && state.cards.length !== expectedTotal) {
      flag(
        "registry_total",
        `registry holds ${state.cards.length} cards, the box holds ${expectedTotal}`,
      );
    }

    // 2. One card, one place - derived here rather than trusting `censusOf`.
    const audit = auditLocations(state);
    for (const [uid, places] of audit.places) {
      if (places.length > 1) {
        flag("card_in_two_places", `uid ${uid} is in ${places.join(" and ")}`);
      }
      if (!registry.has(uid)) {
        flag(
          "card_unregistered",
          `uid ${uid} sits in ${places.join(",")} but is not registered`,
        );
      }
    }
    for (const card of state.cards) {
      if (!audit.places.has(card.uid)) {
        flag("card_missing", `registered uid ${card.uid} is in no location at all`);
      }
    }

    // 3. Conservation: the number of occupied slots equals the number of cards. Catches both a
    //    vanished card and a card silently duplicated into two slots.
    if (state.stage.kind !== "lobby" && audit.slotCount !== expectedTotal) {
      flag(
        "conservation",
        `hands+zones hold ${audit.slotCount} card slots, expected ${expectedTotal}`,
      );
    }

    // 4. The engine's own census must agree with ours.
    const problems = censusOf(state);
    if (problems.length > 0) {
      flag(
        "census_helper",
        `censusOf reports ${problems.length}: ${JSON.stringify(problems[0])}`,
      );
    }

    // 5. A LIVE turn is only ever held by a player who is still in the game.
    //
    //    `stage.council.turn` with `phase: "ended"` is the historical record of the turn the
    //    council interrupted - the drawer's turn ended on the draw that started it - and that
    //    player may legitimately be voted out by their own council. Every other turn is live,
    //    and a live turn belongs to a player who is still in the game: "As long as you have at
    //    least one Survivor Character Card, you're still in the game" (docs/RULES.md:23).
    const turn = turnOf(state.stage);
    const turnIsLive = state.stage.kind === "turn" || turn?.phase !== "ended";
    if (turn) {
      const holder = state.players.find((p) => p.id === turn.playerId);
      if (!holder) {
        flag(
          "turn_holder_not_a_player",
          `turn held by unknown player ${turn.playerId}`,
        );
      } else if (!isInPlay(holder) && turnIsLive) {
        flag(
          "dead_player_holds_turn",
          `${holder.id} holds the turn (stage=${state.stage.kind} turnPhase=${turn.phase}` +
            `${councilOf(state.stage) ? ` councilPhase=${councilOf(state.stage)!.phase}` : ""})` +
            ` but eliminatedAtSeq=${String(holder.eliminatedAtSeq)}` +
            ` leftAtSeq=${String(holder.leftAtSeq)}`,
        );
      }
    }

    // 6. "Everyone must vote. I'll go first." (docs/RULES.md:103) Voting is compulsory, and
    //    `finish_voting`/`advance_council` are refused with `must_cast_mandatory_vote` until
    //    every obligation is discharged - so every obligation must be DISCHARGEABLE: the player
    //    who owes a cast has to be holding the card they owe. An obligation naming a card
    //    somebody else holds can never be satisfied and wedges the vote.
    const council = councilOf(state.stage);
    if (council && council.phase === "voting") {
      // A card still inside an unresolved take is legitimately in flight.
      const inFlight = new Set<CardUid>();
      for (const pending of state.pending) {
        if (pending.kind === "take" && pending.spec.kind === "specific") {
          for (const uid of pending.spec.cardUids) inFlight.add(uid);
        }
      }
      for (const cast of council.requiredCasts) {
        if (inFlight.has(cast.cardUid)) continue;
        const owner = state.players.find((p) => p.id === cast.playerId);
        const holds =
          owner !== undefined &&
          (owner.voteCards.includes(cast.cardUid) ||
            owner.grantedVotes.includes(cast.cardUid) ||
            owner.hand.includes(cast.cardUid));
        if (!holds) {
          const realHolder =
            state.players.find(
              (p) =>
                p.voteCards.includes(cast.cardUid) ||
                p.grantedVotes.includes(cast.cardUid) ||
                p.hand.includes(cast.cardUid),
            )?.id ?? "nobody";
          flag(
            "unsatisfiable_vote_obligation",
            `${cast.playerId} owes a ${cast.source} cast of ${cast.cardUid}, but that card is ` +
              `held by ${realHolder}`,
          );
        }
      }
    }
  };

  // --- council phase edge tracking ----------------------------------------
  //
  // Driven off the emitted `council_phase_changed` / `final_council_phase_changed` events
  // rather than off sampled state: a single dispatch can legitimately walk a council through
  // several phases (closing the vote runs voting -> idols -> tally in one go), and sampling
  // only the final state would report a transition the engine never actually made.
  const councilsSeen = new Set<string>();

  const checkEvents = (events: readonly GameEvent[]): void => {
    for (const event of events) {
      if (event.type === "council_started") councilIds.add(event.councilId);
      if (event.type === "final_council_started") {
        finalCouncilReached = true;
        finalists = [...event.finalists];
      }
      if (event.type === "winner_declared" && event.method !== "sole_survivor") {
        // "The player with the most votes is declared the Sole Survivor and winner of the
        // game!" - the Jury votes FOR one of the two finalists, so nobody else can win.
        if (!finalists.includes(event.winnerId)) {
          flag(
            "winner_not_a_finalist",
            `${event.winnerId} was declared the winner by ${event.method}, but the finalists ` +
              `were [${finalists.join(", ")}]`,
          );
        }
      }
      if (event.type === "council_phase_changed") {
        councilIds.add(event.councilId);
        if (!councilsSeen.has(event.councilId)) {
          councilsSeen.add(event.councilId);
          // "Welcome to Tribal Council. If anyone has a Tribal Advantage Card, you may play it
          // now..." is the Leader's first line: every council opens in `advantages`.
          if (event.from !== "advantages") {
            flag(
              "council_phase_edge",
              `council ${event.councilId} first moved out of ${event.from}, not advantages`,
            );
          }
        }
        const edge = `${event.from}->${event.to}`;
        if (!LEGAL_COUNCIL_EDGES.has(edge)) {
          flag("council_phase_edge", `illegal council transition ${edge}`);
        }
        if (councilIndex(event.to) <= councilIndex(event.from)) {
          flag("council_phase_edge", `council went backwards: ${edge}`);
        }
      }
      if (event.type === "final_council_phase_changed") {
        // The Final Council may legally SKIP forward - "when every member of the Jury has a
        // finger in the air" jumps straight to the vote - but never sideways or backwards.
        if (finalIndex(event.to) <= finalIndex(event.from)) {
          flag(
            "final_council_phase_edge",
            `final council went backwards: ${event.from}->${event.to}`,
          );
        }
      }
    }
  };

  const checkPhases = (state: GameState): void => {
    const council = councilOf(state.stage);
    if (council) councilIds.add(council.id);
    if (finalCouncilOf(state.stage)) finalCouncilReached = true;
  };

  // --- rejected actions are pure ------------------------------------------
  const probeRejections = (game: Game): void => {
    const before = JSON.stringify(game.state());
    for (const probe of ghostProbes(game.state())) {
      rejectionProbes += 1;
      let accepted = false;
      try {
        const outcome = game.dispatch(probe, now());
        accepted = outcome.ok;
      } catch (error) {
        flag("rejection_threw", `${probe.type} threw ${String(error)}`);
        continue;
      }
      if (accepted) {
        flag(
          "illegal_action_accepted",
          `${probe.type} by a player who is not in the game was ACCEPTED`,
        );
      }
      const afterProbe = JSON.stringify(game.state());
      if (afterProbe !== before) {
        flag(
          "rejection_mutated_state",
          `${probe.type} changed the state despite being refused`,
        );
      }
    }
  };

  // --- setup ---------------------------------------------------------------
  let game: Game;
  try {
    game = createGame({
      gameId: asGameId(`fuzz-${seed}-${playerCount}`),
      hostId: ids[0]!,
      config: ENGINE,
      nowMs: now(),
      seed,
    });
    for (const [i, id] of ids.entries()) {
      const joined = game.dispatch(
        { type: "join_game", actor: id, displayName: NAMES[i]! },
        now(),
      );
      if (!joined.ok) {
        flag("legal_action_rejected", `join_game rejected: ${joined.error.code}`);
        return finish(game, step);
      }
    }
    after = "start_game";
    const started = game.dispatch(
      { type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! },
      now(),
    );
    if (!started.ok) {
      flag("legal_action_rejected", `start_game rejected: ${started.error.code}`);
      return finish(game, step);
    }
    checkState(game.state());
    checkPhases(game.state());
  } catch (error) {
    return {
      seed,
      playerCount,
      steps: 0,
      status: "threw",
      stage: "threw",
      winnerId: null,
      councilsPlayed: 0,
      finalCouncilReached: false,
      rejectionProbes,
      violations: [
        {
          kind: "threw",
          seed,
          playerCount,
          step: 0,
          after: "setup",
          detail: String(error),
        },
      ],
    };
  }

  // --- the loop ------------------------------------------------------------
  let silentDispatches = 0;
  let terminated = false;

  while (step < maxSteps) {
    step += 1;
    const state = game.state();
    if (state.stage.kind === "finished" || state.stage.kind === "abandoned") {
      terminated = true;
      break;
    }

    if (step % probeEvery === 0) probeRejections(game);

    // Collect every affordance the engine is offering to anybody, then take one at random.
    const options: { actor: PlayerId; legal: LegalAction }[] = [];
    try {
      for (const player of state.players) {
        for (const legal of game.legalActions(player.id, clock)) {
          if (OUT_OF_SCOPE.has(legal.kind)) continue;
          options.push({ actor: player.id, legal });
        }
      }
    } catch (error) {
      flag("threw", `legalActions threw ${String(error)}`);
      break;
    }

    // Shuffle the affordances so no seat or action kind is systematically favoured.
    for (let i = options.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [options[i], options[j]] = [options[j]!, options[i]!];
    }

    // Take the first affordance we can actually fill in. An affordance the engine then REFUSES
    // is recorded as a defect (`legalActions` must not offer a button that fails) but does not
    // stop the run: we move on to the next affordance so the game still plays to the end.
    let acted = false;
    let threw = false;
    for (const option of options) {
      const action = buildAction(state, option.actor, option.legal, rand);
      if (!action) continue;
      after = `${action.type} by ${option.actor}`;
      let outcome;
      try {
        outcome = game.dispatch(action, now());
      } catch (error) {
        flag("threw", `${action.type} threw ${String(error)}`);
        threw = true;
        break;
      }
      if (!outcome.ok) {
        flag(
          "legal_action_rejected",
          `${action.type} was offered by legalActions() in ` +
            `${describeWhere(state)} then refused with ${outcome.error.code}`,
        );
        continue;
      }
      if (outcome.value.events.length > 0 && !outcome.value.changed) {
        flag(
          "changed_flag",
          `${action.type} emitted events but reported changed=false`,
        );
      }
      if (outcome.value.events.length === 0) {
        silentDispatches += 1;
        if (silentDispatches > 4) {
          flag(
            "no_progress_loop",
            `${action.type} is offered but emits nothing; 5 no-op dispatches in a row`,
          );
          threw = true;
          break;
        }
      } else {
        silentDispatches = 0;
      }
      checkEvents(outcome.value.events);
      acted = true;
      break;
    }
    if (threw) break;

    if (!acted) {
      // Nothing is playable by anybody. The clock is the only thing that may move the game on.
      const deadline = game.nextDeadline();
      if (!deadline) {
        flag(
          "deadlock",
          `no legal action for any player and no deadline; stage=${state.stage.kind}` +
            (councilOf(state.stage)
              ? ` councilPhase=${councilOf(state.stage)!.phase}`
              : "") +
            ` openPendings=${state.pending.length}`,
        );
        break;
      }
      clock = Math.max(clock, deadline.atMs) + 1;
      after = `tick(${deadline.reason})`;
      try {
        const ticked = game.tick(clock);
        if (!ticked.ok) {
          flag(
            "tick_failed",
            `tick(${deadline.reason}) failed with ${ticked.error.code}`,
          );
          break;
        }
        checkEvents(ticked.value.events);
        if (ticked.value.events.length > 0 && !ticked.value.changed) {
          flag("changed_flag", "tick emitted events but reported changed=false");
        }
        if (ticked.value.events.length === 0) {
          silentDispatches += 1;
          if (silentDispatches > 4) {
            const now2 = game.state();
            const t = turnOf(now2.stage);
            // A deadlock proper: no player has a legal action, and the deadline the engine
            // itself nominates does nothing when it is ticked - so a caller that faithfully
            // schedules `nextDeadline()` spins on it forever.
            flag(
              "deadlock",
              `nobody can act and tick(${deadline.reason}) emits nothing 5x in a row: ` +
                `${describeWhere(now2)} holder=${String(t?.playerId)} ` +
                `stealResolved=${String(t?.stealResolved)} ` +
                `pendings=[${now2.pending.map((p) => `${p.kind}:${waitingOnOf(now2, p)}`).join(", ") || "none"}] ` +
                `drawPile=${now2.zones.drawPile.length}`,
            );
            break;
          }
        } else {
          silentDispatches = 0;
        }
      } catch (error) {
        flag("threw", `tick threw ${String(error)}`);
        break;
      }
      checkState(game.state());
      checkPhases(game.state());
      continue;
    }

    checkState(game.state());
    checkPhases(game.state());
  }

  if (!terminated && step >= maxSteps) {
    flag(
      "did_not_terminate",
      `still ${game.state().stage.kind} after ${step} steps ` +
        `(draw pile ${game.state().zones.drawPile.length})`,
    );
  }

  return finish(game, step);

  function finish(g: Game, steps: number): RunResult {
    const state = g.state();
    const status = statusOf(state.stage);
    if (state.stage.kind === "finished") {
      const winner = state.stage.winnerId;
      if (winner !== null) {
        const player = state.players.find((p) => p.id === winner);
        if (!player) flag("winner_not_a_finalist", `winner ${winner} is not a player`);
        else if (player.leftAtSeq !== null) {
          flag("winner_not_a_finalist", `winner ${winner} had left the game`);
        }
      }
    }
    return {
      seed,
      playerCount,
      steps,
      status,
      stage: state.stage.kind,
      winnerId: state.stage.kind === "finished" ? state.stage.winnerId : null,
      councilsPlayed: councilIds.size,
      finalCouncilReached,
      rejectionProbes,
      violations,
    };
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

const PLAYER_COUNTS: readonly PlayerCount[] = [3, 4, 5, 6];
/** Fixed base seed: every run of this file plays exactly the same games. */
const BASE_SEED = 20250909;
const GAMES_PER_PLAYER_COUNT = 500;
const MAX_STEPS = 4000;

let RUNS: RunResult[] = [];

/**
 * A run that was stopped by the harness because the engine did something fatal (threw, wedged,
 * or failed a tick). Those are reported by their own assertions; asking such a run to also have
 * reached a winner would report the same defect twice.
 */
const FATAL: ReadonlySet<ViolationKind> = new Set<ViolationKind>([
  "threw",
  "deadlock",
  "no_progress_loop",
  "tick_failed",
]);
const abandonedRun = (r: RunResult): boolean =>
  r.violations.some((v) => FATAL.has(v.kind));

function violationsOfKind(...kinds: ViolationKind[]): Violation[] {
  const wanted = new Set<ViolationKind>(kinds);
  return RUNS.flatMap((run) => run.violations.filter((v) => wanted.has(v.kind)));
}

function describeViolations(vs: readonly Violation[]): string {
  if (vs.length === 0) return "";
  const shown = vs
    .slice(0, 6)
    .map(
      (v) =>
        `\n  [seed ${v.seed} / ${v.playerCount}p / step ${v.step} / after ${v.after}] ` +
        `${v.kind}: ${v.detail}`,
    );
  return `${vs.length} violation(s) across ${
    new Set(vs.map((v) => `${v.seed}:${v.playerCount}`)).size
  } game(s):${shown.join("")}${vs.length > 6 ? "\n  ..." : ""}`;
}

/** Every failing assertion names the exact seeds so the bug can be replayed. */
function expectNoViolations(...kinds: ViolationKind[]): void {
  const vs = violationsOfKind(...kinds);
  expect(describeViolations(vs)).toBe("");
}

describe("global invariants under fuzzing", () => {
  beforeAll(() => {
    RUNS = [];
    for (const playerCount of PLAYER_COUNTS) {
      for (let i = 0; i < GAMES_PER_PLAYER_COUNT; i += 1) {
        RUNS.push(
          runGame({
            seed: BASE_SEED + i * 7919 + playerCount * 104729,
            playerCount,
            probeEvery: 41,
            maxSteps: MAX_STEPS,
          }),
        );
      }
    }
  }, 600_000);

  it("the fuzz matrix actually played a representative population of games", () => {
    expect(RUNS.length).toBe(PLAYER_COUNTS.length * GAMES_PER_PLAYER_COUNT);
    // Coverage guard: if the harness silently stopped driving games, every other assertion in
    // this file would pass vacuously.
    const totalSteps = RUNS.reduce((n, r) => n + r.steps, 0);
    expect(totalSteps).toBeGreaterThan(RUNS.length * 50);
    const councils = RUNS.reduce((n, r) => n + r.councilsPlayed, 0);
    expect(councils).toBeGreaterThan(RUNS.length);
    expect(RUNS.filter((r) => r.finalCouncilReached).length).toBeGreaterThan(
      RUNS.length / 2,
    );
    for (const count of PLAYER_COUNTS) {
      expect(RUNS.filter((r) => r.playerCount === count).length).toBe(
        GAMES_PER_PLAYER_COUNT,
      );
    }
  });

  it("no action ever throws: every dispatch, tick and legalActions call returns a Result", () => {
    expectNoViolations("threw");
  });

  it("the box never gains or loses a card: the registry always holds all 80 card instances", () => {
    expectNoViolations("registry_total");
  });

  it("no card uid is ever minted twice", () => {
    expectNoViolations("duplicate_registry_uid");
  });

  it("no card uid ever appears in two zones at once", () => {
    expectNoViolations("card_in_two_places");
  });

  it("no card ever falls out of the game: every registered uid is in exactly one location", () => {
    expectNoViolations("card_missing", "card_unregistered");
  });

  it("cards are conserved: hands + vote cards + character cards + the six zones always sum to the deck composition", () => {
    expectNoViolations("conservation");
  });

  it("the engine's own card census agrees with an independently derived one", () => {
    expectNoViolations("census_helper");
  });

  it("the current player is always alive: an eliminated or departed player never holds the turn", () => {
    expectNoViolations("dead_player_holds_turn", "turn_holder_not_a_player");
  });

  it("every mandatory vote obligation names a card the obligated player is actually holding", () => {
    expectNoViolations("unsatisfiable_vote_obligation");
  });

  it("Tribal Council phases only follow the legal edges of the printed Leader script", () => {
    expectNoViolations("council_phase_edge");
  });

  it("the Final Tribal Council never revisits a phase it has already left", () => {
    expectNoViolations("final_council_phase_edge");
  });

  it("a rejected action never mutates state", () => {
    expectNoViolations("rejection_mutated_state", "rejection_threw");
    // And the probes really did run, rather than the guard being vacuous.
    expect(RUNS.reduce((n, r) => n + r.rejectionProbes, 0)).toBeGreaterThan(1000);
  });

  it("a player who is not in the game cannot perform any of the 40 actions", () => {
    expectNoViolations("illegal_action_accepted");
  });

  it("every action the engine offers as legal is accepted when it is taken", () => {
    expectNoViolations("legal_action_rejected");
  });

  it("an action that is offered always changes something: no no-op is ever on the menu", () => {
    expectNoViolations("no_progress_loop", "changed_flag");
  });

  it("no game ever deadlocks: some player can always act, or a deadline can always move it on", () => {
    expectNoViolations("deadlock", "tick_failed");
  });

  it("every game terminates in a clean terminal state rather than hanging", () => {
    expectNoViolations("did_not_terminate", "unreachable_terminal_state");
    const unfinished = RUNS.filter(
      (r) => !abandonedRun(r) && r.stage !== "finished",
    ).map(
      (r) =>
        `seed ${r.seed} (${r.playerCount}p) ended in stage ${r.stage} after ${r.steps} steps`,
    );
    expect(unfinished.join("\n")).toBe("");
  });

  it("a finished game declares a winner who is one of the two finalists", () => {
    expectNoViolations("winner_not_a_finalist");
    const finished = RUNS.filter((r) => r.stage === "finished");
    expect(finished.length).toBeGreaterThan(0);
    // "The player with the most votes is declared the Sole Survivor and winner of the game!"
    // A game that reached a Final Tribal Council must name somebody.
    const withFinal = finished.filter((r) => r.finalCouncilReached);
    for (const run of withFinal) {
      expect(
        run.winnerId,
        `seed ${run.seed} (${run.playerCount}p) held a Final Tribal Council but declared no winner`,
      ).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted, fully deterministic invariant checks (no fuzzing)
// ---------------------------------------------------------------------------

function startedGame(
  playerCount: PlayerCount,
  seed: number,
): { game: Game; ids: PlayerId[] } {
  const ids = Array.from({ length: playerCount }, (_, i) => idFor(i));
  let clock = 1_700_000_000_000;
  const now = (): number => (clock += 1000);
  const game = createGame({
    gameId: asGameId(`det-${seed}`),
    hostId: ids[0]!,
    config: ENGINE,
    nowMs: now(),
    seed,
  });
  for (const [i, id] of ids.entries()) {
    const joined = game.dispatch(
      { type: "join_game", actor: id, displayName: NAMES[i]! },
      now(),
    );
    expect(joined.ok).toBe(true);
  }
  const started = game.dispatch(
    { type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! },
    now(),
  );
  expect(started.ok).toBe(true);
  return { game, ids };
}

describe("invariants that hold from the first moment of a game", () => {
  it("setup accounts for every card in the box, used or put away", () => {
    for (const playerCount of PLAYER_COUNTS) {
      const { game } = startedGame(playerCount, 4242 + playerCount);
      const state = game.state();
      const expected = expectedRegistryTotal(playerCount, ENGINE);
      expect(state.cards.length, `${playerCount}p registry size`).toBe(expected);
      const audit = auditLocations(state);
      expect(audit.slotCount, `${playerCount}p occupied slots`).toBe(expected);
      expect(audit.places.size, `${playerCount}p distinct located uids`).toBe(expected);
      expect(censusOf(state)).toEqual([]);
    }
  });

  it("every one of the 40 action types is refused for a player who is not in the game, and changes nothing", () => {
    const { game } = startedGame(4, 777);
    const before = JSON.stringify(game.state());
    const probes = ghostProbes(game.state());
    // The whole Action union, not a sample of it.
    expect(new Set(probes.map((p) => p.type)).size).toBe(40);
    let clock = 1_800_000_000_000;
    for (const probe of probes) {
      const outcome = game.dispatch(probe, (clock += 1000));
      expect(outcome.ok, `${probe.type} by a non-player was accepted`).toBe(false);
      expect(JSON.stringify(game.state()), `${probe.type} mutated the state`).toBe(
        before,
      );
    }
  });

  it("a rejected action leaves the state byte-identical even when it names real cards and real players", () => {
    const { game, ids } = startedGame(4, 909);
    const state = game.state();
    const turn = turnOf(state.stage);
    expect(turn).not.toBeNull();
    const current = turn!.playerId;
    const other = ids.find((id) => id !== current)!;
    const otherHand = state.players.find((p) => p.id === other)!.hand;
    const before = JSON.stringify(state);
    let clock = 1_900_000_000_000;
    const illegal: Action[] = [
      // Turn step 3 before turn step 1: "Remember: Steal, Play (or don't), then Draw!"
      { type: "draw_card", actor: current },
      // Somebody else's turn.
      { type: "steal_random", actor: other, target: current },
      // A card that is in another player's hand.
      { type: "play_spy_shack", actor: current, cardUid: otherHand[0]!, target: other },
      // No council is in progress.
      { type: "advance_council", actor: current, from: "discussion" },
      { type: "finish_voting", actor: current },
      // No Final Tribal Council is in progress.
      { type: "cast_jury_vote", actor: current, finalist: other },
      { type: "juror_ready", actor: current },
    ];
    for (const action of illegal) {
      const outcome = game.dispatch(action, (clock += 1000));
      expect(outcome.ok, `${action.type} should have been refused`).toBe(false);
      expect(JSON.stringify(game.state()), `${action.type} mutated the state`).toBe(
        before,
      );
    }
  });

  it("the draw pile is never rebuilt from the discard pile: it only ever shrinks", () => {
    // docs/RULES.md:80 - "There is no reshuffle rule. The Draw Pile is never rebuilt from the
    // Discard Pile."
    const offenders: string[] = [];
    for (const playerCount of PLAYER_COUNTS) {
      for (let i = 0; i < 12; i += 1) {
        const seed = 31337 + i * 13 + playerCount * 1009;
        const rand = makeRandom(seed ^ 0x2545f491);
        const ids = Array.from({ length: playerCount }, (_, k) => idFor(k));
        let clock = 1_700_000_000_000;
        const now = (): number => (clock += 1000);
        const game = createGame({
          gameId: asGameId(`draw-${seed}`),
          hostId: ids[0]!,
          config: ENGINE,
          nowMs: now(),
          seed,
        });
        for (const [k, id] of ids.entries()) {
          game.dispatch(
            { type: "join_game", actor: id, displayName: NAMES[k]! },
            now(),
          );
        }
        game.dispatch(
          { type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! },
          now(),
        );
        let previous = game.state().zones.drawPile.length;
        let steps = 0;
        while (steps < MAX_STEPS) {
          steps += 1;
          const state = game.state();
          if (state.stage.kind === "finished" || state.stage.kind === "abandoned")
            break;
          const options: { actor: PlayerId; legal: LegalAction }[] = [];
          for (const player of state.players) {
            for (const legal of game.legalActions(player.id, clock)) {
              if (OUT_OF_SCOPE.has(legal.kind)) continue;
              options.push({ actor: player.id, legal });
            }
          }
          for (let a = options.length - 1; a > 0; a -= 1) {
            const b = Math.floor(rand() * (a + 1));
            [options[a], options[b]] = [options[b]!, options[a]!];
          }
          let acted = false;
          for (const option of options) {
            const action = buildAction(state, option.actor, option.legal, rand);
            if (!action) continue;
            game.dispatch(action, now());
            acted = true;
            break;
          }
          if (!acted) {
            const deadline = game.nextDeadline();
            if (!deadline) break;
            clock = Math.max(clock, deadline.atMs) + 1;
            game.tick(clock);
          }
          const size = game.state().zones.drawPile.length;
          if (size > previous) {
            offenders.push(
              `seed ${seed} (${playerCount}p) step ${steps}: draw pile grew ${previous} -> ${size}`,
            );
            break;
          }
          previous = size;
        }
      }
    }
    expect(offenders.join("\n")).toBe("");
  });
});
