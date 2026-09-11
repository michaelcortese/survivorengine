/**
 * Every domain type in the game.
 *
 * DEPENDENCY RULE: this file — and everything else under `src/engine/` — must never import
 * `discord.js`, `node:fs`, or anything else with an I/O or platform dependency, and must never
 * call `Date.now()`, `Math.random()`, `setTimeout` or `setInterval`. The engine is a pure
 * function of (state, action, now) -> (state, events). Audit #54: "the rules engine is not
 * testable as written — every algorithm is reachable only through a live discord.js
 * interaction and a module-level singleton." Enforced by an eslint override on `src/engine/**`
 * and a grep step in CI, not by good intentions.
 *
 * It may import `../config.js` for TYPES ONLY. Importing the live `config` / `engineConfig`
 * singletons from there would give the engine a runtime dependency on `process.env`; that
 * specific import is banned by the same eslint override.
 *
 * Several type choices here exist specifically to make a class of audit defect unrepresentable
 * rather than merely unlikely. Those are marked STRUCTURAL.
 */

import type { EngineConfig, PendingWindowKind, PlayerCount } from "../config.js";
import type { FinalCouncilTrigger, GameEvent } from "./events.js";
import type { RngState } from "./rng.js";

export type { PlayerCount } from "../config.js";

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

declare const brandTag: unique symbol;

/** Nominal typing for ids: a `PlayerId` can never be passed where a `CardUid` is expected. */
type Brand<T, B extends string> = T & { readonly [brandTag]: B };

/** A Discord user snowflake. */
export type PlayerId = Brand<string, "PlayerId">;

/**
 * A single physical card. STRUCTURAL, and the single most important type in the file.
 *
 * Audit #121: "Deck's constructor pushes the SAME Card object for every copy of a card, so no
 * card in the game has an identity — which is the root cause of every index-based selection
 * bug." Every one of the 68 cards gets its own uid at deck construction and keeps it for the
 * life of the game. Hands, the draw pile, the discard pile and the voting box all hold uids,
 * never card objects, so a card physically cannot be in two zones at once.
 */
export type CardUid = Brand<string, "CardUid">;

/** A game, keyed by Discord channel. Audit #48: the old bot had one global game per process. */
export type GameId = Brand<string, "GameId">;

/** One Tribal Council instance. Distinguishes "this council" from "a previous council". */
export type CouncilId = Brand<string, "CouncilId">;

/**
 * An open interruptible window. STRUCTURAL: every action that resolves a window must name the
 * exact window it is resolving. Audit #83 ("two steals can be armed at once and one Sorry For
 * You cancels both"), #30/#47 (a channel-wide collector handling someone else's click) and
 * #37 (one handler registered on two collectors) are all unrepresentable once the reply must
 * carry the id of the specific pending it answers.
 */
export type PendingId = Brand<string, "PendingId">;

/**
 * One resolution of one card's effect.
 *
 * WHY: a single Let's Form an Alliance can open TWO `PendingTake`s when the two partners name
 * different victims (the card only says "You CAN steal from the same player"). Both pendings
 * come from the same play and a renderer has to narrate them as one event; without a shared
 * id there is nothing to correlate them by, since the turn steal carries no cardUid at all.
 */
export type EffectId = Brand<string, "EffectId">;

export const asPlayerId = (raw: string): PlayerId => raw as PlayerId;
export const asCardUid = (raw: string): CardUid => raw as CardUid;
export const asGameId = (raw: string): GameId => raw as GameId;
export const asCouncilId = (raw: string): CouncilId => raw as CouncilId;
export const asPendingId = (raw: string): PendingId => raw as PendingId;
export const asEffectId = (raw: string): EffectId => raw as EffectId;

// ---------------------------------------------------------------------------
// Exhaustiveness
// ---------------------------------------------------------------------------

/**
 * The single canonical exhaustiveness helper. Every `switch` over `CardKind`, `ActionKind`,
 * `GameEventType`, `PendingKind`, `CouncilPhase`, `GameStage["kind"]` or `TieBreakTier` ends
 * in `default: return assertNever(x, "...")`.
 *
 * WHY it exists: `noFallthroughCasesInSwitch` does NOT catch a missing case — it catches a
 * non-empty case falling into the next one. The rule that actually enforces exhaustiveness is
 * `@typescript-eslint/switch-exhaustiveness-check`, and it stops checking a switch the moment
 * that switch grows a `default` unless `allowDefaultCaseForExhaustiveSwitch: false` is set
 * (it is). This helper makes the default branch a compile error when a member is unhandled
 * and a loud runtime failure if a value ever arrives from outside the type system.
 *
 * Audit #74: 13 of 47 deck cards had no command implementation at all, and nothing noticed.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Result and errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable failure codes. The Discord layer maps these to copy; the engine never
 * produces player-facing prose.
 *
 * NOTE there is deliberately no `draw_pile_empty`. Draw is the mandatory terminal step of the
 * turn, so a refused draw wedges the game permanently — audit #20 verbatim ("/draw returns
 * 'No cards left in the deck.' … Play cannot continue and cannot conclude"). Drawing from an
 * empty pile always SUCCEEDS and fires `draw_pile_exhausted` plus the exhaustion policy.
 */
export type GameErrorCode =
  // lobby / lifecycle
  | "game_not_found"
  | "game_already_started"
  | "game_not_started"
  | "game_finished"
  | "game_abandoned"
  | "not_enough_players"
  | "too_many_players"
  | "already_joined"
  | "color_taken"
  | "no_colors_available"
  | "not_in_game"
  | "player_eliminated"
  | "player_left_game"
  // authorization. Audit #24: "restrict to the game starter or a mod — any player must not be
  // able to boot a rival." `abandon_game` and `remove_player` are host-gated.
  | "not_authorized"
  | "not_host"
  // turn structure
  | "not_your_turn"
  | "wrong_turn_phase"
  | "steal_step_not_done"
  | "card_already_played_this_turn"
  // cards and targets
  | "card_not_in_hand"
  | "unknown_card_kind"
  | "wrong_card_kind"
  | "card_not_playable_now"
  | "target_required"
  | "invalid_target"
  | "target_not_in_game"
  | "self_target_not_allowed"
  | "duplicate_target"
  | "camp_raid_already_present"
  | "empty_hand"
  // pending windows
  | "pending_not_found"
  | "pending_already_resolved"
  | "not_a_participant"
  | "already_submitted"
  | "wrong_pending_kind"
  // tribal council
  | "not_council_leader"
  | "wrong_council_phase"
  | "stale_phase"
  | "no_council_in_progress"
  | "no_vote_card"
  | "vote_already_cast_with_card"
  | "voting_not_open"
  | "must_cast_mandatory_vote"
  | "no_idol_to_nullify"
  | "idol_already_nullified"
  | "wrong_number_of_choices"
  | "candidate_not_eligible"
  // final council
  | "not_a_juror"
  | "not_a_finalist"
  | "jury_vote_already_cast"
  | "no_tie_to_break"
  // snapshots. Audit #98/#102: the persistence layer's only previous option was
  // `internal_invariant_violated`, which is logged as a crash rather than as a bad file.
  //
  // These three are about a SNAPSHOT and nothing else. `snapshot_malformed` used to double as
  // the code for a malformed custom_id and for a rejected filesystem path, so the one grep an
  // operator runs to find a corrupt save also returned every stale button pressed since the
  // last deploy. The two codes below exist so each of those greps means one thing.
  | "snapshot_version_unsupported"
  | "snapshot_malformed"
  | "snapshot_card_census_mismatch"
  /** A custom_id that does not decode: wrong shape, foreign prefix, unknown step, bad nonce. */
  | "component_malformed"
  /** A game id that may not be turned into a save path (audit #124). */
  | "invalid_game_id"
  /** The bytes did not reach the disk. Distinct from "the bytes on disk are wrong". */
  | "save_write_failed"
  // policy
  | "feature_disabled"
  | "internal_invariant_violated";

export interface GameError {
  readonly code: GameErrorCode;
  /** Developer-facing explanation. The Discord layer renders from `code`, not from this. */
  readonly message: string;
  /** Structured context for logs and for building a better player-facing message. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * The engine returns Result values for every expected rule violation and throws only on a
 * genuine invariant break. Audit #49: the old `checkForError()` mutated player hands while
 * validating, so every rejected command permanently destroyed a card. Validation here can only
 * return a value; it has no state to mutate because the engine treats state as immutable.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GameError };

export type Ok<T> = Extract<Result<T>, { readonly ok: true }>;
export type Err = Extract<Result<never>, { readonly ok: false }>;

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = <T = never>(
  code: GameErrorCode,
  message: string,
  details?: GameError["details"],
): Result<T> => ({
  ok: false,
  error: details ? { code, message, details } : { code, message },
});

export const isOk = <T>(r: Result<T>): r is Ok<T> => r.ok;

// NOTE there is deliberately no combinator kit here any more. `isErr`, `mapOk`, `andThen`,
// `unwrapOr` and `firstErr` were written so that "~30 commands about to be written against this
// type" would share one house style, and then not one command used any of them: every handler
// in `src/commands/**` reads `if (!result.ok) return ctx.reply.fail(result.error);`, which is
// clearer than a combinator chain and needs no vocabulary. Five exported functions reachable
// from nothing is audit #123's category, so they are gone rather than waiting for a caller.

// ---------------------------------------------------------------------------
// Card taxonomy
// ---------------------------------------------------------------------------

/**
 * Every card in the box, including the four types the old `cardlist.json` omitted entirely
 * (Vote, both Tribal Council variants, Inheritance, Survivor Character) and the hidden 68th.
 *
 * STRUCTURAL: audit #93/#122 — the old code identified cards by free-text name compared with
 * `===`, in three different numbering schemes, with `tribalValue` overloaded as both a card
 * type discriminator and a vote count. A string literal is never again a card identifier: it
 * is a `CardKind` or it does not typecheck.
 */
export const CardKind = {
  TribalCouncilSingle: "tribal_council_single",
  TribalCouncilDouble: "tribal_council_double",
  Vote: "vote",
  ExtraVote: "extra_vote",
  ImmunityIdol: "immunity_idol",
  IdolNullifier: "idol_nullifier",
  SorryForYou: "sorry_for_you",
  ControlTheVote: "control_the_vote",
  GoodwillGamble: "goodwill_gamble",
  ImTheLeaderNow: "im_the_leader_now",
  CampRaid: "camp_raid",
  KnowledgeIsPower: "knowledge_is_power",
  TheSpyShack: "the_spy_shack",
  LetsFormAnAlliance: "lets_form_an_alliance",
  Inheritance: "inheritance",
  DoOrDie: "do_or_die",
  PowerPair: "power_pair",
  ItsANumbersGame: "its_a_numbers_game",
  SurvivorCharacter: "survivor_character",
} as const;

export type CardKind = (typeof CardKind)[keyof typeof CardKind];

export const ALL_CARD_KINDS: readonly CardKind[] = Object.values(CardKind);

/** The two card kinds that exist once per player colour. See `ColoredCardInstance`. */
export type ColoredCardKind = Extract<CardKind, "inheritance" | "survivor_character">;

/** The two Tribal Council variants, as their own type — how many players go home. */
export type TribalCouncilKind = "single" | "double";

/**
 * Broad grouping used for hand sorting, rules lookup, and the "Tribal Advantage" window,
 * which the rulebook treats as a category rather than a list of three cards.
 */
export type CardCategory =
  /** Played on your turn as your one card play. */
  | "action"
  /** Vote and Extra Vote — cast into the Voting Box, never shuffled into the draw pile. */
  | "vote"
  /** The oversized deck cards that start a council when drawn. */
  | "tribal_council"
  /** Control the Vote, Goodwill Gamble, I'm the Leader Now — the pre-voting window. */
  | "tribal_advantage"
  /** Do or Die, Power Pair, It's a Numbers Game — simultaneous-reveal minigames. */
  | "reward_challenge"
  /** Immunity Idol and Idol Nullifier — the post-vote, pre-tally window. */
  | "idol"
  /** Sorry For You — playable out of turn in response to an attempted take. */
  | "reaction"
  /** Inheritance — playable out of turn in response to a full elimination. */
  | "inheritance"
  /** Survivor Character Cards. Not in any hand; they sit face up as your two lives. */
  | "character";

/**
 * When a card may legally be played. STRUCTURAL: audit #15 ("Tribal Advantage cards are
 * playable in every council phase, including after voting has closed"), #40 ("vote-granting
 * cards are gated only on `!= NotStarted`") and #69 ("Extra Vote is playable in any council
 * phase"). Each card declares exactly one window; the validator compares the window to the
 * current phase instead of each command re-deriving its own ad-hoc guard.
 */
export type CardTiming =
  /** Not playable from hand by anyone, ever (Tribal Council cards, Character cards). */
  | "never"
  /** Step 2 of your own turn. Consumes your single card play. */
  | "turn_play_step"
  /** Council: from the Leader's opening line until voting begins. Multiple per council. */
  | "council_before_voting"
  /** Council: cast into the box during the voting phase only. */
  | "council_voting"
  /** Council: after every vote is in, before the box is opened. */
  | "council_idol_window"
  /** Council: after an Immunity Idol has been played, still before the tally. */
  | "council_nullifier_window"
  /** Any time someone tries to take cards from you. Not your once-per-turn play. */
  | "reaction_to_take"
  /** The instant a player's second Survivor Character Card is turned over. */
  | "reaction_to_elimination";

/** What a card needs pointed at before it can resolve. */
export type TargetRequirement =
  | { readonly kind: "none" }
  | {
      readonly kind: "one_player";
      readonly allowSelf: boolean;
      /** False for cards that can name a dead colour (nothing does today, but Inheritance might). */
      readonly mustBeInGame: boolean;
    }
  /** Power Pair: "Pick 2 other players." Never yourself, never the same player twice. */
  | { readonly kind: "two_players" }
  /** Let's Form an Alliance: a partner plus your own steal target, which may not be the partner. */
  | { readonly kind: "partner_and_victim" }
  /** Knowledge is Power: a player plus a named card kind. */
  | { readonly kind: "one_player_and_card_kind"; readonly allowSelf: boolean }
  /** It's a Numbers Game: every player in the game participates; nothing is chosen up front. */
  | { readonly kind: "all_players" }
  /** Idol Nullifier: targets a specific Immunity Idol *play*, not a player. */
  | { readonly kind: "played_idol" };

/**
 * A single physical card instance. `uid` is its identity for the whole game.
 *
 * STRUCTURAL: a union rather than one interface with an optional `color`, because colour
 * exists for exactly two of the nineteen kinds and for those two it is MANDATORY. An
 * Inheritance instance built without a colour is now a compile error, and no consumer of
 * `PendingInheritance.color` has to handle an `undefined` the model says cannot happen.
 * Audit #100: the old snapshot linked Inheritance to a Player *object* and silently lost the
 * link whenever the target appeared later in the players array.
 *
 * Use `colorOf(card)` in cards.ts to read the colour off an un-narrowed instance.
 */
export interface PlainCardInstance {
  readonly uid: CardUid;
  readonly kind: Exclude<CardKind, ColoredCardKind>;
}

export interface ColoredCardInstance {
  readonly uid: CardUid;
  readonly kind: ColoredCardKind;
  readonly color: PlayerColor;
}

export type CardInstance = PlainCardInstance | ColoredCardInstance;

/** One line item of an assembled deck: "3 x Camp Raid". Used by the catalog and by events. */
export interface DeckCompositionEntry {
  readonly kind: CardKind;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * The six Survivor colours, in Survival Guide order (dark-red triangle, orange square,
 * magenta swirl, green leaf, teal wave, yellow sun). There are exactly 6 because there are
 * exactly 6 Inheritance cards and 12 Survivor Character Cards.
 */
export type PlayerColor = "red" | "orange" | "magenta" | "green" | "teal" | "yellow";

export const ALL_PLAYER_COLORS: readonly PlayerColor[] = [
  "red",
  "orange",
  "magenta",
  "green",
  "teal",
  "yellow",
];

/**
 * One Survivor Character Card. Two per player. `flipped` means it has been turned over to its
 * printed "VOTED OUT" side — it stays face up and visible (officialgamerules.org gets this
 * wrong and says face down; docs/RULES.md flags it).
 */
export interface CharacterCard {
  readonly uid: CardUid;
  readonly flipped: boolean;
  /** Sequence number of the flip, so the Discord layer can narrate eliminations in order. */
  readonly flippedAtSeq: number | null;
}

export interface Player {
  readonly id: PlayerId;
  readonly displayName: string;
  readonly color: PlayerColor;
  /** Clockwise seat index. Turn order is seat order; play proceeds to the LEFT (seat + 1). */
  readonly seat: number;
  /** Exactly `limits.characterCardsPerPlayer` entries. Both flipped = eliminated. */
  readonly characterCards: readonly CharacterCard[];
  /**
   * Hand contents are PRIVATE; hand SIZE is public. Uids only — see `CardUid`.
   *
   * Extra Vote lives HERE, not in a zone of its own: it is one of the 52 shuffled Action
   * Cards, it is drawn into your hand, and it is physically indistinguishable from any other
   * hand card. That makes it stealable by the turn steal, takeable by The Spy Shack, a legal
   * answer to Knowledge is Power, inheritable, and a legal forced discard — all six of which
   * break the moment it is modelled outside the hand. It also keeps the COUNT of extra votes
   * you hold private, which is the whole reason everyone taps the table in rhythm during the
   * vote "so no one can hear how many votes are being cast" (RULES.md:99, 414).
   */
  readonly hand: readonly CardUid[];
  /**
   * The Vote Card ONLY.
   *
   * Held apart from the hand because it is dealt at setup, never shuffled into the draw pile,
   * recycled to every surviving player after each council, and taken by exactly one card
   * (Control the Vote). Note this is an INTERPRETATION, not a printed rule — see
   * `houseRules.voteCardIsStealable`, which discloses it like every other invented answer.
   */
  readonly voteCards: readonly CardUid[];
  /**
   * Goodwill Gamble cards given TO this player. "This card counts as 1 vote, and MUST be used
   * during the Tribal Council at which it is played (just like a Vote Card)."
   *
   * Its own zone because neither alternative works: in `voteCards` the cleanup step would
   * recycle it as a Vote Card (it must be discarded instead), and in `hand` it would look like
   * a playable action card and be stealable after it was given away.
   */
  readonly grantedVotes: readonly CardUid[];
  /**
   * A Camp Raid marker sitting face up in front of this player, owned by another player.
   * Audit #71/#84/#101: the old code stored a Player object here, allowed stacking, let the
   * raider be overwritten mid-window, and dropped the field entirely on save/load.
   */
  readonly campRaid: CampRaidMarker | null;
  /**
   * Full elimination order. Non-null = both character cards flipped = ON THE JURY.
   * Audit #14/#18/#35: `max(eliminatedAtSeq)` is what derives the Final Council Leader, so
   * every elimination path sets it and none of them has to remember to.
   */
  readonly eliminatedAtSeq: number | null;
  /**
   * Gone from the table entirely: `leave_game` or a host `remove_player`. Distinct from
   * `eliminatedAtSeq` (voted out, therefore ON the jury) and from `connected` (a Discord
   * blip). Audit #24: "Keep the two states distinct." A departed player is on NO jury, is
   * never a vote target, and is skipped by turn order — but is NEVER spliced out of
   * `players`, because that would break `seat` ordering, elimination ordering and every
   * PlayerId reference held in council votes, idol plays, camp raid markers and open pendings.
   */
  readonly leftAtSeq: number | null;
  /** Discord presence, not game state. A disconnected player still holds cards and votes. */
  readonly connected: boolean;
}

/**
 * THE liveness predicate. Every helper that asks "is this player still playing?" reads this
 * one function — turn order, legal steal targets, legal vote targets, the 2-players-remain
 * check, and the required-voter list.
 */
export const isInPlay = (p: Player): boolean =>
  p.eliminatedAtSeq === null && p.leftAtSeq === null;

/** On the Jury: voted out, as opposed to having walked away from the table. */
export const isJuror = (p: Player): boolean =>
  p.eliminatedAtSeq !== null && p.leftAtSeq === null;

export interface CampRaidMarker {
  readonly cardUid: CardUid;
  readonly raiderId: PlayerId;
  readonly placedAtSeq: number;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * Every card that is not in a player's hand, vote zone or granted-vote zone.
 *
 * DRAW PILE ORDER: index 0 is the TOP of the pile (the next card drawn); the last index is the
 * BOTTOM. Audit #7 plus the old `drawCard()`/`getDrawsUntilNextTribalCouncil()` disagreeing
 * about which end was the top. Setup step 5 requires the last element to be a Tribal Council
 * card at every player count, so the final draw of any game always starts a council.
 *
 * CARD CENSUS: every uid in `GameState.cards` is in exactly one of — a player's `hand`,
 * `voteCards` or `grantedVotes`, a player's `characterCards`, or one of the five arrays
 * below. `council.votes[].cardUid` and `council.idolPlays[].cardUid` are REFERENCES into
 * `votingBox` and `inPlay` respectively, never a separate location, so the census still sums
 * to 68 mid-council and an abandoned council cannot orphan a card (audit #75/#121).
 */
export interface Zones {
  readonly drawPile: readonly CardUid[];
  /**
   * Face up and public. Audit #75: the old code had no discard pile at all — every played card
   * was deleted from the game with no record.
   */
  readonly discardPile: readonly CardUid[];
  /**
   * Surplus Vote Cards and unused Tribal Council cards. Setup: "put the extras away — you
   * won't need them." Distinct from the discard pile so the card census still sums to 68.
   */
  readonly removedFromGame: readonly CardUid[];
  /**
   * Vote Cards not currently held by anyone: recycled between councils, since cleanup returns
   * exactly one to every player still holding a Survivor Character Card.
   */
  readonly voteCardBank: readonly CardUid[];
  /**
   * The Voting Box. Cards cast this council, face down. Emptied into the discard pile at
   * cleanup. `CouncilState.votes` holds the voter/target metadata for these same uids.
   */
  readonly votingBox: readonly CardUid[];
  /**
   * Cards face up on the table mid-effect: Camp Raid markers, the active Tribal Council card,
   * played Tribal Advantages, played Immunity Idols and Idol Nullifiers. All move to the
   * discard pile at cleanup.
   */
  readonly inPlay: readonly CardUid[];
}

// ---------------------------------------------------------------------------
// Turn state machine
// ---------------------------------------------------------------------------

/**
 * "Remember: Steal, Play (or don't), then Draw!" Audit #9: the official 3-step turn was not
 * enforced at all. STRUCTURAL: the phase is state, the actions are gated on it, and `draw`
 * is the only terminal step.
 */
export type TurnPhase = "steal" | "play" | "draw" | "ended";

export const TURN_PHASE_ORDER: readonly TurnPhase[] = [
  "steal",
  "play",
  "draw",
  "ended",
];

/**
 * Holds no private information: whose turn it is, which step they are on and which card they
 * played face up are all public by rule. Safe to expose directly on `GameView`.
 */
export interface TurnState {
  readonly playerId: PlayerId;
  readonly phase: TurnPhase;
  /** Step 1 is mandatory: the phase cannot advance to `play` until this is true. */
  readonly stealResolved: boolean;
  /**
   * At most one card per turn (the how-to-play video: "you can't play more than one").
   * Reactions — Sorry For You, Inheritance, idols, Tribal Advantages — never set this.
   */
  readonly cardPlayedThisTurn: CardUid | null;
  readonly startedAtMs: number;
  /** Absolute timestamp. Backstop only; a turn normally ends on the player's draw. */
  readonly deadlineMs: number | null;
  readonly turnNumber: number;
}

// ---------------------------------------------------------------------------
// Tribal Council state machine
// ---------------------------------------------------------------------------

/**
 * Council phases in order.
 *
 * `advantages` and `discussion` are separate states even though the rulebook allows Tribal
 * Advantages throughout both ("you may play it now or anytime before we vote") — the split
 * exists so the Discord layer can show the right prompt. Both accept `council_before_voting`
 * cards; nothing after `voting` opens does.
 */
export type CouncilPhase =
  | "advantages"
  | "discussion"
  | "voting"
  | "idols"
  | "nullifiers"
  | "tally"
  | "tie_break"
  | "cleanup";

export const COUNCIL_PHASE_ORDER: readonly CouncilPhase[] = [
  "advantages",
  "discussion",
  "voting",
  "idols",
  "nullifiers",
  "tally",
  "tie_break",
  "cleanup",
];

/**
 * From `tally` onward the votes are public: the box has been opened. Before that they are the
 * secret ballot and never leave `privateView`. The one place this line is drawn.
 */
export const VOTES_PUBLIC_FROM: CouncilPhase = "tally";

export const councilPhaseAtOrAfter = (
  phase: CouncilPhase,
  marker: CouncilPhase,
): boolean => COUNCIL_PHASE_ORDER.indexOf(phase) >= COUNCIL_PHASE_ORDER.indexOf(marker);

/** Where a vote came from. Each vote is one physical card, tracked by uid. */
export type VoteSource =
  "vote_card" | "extra_vote" | "goodwill_gamble" | "stolen_vote_card";

/**
 * One vote in the box. Carries the uid of the exact card cast, so the tally, the reveal and
 * the cleanup discard all operate on real cards rather than on a counter.
 * Audit #115: the old `/cast_vote` decremented a vote budget and then dropped the vote through
 * an optional chain when the council object was missing.
 *
 * PRIVATE until `VOTES_PUBLIC_FROM`. This type must never appear on `GameView` before then.
 */
export interface CastVoteRecord {
  readonly cardUid: CardUid;
  readonly voterId: PlayerId;
  readonly targetId: PlayerId;
  readonly source: VoteSource;
  /** Order the vote entered the box. Drives the dramatic one-at-a-time reveal. */
  readonly order: number;
}

/**
 * One card a player is OBLIGED to cast this council.
 *
 * STRUCTURAL: the mandatory-cast rule is per-CARD, not per-player. Control the Vote: "You MUST
 * use that Vote Card IN ADDITION TO your Vote Card"; Goodwill Gamble: "MUST be used during the
 * Tribal Council at which it is played". A `PlayerId[]` cannot express "this player owes two
 * casts", so `finish_voting` had nothing to check and `must_cast_mandatory_vote` had nothing
 * to check against.
 */
export interface VoteObligation {
  readonly playerId: PlayerId;
  readonly cardUid: CardUid;
  readonly source: VoteSource;
}

/** A Tribal Advantage that has been played this council. All three are public acts. */
export interface AdvantagePlay {
  readonly cardUid: CardUid;
  readonly kind: Extract<
    CardKind,
    "control_the_vote" | "goodwill_gamble" | "im_the_leader_now"
  >;
  readonly playedBy: PlayerId;
  readonly targetId: PlayerId | null;
  readonly atSeq: number;
}

/**
 * An Immunity Idol play. The idol's own `cardUid` is its identity, which is what a nullifier
 * names — possible only because every card instance is unique.
 */
export interface IdolPlay {
  readonly cardUid: CardUid;
  readonly playedBy: PlayerId;
  /** May be the player themselves or any other player. */
  readonly protects: PlayerId;
  /** The uid of the Idol Nullifier that cancelled this idol, if any. */
  readonly nullifiedBy: CardUid | null;
  readonly atSeq: number;
}

export interface NullifierPlay {
  readonly cardUid: CardUid;
  readonly playedBy: PlayerId;
  readonly targetIdolUid: CardUid;
  readonly atSeq: number;
}

/** Per-player vote count after nullified idols are honoured and immune players zeroed. */
export interface VoteTallyRow {
  readonly playerId: PlayerId;
  /** Raw votes cast at this player, before immunity is applied. */
  readonly rawVotes: number;
  /** Votes that actually count: 0 if protected by a live (non-nullified) idol. */
  readonly countedVotes: number;
  readonly immune: boolean;
  /**
   * The live (non-nullified) idols protecting this player, by uid. Empty unless `immune`.
   * Both the "your votes don't count" render and the tie-break's third rung read this rather
   * than re-deriving the idol set at each call site.
   */
  readonly protectedByIdolUids: readonly CardUid[];
}

/**
 * THE TIE-BREAK LADDER. The single rule the old implementation got most wrong.
 *
 * Rulebook, verbatim: "If it's unclear who is voted out ... the Tribal Council Leader must
 * decide who to vote out using these criteria: First, always choose from the (non-immune)
 * players who got votes. If there aren't any... Choose from the (non-immune) players who got
 * no votes. Finally, if there's not enough of them... Choose from the players who played
 * Immunity Idols."
 *
 * STRUCTURAL: the order lives in exactly one exported constant. An Immunity Idol is NOT
 * absolute protection — tier 3 exists precisely so a council can never end with nobody out.
 *
 * NOTE the third rung's name. The rulebook says the players who PLAYED Immunity Idols, which
 * is NOT the same set as the players PROTECTED by them: if A plays an idol on B, then A is
 * non-immune (and, if A got votes, is a tier-1 candidate) while B is immune. The default
 * reading is the printed one — idol PLAYERS. `houseRules.tieBreakIdolTierIncludesProtected`
 * widens the rung to the union of both sets for tables that read it the other way, and
 * emits `house_rule_applied` when it actually changes the candidate list.
 */
export type TieBreakTier =
  "voted_non_immune" | "unvoted_non_immune" | "played_or_protected_by_idol";

export const TIE_BREAK_LADDER: readonly TieBreakTier[] = [
  "voted_non_immune",
  "unvoted_non_immune",
  "played_or_protected_by_idol",
];

/** Why the Leader is being asked to decide. Renders as different copy; same mechanism. */
export type LeaderDecisionReason =
  /** Single elimination, 2+ tied for most votes. */
  | "tie_for_most"
  /** Double elimination, 3+ tied for most votes: the Leader picks which 2 go. */
  | "double_tie_for_most"
  /** Double elimination, 1 clear first and 2+ tied for second: first goes, Leader picks one. */
  | "double_tie_for_second"
  /** Not enough eligible candidates at the current rung; we have descended the ladder. */
  | "unclear_cascade"
  /** Only 3 players left and 2 would go: rulebook says eliminate ONE, then Final Council. */
  | "three_player_double_override";

export interface CouncilState {
  readonly id: CouncilId;
  readonly kind: TribalCouncilKind;
  /** The physical Tribal Council card that started this council; discarded during cleanup. */
  readonly cardUid: CardUid;
  readonly phase: CouncilPhase;
  /** Who drew the card. Stays fixed even if the Leader is usurped. */
  readonly drawerId: PlayerId;
  /** Current Leader. Equals `drawerId` unless "I'm the Leader Now" was played. */
  readonly leaderId: PlayerId;
  /**
   * Set by "I'm the Leader Now": "It's your turn when the Tribal Council ends (or the player
   * after you if you are eliminated)." Audit #70: the old code implemented only half the card
   * and never granted the next turn. Null = default rule, i.e. the player to the Leader's left.
   */
  readonly nextTurnOverride: PlayerId | null;
  readonly advantagesPlayed: readonly AdvantagePlay[];
  /** PRIVATE until `VOTES_PUBLIC_FROM`. See `CouncilView` for what the channel may see. */
  readonly votes: readonly CastVoteRecord[];
  /** Players who have declared they are finished adding Extra Votes. */
  readonly finishedVoting: readonly PlayerId[];
  /**
   * Cards that MUST be cast before voting can close: one entry per obligated card, not per
   * player. `finish_voting` is refused with `must_cast_mandatory_vote` while a player still
   * has an entry here.
   */
  readonly requiredCasts: readonly VoteObligation[];
  readonly idolPlays: readonly IdolPlay[];
  readonly nullifierPlays: readonly NullifierPlay[];
  /** Null until the `tally` phase computes it. */
  readonly tally: readonly VoteTallyRow[] | null;
  /**
   * Players whose Survivor Character Card has already been FLIPPED by this council — not
   * necessarily eliminated. A double elimination must hit "2 DIFFERENT players", and that rule
   * is about flips: a two-torch player who is flipped is still in the game but must be
   * excluded from the second elimination. The Final Tribal Council can also interrupt between
   * the first flip and the second (audit #12, #14, #21).
   */
  readonly flippedThisCouncil: readonly PlayerId[];
  /** How many players still have to be voted out: 1 for single, 2 for double, decremented. */
  readonly eliminationsRemaining: number;
  readonly phaseEnteredAtMs: number;
  /** Absolute deadline for the current phase. Backstop only — the Leader drives the council. */
  readonly phaseDeadlineMs: number | null;
}

// ---------------------------------------------------------------------------
// Final Tribal Council state machine
// ---------------------------------------------------------------------------

/**
 * "The moment there are only 2 players left in the game, regardless of how many Survivor
 * Character Cards they have left." Audit #1-#5, #18, #35, #56: in the old code the endgame was
 * literally unreachable — nothing ever wrote a jury vote, `/cast_vote` hard-rejected the FINAL
 * state, and `finalTribalLeader` was assigned on exactly one of four paths.
 */
export type FinalCouncilPhase =
  /** The Leader asks the three scripted questions. */
  | "opening"
  /** The finalists make their cases and may reveal their hands (they may play no cards). */
  | "statements"
  /** Jury members ask questions or make their own cases. */
  | "jury_questions"
  /** Every juror votes FOR a finalist, simultaneously and publicly. */
  | "jury_vote"
  /** Even jury, even split: the Leader picks, and need not stick with their own vote. */
  | "tie_break"
  | "complete";

export const FINAL_COUNCIL_PHASE_ORDER: readonly FinalCouncilPhase[] = [
  "opening",
  "statements",
  "jury_questions",
  "jury_vote",
  "tie_break",
  "complete",
];

/** The Final Tribal Council only ever runs forward. The one place that is written down. */
export const finalPhaseAtOrAfter = (
  phase: FinalCouncilPhase,
  marker: FinalCouncilPhase,
): boolean =>
  FINAL_COUNCIL_PHASE_ORDER.indexOf(phase) >= FINAL_COUNCIL_PHASE_ORDER.indexOf(marker);

export interface JuryVote {
  readonly jurorId: PlayerId;
  readonly finalistId: PlayerId;
  /** Jury votes are public and simultaneous — no Voting Box, no secret ballot. */
  readonly atSeq: number;
}

export interface FinalCouncilState {
  readonly phase: FinalCouncilPhase;
  /**
   * "The player most recently eliminated is a member of the Jury AND the Final Tribal Council
   * Leader." Derived from the maximum `eliminatedAtSeq`, so every elimination path sets it.
   *
   * NON-NULLABLE, and that is an invariant the engine upholds rather than an assumption: a
   * Final Tribal Council is only ever opened when `jury.length >= 1`. The two routes that
   * could reach two players with an empty jury are both closed elsewhere —
   *   * draw-pile exhaustion FULLY eliminates every non-finalist first, so they join the jury
   *     through the normal `player_eliminated` path (see `drawPileExhaustionPolicy`);
   *   * a `remove_player` / `leave_game` that leaves 2 players and an empty jury does NOT open
   *     a Final Council at all — the game ends immediately, `winner_declared` with method
   *     `sole_survivor` for whoever holds more Survivor Character Cards, or with no winner if
   *     they are level.
   * See ARCHITECTURE.md §4.
   */
  readonly leaderId: PlayerId;
  readonly finalists: readonly [PlayerId, PlayerId];
  /** Every fully-eliminated player, including the Leader. Never a departed player. */
  readonly jury: readonly PlayerId[];
  readonly readyJurors: readonly PlayerId[];
  /** PRIVATE until every juror has voted. See `FinalCouncilView`. */
  readonly juryVotes: readonly JuryVote[];
  /** Finalists may reveal their hands as evidence but may play no cards — all are inert. */
  readonly revealedHands: readonly PlayerId[];
  /**
   * The one authoritative winner field while a Final Council is live. At the transition to
   * `stage: {kind:'finished'}` it is copied once into `GameStage`, and this object goes away.
   */
  readonly winnerId: PlayerId | null;
  readonly winnerDecidedByLeaderTieBreak: boolean;
  readonly phaseEnteredAtMs: number;
  readonly phaseDeadlineMs: number | null;
}

// ---------------------------------------------------------------------------
// Pending windows: the interruption / simultaneous-choice model
// ---------------------------------------------------------------------------

export type PendingStatus = "open" | "resolved" | "cancelled" | "expired";

export const isPendingOpen = (p: Pending): boolean => p.status === "open";

/**
 * Why cards are moving. Sorry For You cares about this because the Survival Guide enumerates
 * exactly which movements count as a "take", and because the multi-player clause ("each of
 * those players gets nothing, and must EACH discard 1") only applies to some of them.
 *
 * Every variant carries an `effectId` so two pendings born of one card play (a Let's Form an
 * Alliance whose partners named different victims) can be correlated by a renderer. The turn
 * steal has no cardUid, which is exactly why the correlator cannot be the card.
 */
export type TakeOrigin =
  /** Turn step 1. Mandatory, random, one card. */
  | { readonly kind: "turn_steal"; readonly effectId: EffectId }
  /** The Spy Shack: look at a hand, then take a chosen card. */
  | {
      readonly kind: "spy_shack";
      readonly effectId: EffectId;
      readonly cardUid: CardUid;
    }
  /** Knowledge is Power: "they must give you 1" — blockable only per house rule. */
  | {
      readonly kind: "knowledge_is_power";
      readonly effectId: EffectId;
      readonly cardUid: CardUid;
      readonly named: CardKind;
    }
  /** Let's Form an Alliance: two takers, one Sorry For You blanks both. */
  | {
      readonly kind: "alliance";
      readonly effectId: EffectId;
      readonly cardUid: CardUid;
      readonly partnerId: PlayerId;
    }
  /** Camp Raid resolving at the end of the victim's turn. `cardUid` is the MARKER card. */
  | {
      readonly kind: "camp_raid";
      readonly effectId: EffectId;
      readonly cardUid: CardUid;
    }
  /**
   * Control the Vote taking a Vote Card. "…to TAKE any player's Vote Card" versus Sorry For
   * You's "ANY time someone tries to TAKE cards from you" — the pair is unaddressed by the
   * printed rules, so it is a disclosed house rule
   * (`houseRules.sorryForYouBlocksControlTheVote`) rather than an omission.
   */
  | {
      readonly kind: "control_the_vote";
      readonly effectId: EffectId;
      readonly cardUid: CardUid;
    }
  /** Reward Challenge payouts. */
  | {
      readonly kind: "challenge";
      readonly effectId: EffectId;
      readonly challenge: ChallengeKind;
      readonly cardUid: CardUid;
    };

/**
 * How many cards move and how they are selected.
 *
 * `specific` exists for Camp Raid, which takes one EXACT card — the one the victim just drew
 * and looked at — and for Control the Vote, which takes a named Vote Card. Neither is
 * expressible as a count plus a boolean.
 */
export type TakeSpec =
  /**
   * The taker gets `count` cards chosen at random from the victim's hand. Every steal is
   * random EXCEPT The Spy Shack, the Do or Die tie swap and — when
   * `houseRules.allianceStealIsRandom` is false — Let's Form an Alliance.
   */
  | { readonly kind: "random"; readonly count: number }
  /** The taker picks, having been shown the hand (The Spy Shack, the Do or Die tie swap). */
  | { readonly kind: "chosen"; readonly count: number }
  /** These exact cards and no others (Camp Raid, Control the Vote). */
  | { readonly kind: "specific"; readonly cardUids: readonly CardUid[] };

export const takeCount = (spec: TakeSpec): number =>
  spec.kind === "specific" ? spec.cardUids.length : spec.count;

/**
 * An attempted take, open for a Sorry For You response.
 *
 * STRUCTURAL, replacing the old two-boolean `Interruption` global. Audit #28 ("the poller can
 * exit its loop normally while `stopped` is true"), #29 (a 15s timer that was never cleared
 * and later clobbered an unrelated interruption), #51 (a 28-line busy-wait copy-pasted into
 * three files that had already diverged), #53 (lost-wakeup race). There is no poll and no
 * boolean pair: a pending has exactly one terminal `status`, it is addressed by `PendingId`,
 * many may be open at once without interfering, and it expires inside `tick()` rather than
 * inside a `setTimeout` that outlives its interaction.
 *
 * GROUPING INVARIANT — exactly one PendingTake per (effect instance, victim).
 * `takerIds` holds every taker acting against THIS victim in THIS effect. Let's Form an
 * Alliance therefore opens ONE pending when both partners name the same victim and TWO
 * (sharing an `effectId`) when they name different ones. Getting this wrong silently degrades
 * the Survival Guide's most-quoted clause — "each of those players gets nothing, and must EACH
 * discard 1 card instead" — into one blocked thief and one discard. Both shapes have engine
 * tests.
 */
export interface PendingTake {
  readonly kind: "take";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly origin: TakeOrigin;
  /** One taker normally; two for Let's Form an Alliance and Power Pair. */
  readonly takerIds: readonly PlayerId[];
  readonly victimId: PlayerId;
  readonly spec: TakeSpec;
  /** Set when a Sorry For You lands, so the renderer can name the blocking card. */
  readonly blockedByCardUid: CardUid | null;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/** A forced discard: the Sorry For You penalty, or Power Pair's all-same outcome. */
export interface PendingDiscard {
  readonly kind: "discard";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly playerId: PlayerId;
  readonly count: number;
  readonly reason: "sorry_for_you_penalty" | "power_pair_all_same";
  readonly chosen: readonly CardUid[];
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

export type ChallengeKind = "do_or_die" | "power_pair" | "its_a_numbers_game";

export type RpsThrow = "rock" | "paper" | "scissors";

/** Power Pair uses 1-3; It's a Numbers Game uses 1-5. */
export type FingerCount = 1 | 2 | 3 | 4 | 5;

export type ChallengeSubmission =
  | { readonly kind: "rps"; readonly throw: RpsThrow }
  | { readonly kind: "fingers"; readonly count: FingerCount };

/**
 * One participant's slot in a challenge. Kept as an array of entries rather than a keyed
 * object so the whole thing JSON round-trips with no key-ordering or prototype surprises.
 * `submission` stays null — and invisible to everyone — until every slot is filled. It must
 * never reach `GameView`; `PendingView.submittedPlayerIds` carries the only public fact,
 * which is THAT a player has submitted.
 */
export interface ChallengeSlot {
  readonly playerId: PlayerId;
  readonly submission: ChallengeSubmission | null;
  readonly submittedAtSeq: number | null;
}

/**
 * Simultaneous secret submissions from N players.
 *
 * `round` exists because two of the three challenges replay on an indecisive outcome — Power
 * Pair ("If everyone shows a different number of fingers, play again") and It's a Numbers Game
 * ("If necessary, repeat until there's a single winner"). Do or Die never replays: a tie is a
 * defined outcome, a mutual chosen-card swap.
 */
export interface PendingChallenge {
  readonly kind: "challenge";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly challenge: ChallengeKind;
  readonly cardUid: CardUid;
  readonly initiatorId: PlayerId;
  readonly slots: readonly ChallengeSlot[];
  readonly round: number;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/**
 * A player must pick a specific card: The Spy Shack's chosen steal, or either side of the
 * Do or Die tie swap. Audit #39/#50: the old collectors spliced by an array index captured up
 * to 60 seconds earlier against a live, concurrently-mutated hand. A uid cannot go stale.
 */
export interface PendingCardChoice {
  readonly kind: "card_choice";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly chooserId: PlayerId;
  readonly fromPlayerId: PlayerId;
  readonly reason: "spy_shack_take" | "do_or_die_swap" | "alliance_take";
  /**
   * The uids the chooser is allowed to pick from, snapshotted when the window opened. This is
   * literally another player's hand: PRIVATE to the chooser, and never on `GameView`.
   */
  readonly options: readonly CardUid[];
  readonly chosen: CardUid | null;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/** Let's Form an Alliance: the partner names their own victim ("you can't steal from each other"). */
export interface PendingAllianceTarget {
  readonly kind: "alliance_target";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly cardUid: CardUid;
  readonly effectId: EffectId;
  readonly initiatorId: PlayerId;
  readonly partnerId: PlayerId;
  readonly forbiddenTargets: readonly PlayerId[];
  readonly chosen: PlayerId | null;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/** It's a Numbers Game: the winner picks whom to steal 2 random cards from. */
export interface PendingStealVictim {
  readonly kind: "steal_victim";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly chooserId: PlayerId;
  readonly cardUid: CardUid;
  readonly effectId: EffectId;
  readonly count: number;
  readonly chosen: PlayerId | null;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/**
 * The Leader's tie-break / "unclear who is voted out" decision.
 *
 * `tier` and `candidates` are computed by walking `TIE_BREAK_LADDER` and stopping at the first
 * rung with anyone on it; the Leader may only choose from `candidates`, so the ladder cannot
 * be skipped by a UI that offers the wrong list. Audit #31/#32/#77: the old tie path had no
 * timeout, no abort, no admin reset and no re-entrancy guard — two clicks each decremented a
 * life.
 */
export interface PendingLeaderDecision {
  readonly kind: "leader_decision";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly leaderId: PlayerId;
  readonly reason: LeaderDecisionReason;
  readonly tier: TieBreakTier;
  readonly candidates: readonly PlayerId[];
  /** How many players the Leader must name. 1 normally; 2 for a 3+-way double-elim tie. */
  readonly choose: number;
  readonly chosen: readonly PlayerId[];
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/**
 * The window after a full elimination in which the holder of the matching-colour Inheritance
 * card may claim the whole hand. Audit #8/#26/#55: Inheritance had no timing window, never
 * consumed the card, skipped half the inherited hand, and replied twice.
 *
 * WHAT TRANSFERS, and what does not. The card says "You get all of the cards in their HAND",
 * so `hand` — Extra Votes included, since they live in the hand — is the whole of it. The
 * publisher does not address the rest (RULES.md:318 flags all three), so the engine states
 * its answers here rather than inventing them at the call site:
 *   * `voteCards` return to `zones.voteCardBank` — they are table property, recycled each
 *     council, and a dead player holding one would block voting from ever closing (audit #23).
 *   * `grantedVotes` (a Goodwill Gamble given to the dead player) go to the discard pile:
 *     the card is spent, not recycled.
 *   * a Camp Raid marker in front of the dead player is cancelled — `pending_cancelled` with
 *     reason `player_eliminated`.
 */
export interface PendingInheritance {
  readonly kind: "inheritance";
  readonly id: PendingId;
  readonly status: PendingStatus;
  readonly eliminatedPlayerId: PlayerId;
  readonly color: PlayerColor;
  /**
   * Snapshot of the hand at elimination, so a late claim cannot take cards moved since.
   * PRIVATE: this is a full hand, and never appears on `GameView`.
   */
  readonly hand: readonly CardUid[];
  readonly claimedBy: PlayerId | null;
  /**
   * What `releaseTableCards` actually took off the table when this player was eliminated,
   * carried here because `hand_discarded_on_elimination` is emitted when this window CLOSES —
   * a later dispatch, by which time the cards have long since moved. Without them the report's
   * two counters were structurally dead and could only ever say 0.
   */
  readonly voteCardsReturned: number;
  readonly grantedVotesDiscarded: number;
  /**
   * The `FinalCouncilTrigger` the elimination was carrying when this window deferred the
   * endgame check ("You can IMMEDIATELY play this card", so the claim lands first). Recomputing
   * it on the way out cannot see what the caller knew — a three-player override narrated as an
   * ordinary partial double elimination purely because somebody happened to hold the dead
   * player's colour. Provenance only; it never decides anything (see `FinalCouncilTrigger`).
   */
  readonly deferredTrigger: FinalCouncilTrigger;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

export type Pending =
  | PendingTake
  | PendingDiscard
  | PendingChallenge
  | PendingCardChoice
  | PendingAllianceTarget
  | PendingStealVictim
  | PendingLeaderDecision
  | PendingInheritance;

export type PendingKind = Pending["kind"];

/**
 * COMPILE-TIME LINK between the pending kinds and their configured windows.
 *
 * `TimingConfig.pendingWindows` is keyed by `PendingWindowKind`, declared independently in
 * config.ts so that config.ts still imports nothing. If the two ever diverge — a ninth pending
 * kind with no window, which is how audit #95 comes back — this alias fails to typecheck.
 */
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
type Assert<T extends true> = T;
export type PendingWindowsCoverEveryPendingKind = Assert<
  MutuallyAssignable<PendingKind, PendingWindowKind>
>;

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export type GameStatus = "lobby" | "active" | "finished" | "abandoned";

/**
 * What the game is doing right now, WITH the state that phase requires.
 *
 * STRUCTURAL, and the payloads are the whole point. The old code carried `active`,
 * `tribalCouncilState`, `tribalCouncil` and `finalTribalLeader` as four independent fields,
 * and audit #33/#36/#59 are all cases of them disagreeing. A payload-free union would have
 * changed nothing: `{ stage: {kind:'council'}, council: null }` is audit #59 exactly, and
 * `{ status:'finished', stage:{kind:'council'} }` is audit #36 exactly. Both are now type
 * errors, and there is exactly ONE place a winner can be written.
 *
 * `status` and the payload accessors below are derived, never stored.
 */
export type GameStage =
  | { readonly kind: "lobby" }
  | { readonly kind: "turn"; readonly turn: TurnState }
  /** A council always interrupts somebody's turn; the turn resumes at cleanup. */
  | {
      readonly kind: "council";
      readonly turn: TurnState;
      readonly council: CouncilState;
    }
  | { readonly kind: "final_council"; readonly finalCouncil: FinalCouncilState }
  | {
      readonly kind: "finished";
      /** Copied once from `FinalCouncilState.winnerId`. Null = the game ended with no winner. */
      readonly winnerId: PlayerId | null;
      readonly finishedAtMs: number;
    }
  | {
      readonly kind: "abandoned";
      readonly abandonedAtMs: number;
      readonly abandonedById: PlayerId;
    };

export type GameStageKind = GameStage["kind"];

export const statusOf = (stage: GameStage): GameStatus => {
  switch (stage.kind) {
    case "lobby":
      return "lobby";
    case "turn":
    case "council":
    case "final_council":
      return "active";
    case "finished":
      return "finished";
    case "abandoned":
      return "abandoned";
    default:
      return assertNever(stage, "statusOf");
  }
};

export const winnerIdOf = (stage: GameStage): PlayerId | null => {
  switch (stage.kind) {
    case "finished":
      return stage.winnerId;
    case "final_council":
      return stage.finalCouncil.winnerId;
    case "lobby":
    case "turn":
    case "council":
    case "abandoned":
      return null;
    default:
      return assertNever(stage, "winnerIdOf");
  }
};

export const turnOf = (stage: GameStage): TurnState | null =>
  stage.kind === "turn" || stage.kind === "council" ? stage.turn : null;

export const councilOf = (stage: GameStage): CouncilState | null =>
  stage.kind === "council" ? stage.council : null;

export const finalCouncilOf = (stage: GameStage): FinalCouncilState | null =>
  stage.kind === "final_council" ? stage.finalCouncil : null;

/**
 * A hand this player was legitimately shown, recorded so that `PrivateView.revealedToMe`
 * survives `snapshot()`/`restore()` instead of living in some renderer's message history.
 * Audit #27/#59/#101 are all "state that silently evaporates across save/load".
 */
export interface RevealRecord {
  readonly ownerId: PlayerId;
  readonly viewerId: PlayerId;
  readonly cardUids: readonly CardUid[];
  readonly atSeq: number;
  readonly reason: "spy_shack" | "finalist_reveal";
}

export interface GameState {
  readonly gameId: GameId;
  /**
   * Whoever is running the game — the player who created it, or whoever the role has since
   * passed to. `abandon_game`, `remove_player` and `transfer_host` are gated on this (plus, for
   * `abandon_game` only, a Discord-side moderator override); every other player attempting them
   * gets `not_host`. Audit #24: "any player must not be able to boot a rival."
   *
   * INVARIANT: the host is a player at this table for as long as there is one. `leave_game` and
   * `remove_player` pass the role on rather than leaving it pointing at somebody who is gone —
   * a lobby whose host had walked out could never be begun by anyone. There is deliberately no
   * second authorization list beside this field: an always-empty `coHostIds` was checked by
   * `requireHost` and populated by nothing, which is the exact shape audit #24 is about.
   */
  readonly hostId: PlayerId;
  /** Phase AND that phase's state, in one field. See `GameStage`. */
  readonly stage: GameStage;
  /**
   * The config the game was STARTED under, embedded in state. A mid-session config change must
   * never retroactively alter a game in progress, and a snapshot must replay identically.
   * AUTHORITATIVE on restore — see `RestoreGame`.
   */
  readonly config: EngineConfig;
  readonly rng: RngState;
  /** Monotonic mutation counter. Every event and every ordering field is stamped from it. */
  readonly seq: number;
  /**
   * Seat order == clockwise table order. Never reordered, and never spliced, after
   * `start_game` — a departed player keeps their seat and their `leftAtSeq` instead, so every
   * PlayerId reference held elsewhere in state stays resolvable.
   */
  readonly players: readonly Player[];
  /** The card registry: the single definition of every uid in the game. */
  readonly cards: readonly CardInstance[];
  readonly zones: Zones;
  /**
   * Every interruption window. Addressed by id; several may be open at once.
   *
   * PRUNING INVARIANT: an entry is removed from this array as soon as it reaches a terminal
   * `status`, so `pending.filter(isPendingOpen).length === pending.length` always holds and a
   * snapshot cannot accumulate a season's worth of dead windows. The record of what happened
   * lives in the event log, not here.
   */
  readonly pending: readonly Pending[];
  /** Hands legitimately shown to another player this game. See `RevealRecord`. */
  readonly reveals: readonly RevealRecord[];
  readonly playerCount: PlayerCount | null;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
}

/** The format version of `GameSnapshot`. Bump on any breaking change to `GameState`. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * A versioned, self-describing save. Audit #98/#102: the old format had no schema version and
 * no validation, and two mutually incompatible files already sat on disk.
 *
 * The version lives in the ENGINE (`SNAPSHOT_SCHEMA_VERSION`), not in `config.autosave`,
 * because `parseSnapshot`/`restoreGame` are the functions that must reject an unsupported one
 * and they are never handed an `AutosaveConfig`.
 */
export interface GameSnapshot {
  readonly schemaVersion: number;
  readonly savedAtMs: number;
  readonly state: GameState;
}

// ---------------------------------------------------------------------------
// Views (what the Discord layer is allowed to render)
// ---------------------------------------------------------------------------

/**
 * STRUCTURAL enforcement of the three social rules: "You CAN'T give another player a card
 * unless a card makes you. You CAN'T show another player your cards unless a card makes you.
 * You CAN'T hide how many cards you have."
 *
 * Hand SIZE is here. Hand CONTENTS are not — they live only in `PrivateView`, which the
 * renderer can only obtain for one viewer at a time. Audit #126 also ran the other way: public
 * information (hand sizes, turn order, upcoming councils) was sent ephemerally.
 *
 * There is deliberately NO extra-vote count: Extra Vote is an ordinary hand card, and how many
 * votes you are holding is exactly what the table-tapping rhythm exists to hide.
 */
export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly displayName: string;
  readonly color: PlayerColor;
  readonly seat: number;
  readonly handSize: number;
  /** 0 or 1 in normal play; 2 while holding a Vote Card taken by Control the Vote. */
  readonly voteCardCount: number;
  /** Goodwill Gamble cards given to this player. Public: giving one is a public act. */
  readonly grantedVoteCount: number;
  /** Character cards are face up at all times: who has one torch left is public. */
  readonly charactersRemaining: number;
  readonly eliminated: boolean;
  /** Left the table (quit or host-removed). Not on the jury. */
  readonly departed: boolean;
  readonly campRaidBy: PlayerId | null;
  readonly isCurrentPlayer: boolean;
  readonly isCouncilLeader: boolean;
  readonly isHost: boolean;
  readonly connected: boolean;
}

/**
 * The council, redacted for the channel.
 *
 * STRUCTURAL: this type exists so that `CouncilState` — which holds the secret ballot — has no
 * path to a public renderer. `revealedVotes` is null until the box is opened at
 * `VOTES_PUBLIC_FROM`; before that the only public fact about the votes is how many are in.
 * Audit #119/#126 were both ad-hoc-visibility bugs, and re-exporting engine state from the
 * view API would have re-admitted the whole family through the front door.
 */
export interface CouncilView {
  readonly id: CouncilId;
  readonly kind: TribalCouncilKind;
  readonly phase: CouncilPhase;
  readonly drawerId: PlayerId;
  readonly leaderId: PlayerId;
  /** Playing a Tribal Advantage is a public act; so is playing an idol or a nullifier. */
  readonly advantagesPlayed: readonly AdvantagePlay[];
  readonly idolPlays: readonly IdolPlay[];
  readonly nullifierPlays: readonly NullifierPlay[];
  /** How many cards are in the box. Never who put them there or who they name. */
  readonly voteCount: number;
  readonly requiredVoterIds: readonly PlayerId[];
  readonly remainingVoterIds: readonly PlayerId[];
  /** Non-null ONLY from `tally` onward: the box has been opened. */
  readonly revealedVotes: readonly CastVoteRecord[] | null;
  readonly tally: readonly VoteTallyRow[] | null;
  readonly flippedThisCouncil: readonly PlayerId[];
  readonly eliminationsRemaining: number;
  readonly phaseDeadlineMs: number | null;
}

/**
 * The Final Tribal Council, redacted. `juryVotes` stays null until the phase reaches
 * `complete`: the whole point is the simultaneous "3… 2… 1…" reveal (ARCHITECTURE.md §4).
 */
export interface FinalCouncilView {
  readonly phase: FinalCouncilPhase;
  readonly leaderId: PlayerId;
  readonly finalists: readonly [PlayerId, PlayerId];
  readonly jury: readonly PlayerId[];
  readonly readyJurors: readonly PlayerId[];
  readonly revealedHands: readonly PlayerId[];
  /** How many jurors have voted. Never for whom, until the reveal. */
  readonly castCount: number;
  readonly juryVotes: readonly JuryVote[] | null;
  readonly winnerId: PlayerId | null;
  readonly winnerDecidedByLeaderTieBreak: boolean;
  readonly phaseDeadlineMs: number | null;
}

/**
 * An open window, redacted. Carries who is being waited on and until when, and NOT: the
 * challenge submissions (simultaneity is the entire point of all three Reward Challenges), the
 * card-choice options (another player's hand, which the spy alone may see), or the snapshotted
 * hand of an eliminated player.
 */
export interface PendingView {
  readonly id: PendingId;
  readonly kind: PendingKind;
  readonly status: PendingStatus;
  readonly waitingOnIds: readonly PlayerId[];
  /** Challenge only: THAT these players have submitted. Never WHAT. Empty for other kinds. */
  readonly submittedPlayerIds: readonly PlayerId[];
  /** How many cards or choices this window is about (take count, discard count, `choose`). */
  readonly count: number;
  readonly openedAtMs: number;
  readonly deadlineMs: number;
}

/**
 * Public state, safe to post in-channel — and structurally incapable of carrying anything
 * else, because every nested type here is a redacted projection rather than an alias of engine
 * state. The full `CouncilState` / `FinalCouncilState` / `Pending` objects are reachable only
 * from `state()` (engine and persistence) and from `privateView(viewer)`.
 */
export interface GameView {
  readonly gameId: GameId;
  readonly status: GameStatus;
  readonly stage: GameStageKind;
  readonly hostId: PlayerId;
  readonly players: readonly PublicPlayerView[];
  readonly drawPileSize: number;
  readonly discardPileSize: number;
  readonly topOfDiscard: CardInstance | null;
  /**
   * Public by rule: Tribal Council cards are oversized "so you always know when the next
   * Tribal Council is coming". Distances from the top of the draw pile, ascending.
   */
  readonly drawsUntilCouncils: readonly number[];
  /** Whose turn and which of the three steps. Holds nothing private. */
  readonly turn: TurnState | null;
  readonly council: CouncilView | null;
  readonly finalCouncil: FinalCouncilView | null;
  readonly openPending: readonly PendingView[];
  readonly winnerId: PlayerId | null;
}

/** Everything a single player may see that others may not. */
export interface PrivateView {
  readonly viewer: PlayerId;
  /** Includes any Extra Vote cards: they are ordinary hand cards. */
  readonly hand: readonly CardInstance[];
  readonly voteCards: readonly CardInstance[];
  /** Goodwill Gamble cards handed to this player, which they MUST cast this council. */
  readonly grantedVotes: readonly CardInstance[];
  /** This player's own votes in the current council, before the box is opened. */
  readonly myVotes: readonly CastVoteRecord[];
  /** Open windows this player is being waited on for, with their private payloads. */
  readonly myPending: readonly Pending[];
  /**
   * Hands this player has legitimately been shown this game (The Spy Shack, a revealed
   * finalist hand). Backed by `GameState.reveals`, so it survives a snapshot round-trip.
   * Data only; the renderer decides whether it is still worth showing.
   */
  readonly revealedToMe: readonly {
    readonly ownerId: PlayerId;
    readonly atSeq: number;
    readonly cards: readonly CardInstance[];
  }[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface ActionBase {
  /** Who is attempting this. Always validated against turn/leader/participant rules. */
  readonly actor: PlayerId;
}

/** Lobby and lifecycle. */
export interface JoinGameAction extends ActionBase {
  readonly type: "join_game";
  readonly displayName: string;
  readonly color?: PlayerColor;
}
export interface LeaveGameAction extends ActionBase {
  readonly type: "leave_game";
}
export interface ChooseColorAction extends ActionBase {
  readonly type: "choose_color";
  readonly color: PlayerColor;
}
export interface StartGameAction extends ActionBase {
  readonly type: "start_game";
  /** Setup step 7: "Pick a player to go first." Omitted = the engine picks with the RNG. */
  readonly firstPlayer?: PlayerId;
}
/**
 * Audit #19: there was no way to reset, abandon or end a game short of restarting the process.
 * HOST-GATED: rejected with `not_host` for anyone but `hostId` (the Discord layer may
 * additionally admit a guild moderator — see ARCHITECTURE.md §1 and `viaModerator` below).
 */
export interface AbandonGameAction extends ActionBase {
  readonly type: "abandon_game";
  /**
   * The moderator escape hatch, asserted by the Discord layer.
   *
   * ARCHITECTURE.md §1: "The Discord layer may additionally admit a guild moderator, and when
   * it does it passes the moderator's id as the actor and records it — the engine's check is on
   * the id it is given." Without this flag that sentence describes something the engine cannot
   * do: `requireHost` knows only `hostId`, so a moderator dispatching with their own id was
   * always refused `not_host` and the hatch of audit #24 did nothing. The alternative — the
   * Discord layer re-dispatching as the host — is worse than useless: it makes the engine name
   * the wrong person in `stage.abandonedById` and in the public narration.
   *
   * The engine does not (and cannot) verify a Discord permission. This is the trusted layer
   * SAYING it checked Manage Server, and the engine's part of the bargain is to record the
   * moderator as the actor — `stage.abandonedById` and `game_abandoned.byId` both name them —
   * so the fact never has to be reconstructed from a log. Nothing else in the union takes this
   * flag: `remove_player` stays host-only, because booting a rival is the defect audit #24 was
   * reported about.
   */
  readonly viaModerator?: boolean;
}
/** Audit #24: no way to remove, replace or drop a player mid-game. HOST-GATED. */
export interface RemovePlayerAction extends ActionBase {
  readonly type: "remove_player";
  readonly target: PlayerId;
}
/**
 * Hand the host role to another player at this table. HOST-GATED.
 *
 * The engine already passes the role on by itself when the host leaves or is removed, which is
 * what keeps a lobby from dead-ending. This is the DELIBERATE version of the same move: a host
 * who is still at the fire but is about to go quiet, or who simply wants somebody else running
 * the game, should not have to leave the table to hand it over — and "leave, then re-join"
 * would put them at the back of the seat order mid-game.
 *
 * The target must be at the table and still in play. There is no moderator override here: a
 * moderator taking the role for themselves is booting a rival by a longer route (audit #24),
 * and the hatch a moderator legitimately needs — ending a wedged game — is `abandon_game`.
 */
export interface TransferHostAction extends ActionBase {
  readonly type: "transfer_host";
  readonly target: PlayerId;
}

/** Turn step 1 — mandatory. */
export interface StealRandomAction extends ActionBase {
  readonly type: "steal_random";
  readonly target: PlayerId;
}

/** Turn step 2 — optional, at most one. */
export interface PlayCampRaidAction extends ActionBase {
  readonly type: "play_camp_raid";
  readonly cardUid: CardUid;
  readonly target: PlayerId;
}
export interface PlayKnowledgeIsPowerAction extends ActionBase {
  readonly type: "play_knowledge_is_power";
  readonly cardUid: CardUid;
  readonly target: PlayerId;
  /** A CardKind, never free text. Audit #80/#91: a case-sensitive typo burned the card. */
  readonly named: CardKind;
}
export interface PlaySpyShackAction extends ActionBase {
  readonly type: "play_spy_shack";
  readonly cardUid: CardUid;
  readonly target: PlayerId;
}
export interface PlayAllianceAction extends ActionBase {
  readonly type: "play_lets_form_an_alliance";
  readonly cardUid: CardUid;
  readonly partner: PlayerId;
  /** Your own victim. May not be the partner: "you can't steal from each other". */
  readonly victim: PlayerId;
}
export interface PlayDoOrDieAction extends ActionBase {
  readonly type: "play_do_or_die";
  readonly cardUid: CardUid;
  readonly opponent: PlayerId;
}
export interface PlayPowerPairAction extends ActionBase {
  readonly type: "play_power_pair";
  readonly cardUid: CardUid;
  readonly first: PlayerId;
  readonly second: PlayerId;
}
export interface PlayNumbersGameAction extends ActionBase {
  readonly type: "play_its_a_numbers_game";
  readonly cardUid: CardUid;
}
/** Explicitly declining step 2, so the turn does not sit on a backstop timer. */
export interface SkipPlayStepAction extends ActionBase {
  readonly type: "skip_play_step";
}

/**
 * Turn step 3 — mandatory, ends the turn. Never fails for an empty draw pile: see the note on
 * `GameErrorCode`.
 */
export interface DrawCardAction extends ActionBase {
  readonly type: "draw_card";
}

/** Out-of-turn reactions. None of these consume the actor's once-per-turn card play. */
export interface PlaySorryForYouAction extends ActionBase {
  readonly type: "play_sorry_for_you";
  readonly cardUid: CardUid;
  readonly pendingId: PendingId;
}
export interface PlayInheritanceAction extends ActionBase {
  readonly type: "play_inheritance";
  readonly cardUid: CardUid;
  readonly pendingId: PendingId;
}
/** "No thanks" on any reaction window, so the table is not held hostage by the clock. */
export interface DeclineReactionAction extends ActionBase {
  readonly type: "decline_reaction";
  readonly pendingId: PendingId;
}

/** Pending-window resolutions. Every one names the exact window it answers. */
export interface SubmitChallengeChoiceAction extends ActionBase {
  readonly type: "submit_challenge_choice";
  readonly pendingId: PendingId;
  readonly submission: ChallengeSubmission;
}
export interface ChooseAllianceTargetAction extends ActionBase {
  readonly type: "choose_alliance_target";
  readonly pendingId: PendingId;
  readonly target: PlayerId;
}
export interface ChooseCardAction extends ActionBase {
  readonly type: "choose_card";
  readonly pendingId: PendingId;
  readonly cardUid: CardUid;
}
export interface ChooseStealVictimAction extends ActionBase {
  readonly type: "choose_steal_victim";
  readonly pendingId: PendingId;
  readonly target: PlayerId;
}
export interface DiscardCardAction extends ActionBase {
  readonly type: "discard_card";
  readonly pendingId: PendingId;
  readonly cardUid: CardUid;
}

/** Tribal Council. */
export interface AdvanceCouncilAction extends ActionBase {
  readonly type: "advance_council";
  /**
   * The phase the caller believes is current. STRUCTURAL re-entrancy guard: a stale button
   * click from a re-rendered message names the old phase and is rejected with `stale_phase`
   * instead of advancing the council twice. Audit #32.
   */
  readonly from: CouncilPhase;
}
export interface PlayControlTheVoteAction extends ActionBase {
  readonly type: "play_control_the_vote";
  readonly cardUid: CardUid;
  readonly target: PlayerId;
}
export interface PlayGoodwillGambleAction extends ActionBase {
  readonly type: "play_goodwill_gamble";
  readonly cardUid: CardUid;
  readonly recipient: PlayerId;
}
export interface PlayImTheLeaderNowAction extends ActionBase {
  readonly type: "play_im_the_leader_now";
  readonly cardUid: CardUid;
}
export interface CastVoteAction extends ActionBase {
  readonly type: "cast_vote";
  /**
   * The specific Vote / Extra Vote / Goodwill Gamble card being put in the box. An Extra Vote
   * comes straight out of `hand`, which is where it lives; no separate action is needed.
   */
  readonly cardUid: CardUid;
  readonly target: PlayerId;
}
/** "I have added every Extra Vote I intend to." Voting closes when all required voters finish. */
export interface FinishVotingAction extends ActionBase {
  readonly type: "finish_voting";
}
export interface PlayImmunityIdolAction extends ActionBase {
  readonly type: "play_immunity_idol";
  readonly cardUid: CardUid;
  /** Self or any other player — the Survival Guide is explicit that both are legal. */
  readonly protects: PlayerId;
}
export interface PlayIdolNullifierAction extends ActionBase {
  readonly type: "play_idol_nullifier";
  readonly cardUid: CardUid;
  /** The uid of the Immunity Idol being cancelled. Unambiguous because uids are unique. */
  readonly targetIdolUid: CardUid;
}
export interface LeaderChooseEliminationsAction extends ActionBase {
  readonly type: "leader_choose_eliminations";
  readonly pendingId: PendingId;
  /** Must be exactly `choose` entries, all drawn from the pending's `candidates`. */
  readonly targets: readonly PlayerId[];
}

/** Final Tribal Council. */
export interface AdvanceFinalCouncilAction extends ActionBase {
  readonly type: "advance_final_council";
  readonly from: FinalCouncilPhase;
}
export interface RevealHandAction extends ActionBase {
  readonly type: "reveal_hand";
}
export interface JurorReadyAction extends ActionBase {
  readonly type: "juror_ready";
}
export interface CastJuryVoteAction extends ActionBase {
  readonly type: "cast_jury_vote";
  readonly finalist: PlayerId;
}
export interface FinalLeaderBreakTieAction extends ActionBase {
  readonly type: "final_leader_break_tie";
  /** "They DON'T have to pick the player they originally voted for." */
  readonly winner: PlayerId;
}

/** Every player-initiated action in the game. */
export type Action =
  | JoinGameAction
  | LeaveGameAction
  | ChooseColorAction
  | StartGameAction
  | AbandonGameAction
  | RemovePlayerAction
  | TransferHostAction
  | StealRandomAction
  | PlayCampRaidAction
  | PlayKnowledgeIsPowerAction
  | PlaySpyShackAction
  | PlayAllianceAction
  | PlayDoOrDieAction
  | PlayPowerPairAction
  | PlayNumbersGameAction
  | SkipPlayStepAction
  | DrawCardAction
  | PlaySorryForYouAction
  | PlayInheritanceAction
  | DeclineReactionAction
  | SubmitChallengeChoiceAction
  | ChooseAllianceTargetAction
  | ChooseCardAction
  | ChooseStealVictimAction
  | DiscardCardAction
  | AdvanceCouncilAction
  | PlayControlTheVoteAction
  | PlayGoodwillGambleAction
  | PlayImTheLeaderNowAction
  | CastVoteAction
  | FinishVotingAction
  | PlayImmunityIdolAction
  | PlayIdolNullifierAction
  | LeaderChooseEliminationsAction
  | AdvanceFinalCouncilAction
  | RevealHandAction
  | JurorReadyAction
  | CastJuryVoteAction
  | FinalLeaderBreakTieAction;

export type ActionKind = Action["type"];

/** Narrow an action by its discriminator, e.g. `ActionOf<'cast_vote'>`. */
export type ActionOf<K extends ActionKind> = Extract<Action, { readonly type: K }>;

// ---------------------------------------------------------------------------
// The Game facade — the entire surface the Discord layer may touch
// ---------------------------------------------------------------------------

export interface DispatchOutcome {
  /** Domain events to render, in order. Never prose. */
  readonly events: readonly GameEvent[];
  /** The state AFTER the action. The engine never mutates the state you handed it. */
  readonly state: GameState;
  /**
   * Did anything actually change? The persistence layer's entire rule is
   * `if (outcome.changed) scheduleWrite(...)`. An empty `events` array is NOT a proxy for this:
   * a `tick` that expires an inheritance window, discards a hand and starts a Final Tribal
   * Council must be written, and a `tick` a millisecond later must not. Audit #60.
   */
  readonly changed: boolean;
}

/**
 * One affordance the renderer can turn into exactly one component.
 *
 * WHY not a bare `ActionKind`: `decline_reaction` and `play_sorry_for_you` both need a
 * `pendingId` and several pendings can be open at once by design; `steal_random`,
 * `play_camp_raid` and `cast_vote` need a legal target list; `choose_card` needs the option
 * uids. With only the discriminator string the renderer has to re-derive legality from
 * `state()` — which is the twenty-six-copies-of-the-guard pattern audit #88 exists to kill.
 */
export interface LegalAction {
  readonly kind: ActionKind;
  /** Set for every action that resolves a specific window. */
  readonly pendingId?: PendingId;
  /** Cards in this player's own hand that this action may be played with. */
  readonly playableCardUids?: readonly CardUid[];
  /** Players this action may legally name. */
  readonly legalTargets?: readonly PlayerId[];
  /** For `choose_card`: the uids offered by the pending, already filtered for this viewer. */
  readonly optionCardUids?: readonly CardUid[];
  /** For `leader_choose_eliminations`: exactly how many targets must be named. */
  readonly chooseCount?: number;
  /**
   * For `advance_council` / `advance_final_council`: the phase this advance is FROM.
   *
   * Both actions carry `from` so a second click on a panel drawn against the previous phase is
   * refused with `stale_phase` rather than advancing the council twice (audit #32). Without the
   * phase here, `ui.componentsForLegalActions()` — which sees only a `LegalAction` — could not
   * mint either button at all: the id it produced decoded to `target_required`, and every
   * caller had to hand-mint the button and re-derive the phase from the view.
   */
  readonly fromPhase?: CouncilPhase | FinalCouncilPhase;
  readonly deadlineMs?: number | null;
}

/** What the Discord layer schedules its single timer against. Audit #44: no more fixed sleeps. */
export interface DeadlineInfo {
  readonly atMs: number;
  readonly reason: PendingKind | "turn" | "council_phase" | "final_council_phase";
  readonly pendingId: PendingId | null;
}

/**
 * THE ENGINE, as a pure function. This — not the `Game` facade — is the primary API.
 *
 * `reduce` is what makes property tests, replay-from-an-action-log, time-travel debugging and
 * the snapshot round-trip test cheap. `createGame`/`restoreGame` are thin stateful wrappers
 * over it for the Discord layer's convenience. Wrapping a reducer in a facade is trivial;
 * reconstructing a reducer out of a facade after 30 commands have been written is not.
 */
export type Reduce = (
  state: GameState,
  action: Action,
  nowMs: number,
) => Result<DispatchOutcome>;

/** Expire whatever deadlines `nowMs` has passed. Cannot fail on a rule violation. */
export type Advance = (state: GameState, nowMs: number) => DispatchOutcome;

/**
 * The engine's stateful facade. The Discord layer holds one of these per channel, obtained
 * from the session registry — never a module-level singleton (audit #48).
 */
export interface Game {
  readonly id: GameId;
  readonly config: EngineConfig;

  /** Current state. Treat as immutable; the engine hands back a new object on every change. */
  state(): GameState;

  /** Versioned save. Must round-trip: `restore(snapshot(g)).state()` deep-equals `g.state()`. */
  snapshot(): GameSnapshot;

  /**
   * Apply an action. Expected rule violations come back as `err` and change nothing —
   * validation never mutates (audit #49).
   */
  dispatch(action: Action, nowMs: number): Result<DispatchOutcome>;

  /**
   * Advance any deadline that has passed. The ONLY time-driven entry point: the engine holds
   * no timers of its own, so a game cannot be wedged by a `setTimeout` outliving its
   * interaction token, and tests can fast-forward by calling `tick` with a future timestamp.
   *
   * Symmetric with `dispatch` on purpose: same `Result<DispatchOutcome>`, so the persistence
   * layer has ONE write rule and an internal invariant break during expiry has somewhere to go.
   */
  tick(nowMs: number): Result<DispatchOutcome>;

  /** Public state, safe to post in-channel. Structurally cannot carry a secret. */
  view(): GameView;

  /** One player's private state. Null if `viewer` is not in this game. */
  privateView(viewer: PlayerId): PrivateView | null;

  /**
   * Resolve a uid against the card registry. Without this the only route to a card's name is
   * `state().cards.find(...)` — an O(n) scan against the object that also holds every hand.
   */
  card(uid: CardUid): CardInstance | null;
  cards(uids: readonly CardUid[]): readonly CardInstance[];

  /**
   * What this player could legally do right now, with everything a component needs. Lets the
   * renderer disable dead buttons rather than let a click fail (audit #88: every component
   * stayed enabled after its collector died).
   */
  legalActions(player: PlayerId, nowMs: number): readonly LegalAction[];

  /** The next moment `tick` would do something, or null if nothing is waiting on a clock. */
  nextDeadline(): DeadlineInfo | null;
}

export interface CreateGameParams {
  readonly gameId: GameId;
  /** Whoever ran the create command. Host-gated actions are checked against this. */
  readonly hostId: PlayerId;
  readonly config: EngineConfig;
  readonly nowMs: number;
  /**
   * REQUIRED. Determinism is the headline testability property of this engine and it is not
   * opt-in: the caller must state where the entropy came from, and a test physically cannot
   * forget to pin it. The Discord layer supplies `randomSeed()` from `src/discord/seed.ts`;
   * `config.deck.rngSeed` is used by the layer to override it, never by the engine as a
   * fallback (the engine may not call `Math.random()` — see the file header).
   */
  readonly seed: number;
}

export type CreateGame = (params: CreateGameParams) => Game;

/**
 * Validate raw JSON off the disk into a `GameSnapshot`.
 *
 * The typed, testable boundary that audit #98/#102 asked for: `src/persistence` must never
 * write `raw as GameSnapshot`. Checks the schema version
 * (`snapshot_version_unsupported`), the structural shape including the arity of
 * `FinalCouncilState.finalists` (`snapshot_malformed`), and that every uid in every zone and
 * hand accounts for exactly one card in the registry (`snapshot_card_census_mismatch`).
 */
export type ParseSnapshot = (raw: unknown) => Result<GameSnapshot>;

/**
 * Restore a game from a validated snapshot.
 *
 * NO config parameter, deliberately. `snapshot.state.config` is AUTHORITATIVE — that is the
 * entire reason `EngineConfig` is embedded in `GameState` (ARCHITECTURE.md §1, §7). Accepting
 * a live config here would leave "which one wins?" to whoever wrote the persistence layer, and
 * the wrong answer silently re-introduces the defect the embedding was added to prevent: a
 * game started under `allowSelfVote: true` must keep allowing self-votes after a restart even
 * if the deployment has since flipped the flag.
 */
export type RestoreGame = (snapshot: GameSnapshot) => Result<Game>;
