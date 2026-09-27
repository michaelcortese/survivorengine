/**
 * The GameEvent union: the only thing the engine tells the outside world.
 *
 * CONTRACT: events carry DATA, never prose. There is no `message: string` anywhere in this
 * file. The Discord layer owns every word the players read; the engine owns what happened.
 * That split is what makes the rules testable — a test asserts on
 * `{ type: 'tie_break_tier_descended', to: 'played_or_protected_by_idol' }`, not on a sentence.
 *
 * AUDIENCE: every event declares who may see it. Audit #119 ("guard replies are non-ephemeral
 * in some commands and ephemeral in the very next guard of the same function") and #126
 * ("public-by-rule information is sent ephemerally, so the table cannot see it") are both
 * renderer bugs that became possible because visibility was decided ad hoc at each call site.
 * Here it is a property of the event, decided once, by the rule that governs it:
 * hand CONTENTS and votes-in-progress are private; hand SIZE, discards, idol plays and every
 * elimination are public.
 */

import type { HouseRulesConfig } from "../config.js";
import type {
  AdvantagePlay,
  CardInstance,
  CardKind,
  CardUid,
  CastVoteRecord,
  ChallengeKind,
  ChallengeSubmission,
  CouncilId,
  DeckCompositionEntry,
  CouncilPhase,
  FinalCouncilPhase,
  FingerCount,
  GameId,
  JuryVote,
  LeaderDecisionReason,
  PendingId,
  PendingKind,
  PlayerColor,
  PlayerCount,
  PlayerId,
  TakeOrigin,
  TakeSpec,
  TieBreakTier,
  TribalCouncilKind,
  TurnPhase,
  VoteObligation,
  VoteTallyRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Who is allowed to see this event.
 *
 * `public` means the whole channel — it is information the physical game puts on the table.
 * `players` means a DM or an ephemeral reply to exactly those players and nobody else.
 */
export type EventAudience =
  | { readonly kind: "public" }
  | { readonly kind: "players"; readonly playerIds: readonly PlayerId[] };

export const PUBLIC: EventAudience = { kind: "public" };

export const onlyFor = (...playerIds: readonly PlayerId[]): EventAudience => ({
  kind: "players",
  playerIds,
});

export interface EventMeta {
  /** Monotonic within a game. Renderers may use it to dedupe and to order across messages. */
  readonly seq: number;
  readonly atMs: number;
  readonly audience: EventAudience;
}

/** Distribute the envelope across every member so `event.type` still narrows correctly. */
type WithMeta<T> = T extends unknown ? EventMeta & T : never;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

interface GameCreated {
  readonly type: "game_created";
  readonly gameId: GameId;
}

interface PlayerJoined {
  readonly type: "player_joined";
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly color: PlayerColor;
  readonly seat: number;
  /**
   * Plain `number`, NOT `PlayerCount`: a lobby legitimately holds 1 and 2 players on the way
   * to a legal game. `GameStarted.playerCount` is the narrowed 3-6 type, because by then it
   * has to be.
   */
  readonly playerCount: number;
}

interface PlayerLeft {
  readonly type: "player_left";
  readonly playerId: PlayerId;
  /** Plain `number` for the same reason as `PlayerJoined.playerCount`. */
  readonly playerCount: number;
  /** Mid-game: they keep their seat and gain `leftAtSeq`. They are NOT on the jury. */
  readonly wasInProgress: boolean;
}

interface PlayerRemoved {
  readonly type: "player_removed";
  readonly playerId: PlayerId;
  /** Host-gated on `hostId`, so this is never a rival booting a rival. */
  readonly removedById: PlayerId;
  readonly wasInProgress: boolean;
}

/**
 * The host role moved.
 *
 * Public, and never silent: who may press Begin, end the game or remove a player is table
 * information, and a role that changes hands without anyone being told is how a lobby ends up
 * with three people waiting on a fourth who is not coming back.
 */
interface HostChanged {
  readonly type: "host_changed";
  readonly previousHostId: PlayerId;
  readonly newHostId: PlayerId;
  /**
   * `transferred` — the host handed it over on purpose. `host_left` / `host_removed` — the
   * engine passed it to the next seat because the host is no longer at the table.
   */
  readonly reason: "transferred" | "host_left" | "host_removed";
}

interface ColorChosen {
  readonly type: "color_chosen";
  readonly playerId: PlayerId;
  readonly color: PlayerColor;
}

/**
 * A player's castaways, as they now stand — the whole list, in the order the lives are lost.
 * Public: the Survivor Character Cards are face up on the table.
 *
 * `picked` in the lobby (a `null` is "deal me a legend"); `dealt` once per player when the game
 * begins, with every blank filled; `renamed` when a player changes one still in the game.
 */
interface CastawaysNamed {
  readonly type: "castaways_named";
  readonly playerId: PlayerId;
  readonly castaways: readonly (string | null)[];
  readonly reason: "picked" | "dealt" | "renamed";
}

interface PlayerConnectionChanged {
  readonly type: "player_connection_changed";
  readonly playerId: PlayerId;
  readonly connected: boolean;
}

interface GameStarted {
  readonly type: "game_started";
  readonly playerCount: PlayerCount;
  /** Clockwise seat order. Play always proceeds to the LEFT, i.e. ascending seat. */
  readonly seatOrder: readonly PlayerId[];
  readonly firstPlayerId: PlayerId;
  /** Echoed so a game can be replayed exactly from its log. */
  readonly seed: number;
}

interface DeckBuilt {
  readonly type: "deck_built";
  readonly drawPileSize: number;
  readonly composition: readonly DeckCompositionEntry[];
  readonly singleCouncilCards: number;
  readonly doubleCouncilCards: number;
  /**
   * Distance from the top of the draw pile for each Tribal Council card, ascending.
   * The last entry always equals `drawPileSize` — setup step 5 puts one at the bottom, so the
   * final card of the game is always a Tribal Council card (audit #7).
   */
  readonly councilPositions: readonly number[];
  readonly removedFromGame: number;
  readonly idolNullifierIncluded: boolean;
}

interface VoteCardsDealt {
  readonly type: "vote_cards_dealt";
  readonly perPlayer: number;
  readonly removedCount: number;
}

interface HandsDealt {
  readonly type: "hands_dealt";
  readonly handSize: number;
  readonly playerIds: readonly PlayerId[];
}

interface GameAbandoned {
  readonly type: "game_abandoned";
  /**
   * Whoever ended it — the host, the moderator who used the escape hatch of audit #24, or (when
   * `emptyLobby` is set) the last player to walk out of a lobby.
   */
  readonly byId: PlayerId;
  /**
   * True when `byId` is a guild moderator rather than the host. The renderer says so out loud:
   * a game ending under somebody else's name is exactly the kind of thing the table asks about
   * afterwards, and the honest answer belongs in the channel rather than in a log line.
   */
  readonly viaModerator?: boolean;
  /**
   * Nobody ended this game: everybody left it. A lobby with no players cannot be joined (the
   * card is gone with the last leaver's press) and cannot be begun, so the engine disposes of
   * it rather than leaving an unreachable session pinned to the channel. `byId` is the last
   * player out, which is true but is NOT an accusation — the renderer must say which of the
   * two happened.
   */
  readonly emptyLobby?: boolean;
}

interface GameFinished {
  readonly type: "game_finished";
  readonly winnerId: PlayerId | null;
}

interface SnapshotRestored {
  readonly type: "snapshot_restored";
  readonly schemaVersion: number;
  readonly seq: number;
  readonly savedAtMs: number;
  /**
   * How far every open deadline was moved forward to account for the downtime. Zero when the
   * restore did not rebase (a test restoring a state byte-for-byte).
   */
  readonly rebasedByMs: number;
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

interface TurnStarted {
  readonly type: "turn_started";
  readonly playerId: PlayerId;
  readonly turnNumber: number;
  readonly deadlineMs: number | null;
}

interface TurnPhaseChanged {
  readonly type: "turn_phase_changed";
  readonly playerId: PlayerId;
  readonly from: TurnPhase;
  readonly to: TurnPhase;
}

interface PlayStepSkipped {
  readonly type: "play_step_skipped";
  readonly playerId: PlayerId;
}

/**
 * A card left a hand face up. Public: "place it face up on the Discard Pile", and audit #128
 * ("Discard Privately lets a card leave the game with nobody knowing").
 */
interface CardPlayed {
  readonly type: "card_played";
  readonly playerId: PlayerId;
  readonly cardUid: CardUid;
  readonly kind: CardKind;
  /** False for reactions and council-window plays, which do not use your one play per turn. */
  readonly consumedTurnPlay: boolean;
}

/** Private to the drawer: the card itself. The table sees `turn_ended`'s pile count. */
interface CardDrawn {
  readonly type: "card_drawn";
  readonly playerId: PlayerId;
  readonly cardUid: CardUid;
  readonly kind: CardKind;
}

interface TurnEnded {
  readonly type: "turn_ended";
  readonly playerId: PlayerId;
  readonly drawPileRemaining: number;
  readonly nextPlayerId: PlayerId | null;
}

/**
 * The draw pile ran out. The rulebook never covers this; `policy` names the invented rule the
 * game is applying, and a `house_rule_applied` event accompanies it.
 */
interface DrawPileExhausted {
  readonly type: "draw_pile_exhausted";
  readonly policy: HouseRulesConfig["drawPileExhaustionPolicy"];
  readonly playersRemaining: number;
}

// ---------------------------------------------------------------------------
// Takes (steals, Spy Shack, Knowledge is Power, Camp Raid, challenge payouts)
// ---------------------------------------------------------------------------

/** Public. Opens the Sorry For You window: everyone must see the attempt to respond to it. */
interface TakeDeclared {
  readonly type: "take_declared";
  readonly pendingId: PendingId;
  readonly origin: TakeOrigin;
  readonly takerIds: readonly PlayerId[];
  readonly victimId: PlayerId;
  readonly count: number;
  /**
   * How the cards are selected. Carries the KIND only, never the uids of a `specific` take —
   * naming the exact card publicly before it moves would leak a hand.
   */
  readonly selection: TakeSpec["kind"];
  readonly deadlineMs: number;
}

/** Private to taker and victim: which specific cards moved. */
interface TakeResolved {
  readonly type: "take_resolved";
  readonly pendingId: PendingId;
  readonly takerId: PlayerId;
  readonly victimId: PlayerId;
  readonly cardUids: readonly CardUid[];
  readonly kinds: readonly CardKind[];
}

/** Public counterpart of `take_resolved`: counts only, never identities of the cards. */
interface CardsTransferred {
  readonly type: "cards_transferred";
  readonly fromId: PlayerId;
  readonly toId: PlayerId;
  readonly count: number;
  readonly fromHandSize: number;
  readonly toHandSize: number;
}

/**
 * Public. "each of those players gets nothing, and must EACH discard 1 card instead" — so
 * `blockedTakerIds` can hold two entries from a single Sorry For You (Let's Form an Alliance,
 * Power Pair), and each of them gets its own `forced_discard_opened`.
 */
interface TakeBlocked {
  readonly type: "take_blocked";
  readonly pendingId: PendingId;
  readonly victimId: PlayerId;
  readonly blockedTakerIds: readonly PlayerId[];
  readonly sorryCardUid: CardUid;
}

/** The mandatory steal landed on an empty hand. Public — hand size is public information. */
interface TakeFoundNothing {
  readonly type: "take_found_nothing";
  readonly pendingId: PendingId;
  readonly takerId: PlayerId;
  readonly victimId: PlayerId;
}

interface SorryForYouPlayed {
  readonly type: "sorry_for_you_played";
  readonly playerId: PlayerId;
  readonly cardUid: CardUid;
  readonly pendingId: PendingId;
}

interface ForcedDiscardOpened {
  readonly type: "forced_discard_opened";
  readonly pendingId: PendingId;
  readonly playerId: PlayerId;
  readonly count: number;
  readonly reason: "sorry_for_you_penalty" | "power_pair_all_same";
  readonly deadlineMs: number;
}

interface CardDiscarded {
  readonly type: "card_discarded";
  readonly playerId: PlayerId;
  readonly cardUid: CardUid;
  readonly kind: CardKind;
  readonly reason:
    "played" | "forced" | "council_cleanup" | "elimination" | "surplus_vote";
  /** True when the deadline expired and the engine picked for them. */
  readonly autoSelected: boolean;
}

// ---------------------------------------------------------------------------
// Individual card effects
// ---------------------------------------------------------------------------

interface CampRaidPlaced {
  readonly type: "camp_raid_placed";
  readonly raiderId: PlayerId;
  readonly victimId: PlayerId;
  readonly cardUid: CardUid;
}

/**
 * Private to raider and victim: it names the exact card that moved, exactly like
 * `take_resolved`. The public counterpart is `cards_transferred` (counts only).
 */
interface CampRaidResolved {
  readonly type: "camp_raid_resolved";
  readonly raiderId: PlayerId;
  readonly victimId: PlayerId;
  readonly markerCardUid: CardUid;
  readonly takenCardUid: CardUid;
  /** Every uid-bearing event carries its kind, so a renderer never needs the card registry. */
  readonly takenCardKind: CardKind;
  /**
   * "no matter what it is" versus "place it face up in front of YOU immediately" — the one
   * genuinely contradictory pair of rules in the game. True means the raider took a Tribal
   * Council card and, per `houseRules.campRaidTakesTribalCouncilCard`, becomes Leader.
   */
  readonly wasTribalCouncilCard: boolean;
}

interface KnowledgeIsPowerAsked {
  readonly type: "knowledge_is_power_asked";
  readonly askerId: PlayerId;
  readonly targetId: PlayerId;
  readonly named: CardKind;
}

interface KnowledgeIsPowerAnswered {
  readonly type: "knowledge_is_power_answered";
  readonly askerId: PlayerId;
  readonly targetId: PlayerId;
  readonly named: CardKind;
  /** A miss is public information: the whole table learns that player lacks the card. */
  readonly hit: boolean;
}

/** Private to the spy. One of only two legal ways to see another player's hand. */
interface SpyShackPeeked {
  readonly type: "spy_shack_peeked";
  readonly spyId: PlayerId;
  readonly targetId: PlayerId;
  readonly cards: readonly CardInstance[];
}

interface AllianceFormed {
  readonly type: "alliance_formed";
  readonly initiatorId: PlayerId;
  readonly partnerId: PlayerId;
  readonly cardUid: CardUid;
  readonly initiatorVictimId: PlayerId;
}

interface AllianceTargetChosen {
  readonly type: "alliance_target_chosen";
  readonly pendingId: PendingId;
  readonly partnerId: PlayerId;
  readonly victimId: PlayerId;
}

// ---------------------------------------------------------------------------
// Reward Challenges
// ---------------------------------------------------------------------------

interface ChallengeStarted {
  readonly type: "challenge_started";
  readonly pendingId: PendingId;
  readonly challenge: ChallengeKind;
  readonly cardUid: CardUid;
  readonly initiatorId: PlayerId;
  readonly participantIds: readonly PlayerId[];
  readonly round: number;
  readonly deadlineMs: number;
}

/** Public: THAT they submitted, never WHAT. Simultaneity is the whole point of these cards. */
interface ChallengeSubmissionReceived {
  readonly type: "challenge_submission_received";
  readonly pendingId: PendingId;
  readonly playerId: PlayerId;
  readonly round: number;
  readonly submittedCount: number;
  readonly participantCount: number;
}

export interface ChallengeReveal {
  readonly playerId: PlayerId;
  readonly submission: ChallengeSubmission;
}

interface ChallengeRevealed {
  readonly type: "challenge_revealed";
  readonly pendingId: PendingId;
  readonly challenge: ChallengeKind;
  readonly round: number;
  readonly reveals: readonly ChallengeReveal[];
}

/**
 * Power Pair: "If everyone shows a different number of fingers, play again."
 * It's a Numbers Game: "If necessary, repeat until there's a single winner."
 * Do or Die never replays — its tie is a defined outcome.
 */
interface ChallengeReplayed {
  readonly type: "challenge_replayed";
  readonly pendingId: PendingId;
  readonly challenge: ChallengeKind;
  readonly nextRound: number;
  readonly reason: "all_different" | "no_unique_lowest";
}

export type ChallengeOutcome =
  /** Do or Die, decisive: "if either player wins, they steal 2 random cards from the loser". */
  | {
      readonly kind: "rps_decisive";
      readonly winnerId: PlayerId;
      readonly loserId: PlayerId;
    }
  /** Do or Die, tied: "you each swap 1 card of your choice" — the only chosen-card exchange. */
  | { readonly kind: "rps_tie"; readonly playerIds: readonly [PlayerId, PlayerId] }
  /** Power Pair: exactly two matched; they each steal 1 random card from the third. */
  | {
      readonly kind: "power_pair_matched";
      readonly matchedIds: readonly [PlayerId, PlayerId];
      readonly oddOneOutId: PlayerId;
    }
  /** Power Pair: all three matched; every participant discards 1, no steal at all. */
  | { readonly kind: "power_pair_all_same"; readonly playerIds: readonly PlayerId[] }
  /** It's a Numbers Game: lowest number shown by exactly one player. */
  | {
      readonly kind: "numbers_game_winner";
      readonly winnerId: PlayerId;
      /** `FingerCount`, not `number`: the domain type is 1-5 and the renderer should know it. */
      readonly number: FingerCount;
    };

interface ChallengeResolved {
  readonly type: "challenge_resolved";
  readonly pendingId: PendingId;
  readonly challenge: ChallengeKind;
  readonly round: number;
  readonly outcome: ChallengeOutcome;
}

/** Private to the two swappers: the Do or Die tie exchange. */
interface ChallengeSwapCompleted {
  readonly type: "challenge_swap_completed";
  readonly pendingId: PendingId;
  readonly aId: PlayerId;
  readonly bId: PlayerId;
  readonly aGaveCardUid: CardUid;
  readonly aGaveCardKind: CardKind;
  readonly bGaveCardUid: CardUid;
  readonly bGaveCardKind: CardKind;
}

// ---------------------------------------------------------------------------
// Tribal Council
// ---------------------------------------------------------------------------

interface CouncilStarted {
  readonly type: "council_started";
  readonly councilId: CouncilId;
  readonly kind: TribalCouncilKind;
  readonly cardUid: CardUid;
  readonly drawerId: PlayerId;
  readonly leaderId: PlayerId;
  readonly councilNumber: number;
  readonly councilsRemainingInDeck: number;
}

interface CouncilPhaseChanged {
  readonly type: "council_phase_changed";
  readonly councilId: CouncilId;
  readonly from: CouncilPhase;
  readonly to: CouncilPhase;
  readonly deadlineMs: number | null;
}

/** "I'm the Leader Now" — the only card that can move the role. */
interface CouncilLeaderChanged {
  readonly type: "council_leader_changed";
  readonly councilId: CouncilId;
  readonly fromId: PlayerId;
  readonly toId: PlayerId;
  readonly cardUid: CardUid;
  /** The card also rewrites turn order: the new Leader takes the next turn. */
  readonly grantsNextTurn: boolean;
}

interface AdvantagePlayed {
  readonly type: "advantage_played";
  readonly councilId: CouncilId;
  readonly cardUid: CardUid;
  /** The three Tribal Advantages, not all 19 kinds: reuse the narrowing `AdvantagePlay` did. */
  readonly kind: AdvantagePlay["kind"];
  readonly playedById: PlayerId;
  readonly targetId: PlayerId | null;
}

interface VoteCardTaken {
  readonly type: "vote_card_taken";
  readonly councilId: CouncilId;
  readonly takerId: PlayerId;
  readonly victimId: PlayerId;
  readonly cardUid: CardUid;
  /** Both stolen and own Vote Cards MUST be spent this council; they cannot be banked. */
  readonly mustBeUsedThisCouncil: boolean;
}

interface GoodwillGambleGiven {
  readonly type: "goodwill_gamble_given";
  readonly councilId: CouncilId;
  readonly giverId: PlayerId;
  readonly recipientId: PlayerId;
  readonly cardUid: CardUid;
}

/**
 * NO `voteOrder`. The rulebook's default is that the Leader votes first and the box passes
 * left, but it explicitly sanctions the alternative this bot uses — "put the Voting Box in
 * another room and let players vote in private" — under which order is neither observable nor
 * enforceable. Promising an order the state cannot back would be a contract that lies.
 */
interface VotingOpened {
  readonly type: "voting_opened";
  readonly councilId: CouncilId;
  /** Everyone holding a Vote Card. Voting is compulsory: "Everyone must vote. I'll go first." */
  readonly requiredVoterIds: readonly PlayerId[];
  /**
   * The obligation list, per CARD. A player who has been handed a Goodwill Gamble or who
   * played Control the Vote owes more than one cast, and `finish_voting` is refused until
   * every one of their entries is spent.
   */
  readonly requiredCasts: readonly VoteObligation[];
  readonly deadlineMs: number | null;
}

/** Private to the voter. The target stays secret until the box is opened. */
interface VoteCast {
  readonly type: "vote_cast";
  readonly councilId: CouncilId;
  readonly voterId: PlayerId;
  readonly cardUid: CardUid;
  readonly targetId: PlayerId;
  readonly source: CastVoteRecord["source"];
}

/**
 * Public. Deliberately carries no counts: everyone taps the table in rhythm during the vote
 * "so no one can hear how many votes are being cast".
 */
interface VoterFinished {
  readonly type: "voter_finished";
  readonly councilId: CouncilId;
  readonly voterId: PlayerId;
  readonly remainingVoterIds: readonly PlayerId[];
}

/**
 * The compulsory vote, forfeited, because the voting backstop ran out with casts outstanding.
 *
 * "Everyone must vote" is a rule about a physical table where the Voting Box is handed to the
 * next seat. It is not a rule that the game stops if somebody walks away — and before this
 * event existed that is exactly what happened: the backstop re-armed forever, `advance_council`
 * and `finish_voting` both refused with `must_cast_mandatory_vote`, and the council could never
 * be resolved by anyone. A game that continues with one fewer vote is far closer to the printed
 * rules than a game that never continues at all.
 */
interface VotesForfeited {
  readonly type: "votes_forfeited";
  readonly councilId: CouncilId;
  /** Who did not vote. The table is told, because it changes who goes home. */
  readonly playerIds: readonly PlayerId[];
  /** Exactly which casts were owed, so the narration can name a Goodwill Gamble as one. */
  readonly casts: readonly VoteObligation[];
}

interface VotingClosed {
  readonly type: "voting_closed";
  readonly councilId: CouncilId;
}

interface IdolWindowOpened {
  readonly type: "idol_window_opened";
  readonly councilId: CouncilId;
  readonly deadlineMs: number;
}

interface IdolPlayed {
  readonly type: "idol_played";
  readonly councilId: CouncilId;
  readonly cardUid: CardUid;
  readonly playedById: PlayerId;
  readonly protectsId: PlayerId;
}

interface NullifierWindowOpened {
  readonly type: "nullifier_window_opened";
  readonly councilId: CouncilId;
  readonly idolCardUids: readonly CardUid[];
  readonly deadlineMs: number;
}

interface IdolNullified {
  readonly type: "idol_nullified";
  readonly councilId: CouncilId;
  readonly nullifierCardUid: CardUid;
  readonly idolCardUid: CardUid;
  readonly playedById: PlayerId;
  readonly idolProtectedId: PlayerId;
}

/**
 * The dramatic reveal. `revealOrder` is the votes in the exact sequence they should be read
 * out; the renderer paces them with `timings.voteRevealInterval`. This is the single event
 * that turns secret votes into public information.
 */
interface VotesRevealed {
  readonly type: "votes_revealed";
  readonly councilId: CouncilId;
  /**
   * The ballot as the TABLE sees it: which card, for whom, in what order — and NEVER by whom.
   *
   * This used to be `CastVoteRecord[]`, which carries `voterId`. The physical game destroys
   * that mapping on purpose: Vote Cards are generic, they go into a slot chosen by the TARGET's
   * colour, and the whole eyes-closed tap-in-rhythm ritual exists "So no one can hear how many
   * votes are being cast" (docs/RULES.md). The rulebook's tally step is "I'll open the box and
   * tally the votes" — counts per colour, never authorship. `vote_cast` is correctly private to
   * the voter and the renderer only ever printed `targetId`, so nothing leaked; but a PUBLIC
   * event whose payload holds information the game has no way to produce is one debug dump,
   * structured log or generic renderer away from telling the table who voted for whom, and the
   * bluffing layer the whole game is built on does not survive that. `voterId` stays in
   * `CouncilState.votes`, where the engine needs it for `requiredCasts` bookkeeping.
   */
  readonly revealOrder: readonly RevealedVote[];
  readonly totalVotes: number;
}

/** One vote, with the voter stripped out. See `votes_revealed`. */
export interface RevealedVote {
  readonly cardUid: CardUid;
  readonly targetId: PlayerId;
  readonly source: CastVoteRecord["source"];
  readonly order: number;
}

interface TallyComputed {
  readonly type: "tally_computed";
  readonly councilId: CouncilId;
  readonly rows: readonly VoteTallyRow[];
  readonly highestCountedVotes: number;
  /** Players tied at `highestCountedVotes`. Empty when every vote was nullified by idols. */
  readonly topVoteGetters: readonly PlayerId[];
}

interface TieBreakRequired {
  readonly type: "tie_break_required";
  readonly councilId: CouncilId;
  readonly pendingId: PendingId;
  readonly leaderId: PlayerId;
  readonly reason: LeaderDecisionReason;
  readonly tier: TieBreakTier;
  readonly candidates: readonly PlayerId[];
  readonly choose: number;
  readonly deadlineMs: number;
}

/**
 * The tie-break ladder descending a rung. Emitted so the table can watch the rule work —
 * especially the last rung, where a player who played an Immunity Idol becomes eligible
 * anyway, which reads as a bug to anyone who has not read the rulebook's fine print.
 */
interface TieBreakTierDescended {
  readonly type: "tie_break_tier_descended";
  readonly councilId: CouncilId;
  readonly from: TieBreakTier;
  readonly to: TieBreakTier;
  readonly emptyBecause: "no_candidates" | "not_enough_candidates";
}

interface LeaderChoseEliminations {
  readonly type: "leader_chose_eliminations";
  readonly councilId: CouncilId;
  readonly leaderId: PlayerId;
  readonly targetIds: readonly PlayerId[];
  readonly tier: TieBreakTier;
  readonly reason: LeaderDecisionReason;
}

/**
 * One Survivor Character Card turned over to its "VOTED OUT" side. This is NOT elimination —
 * audit #110 announced the first flip as "the 1st person voted out of Survivor".
 */
interface CharacterCardFlipped {
  readonly type: "character_card_flipped";
  readonly playerId: PlayerId;
  readonly cardUid: CardUid;
  /** Who was on the card: the castaway just voted out. */
  readonly castaway: string | null;
  readonly charactersRemaining: number;
  readonly votesReceived: number;
  readonly councilId: CouncilId | null;
}

/** Both character cards turned over. The player leaves the table and joins the Jury. */
interface PlayerEliminated {
  readonly type: "player_eliminated";
  readonly playerId: PlayerId;
  /** 1 = first player out. Also decides the Final Tribal Council Leader (the highest number). */
  readonly eliminationOrder: number;
  readonly playersRemaining: number;
  readonly handSize: number;
}

interface InheritanceWindowOpened {
  readonly type: "inheritance_window_opened";
  readonly pendingId: PendingId;
  readonly eliminatedPlayerId: PlayerId;
  readonly color: PlayerColor;
  readonly handSize: number;
  readonly deadlineMs: number;
}

interface InheritanceClaimed {
  readonly type: "inheritance_claimed";
  readonly pendingId: PendingId;
  readonly claimantId: PlayerId;
  readonly eliminatedPlayerId: PlayerId;
  readonly cardUid: CardUid;
  /** Public count. The claimant gets the identities privately via `take_resolved`. */
  readonly cardCount: number;
}

/**
 * Public and face up: "put your cards face up on top of the Discard Pile". Carries whole
 * `CardInstance`s rather than uids precisely because the rule is that they go FACE UP — a
 * renderer must be able to name them without a trip to the card registry.
 */
interface HandDiscardedOnElimination {
  readonly type: "hand_discarded_on_elimination";
  readonly playerId: PlayerId;
  readonly cards: readonly CardInstance[];
  /** The Vote Card returns to the bank and a granted Goodwill Gamble is discarded with it. */
  readonly voteCardsReturned: number;
  readonly grantedVotesDiscarded: number;
}

interface VoteCardsReturned {
  readonly type: "vote_cards_returned";
  readonly councilId: CouncilId;
  /** Exactly one each, to every player still holding at least one Survivor Character Card. */
  readonly playerIds: readonly PlayerId[];
  readonly surplusDiscarded: number;
}

interface CouncilEnded {
  readonly type: "council_ended";
  readonly councilId: CouncilId;
  readonly eliminatedIds: readonly PlayerId[];
  readonly flippedIds: readonly PlayerId[];
  readonly nextPlayerId: PlayerId | null;
  /** True when "I'm the Leader Now" overrode the default "player to the Leader's left". */
  readonly nextTurnFromOverride: boolean;
}

// ---------------------------------------------------------------------------
// Final Tribal Council
// ---------------------------------------------------------------------------

/**
 * How the game reached two players.
 *
 * PROVENANCE ONLY. This is a label for the narration, NOT the trigger and never a branch the
 * engine takes: the trigger is one predicate — `players.filter(isInPlay).length === 2` —
 * evaluated in a single `afterPlayerCountChanged()` helper called after every character-card
 * flip, every removal, every departure and every draw. Audit #14 is precisely "the trigger
 * fires on only one of four elimination paths", and its prescribed fix is to centralise the
 * check rather than enumerate the call sites. A closed enum written at the top of a contract
 * re-creates the enumeration: whoever implements it writes one branch per member and forgets
 * the one that is missing.
 *
 * Note in particular `double_elimination_complete`, the SECOND flip of a normal 4-to-2 double
 * elimination — the most common route at 4+ players, and the one absent from the first draft.
 */
export type FinalCouncilTrigger =
  /** A Single Elimination council took the table from 3 to 2. */
  | "single_elimination"
  /** Mid-resolution: a Double Elimination's FIRST flip already left 2 players. */
  | "double_elimination_partial"
  /** A Double Elimination that completed normally, 4 players down to 2. */
  | "double_elimination_complete"
  /** "Only 3 players left and 2 would be eliminated": the Leader flips one, then this. */
  | "three_player_override"
  /** The draw pile ran out; `drawPileExhaustionPolicy: 'final_council'` force-eliminated the rest. */
  | "draw_pile_empty"
  /** `leave_game` or a host `remove_player` took a 3-player game to 2. */
  | "player_left_game";

interface FinalCouncilStarted {
  readonly type: "final_council_started";
  readonly leaderId: PlayerId;
  readonly finalists: readonly [PlayerId, PlayerId];
  /** Never empty: a Final Council is only ever opened with at least one juror. */
  readonly juryIds: readonly PlayerId[];
  readonly trigger: FinalCouncilTrigger;
}

interface FinalCouncilPhaseChanged {
  readonly type: "final_council_phase_changed";
  readonly from: FinalCouncilPhase;
  readonly to: FinalCouncilPhase;
  readonly deadlineMs: number | null;
}

/** Public and voluntary: finalists "can't play any cards, but they can reveal their hands". */
interface FinalistHandRevealed {
  readonly type: "finalist_hand_revealed";
  readonly playerId: PlayerId;
  readonly cards: readonly CardInstance[];
}

interface JurorReady {
  readonly type: "juror_ready";
  readonly jurorId: PlayerId;
  readonly readyCount: number;
  readonly juryCount: number;
}

/** Private until the countdown: the point is that every juror reveals simultaneously. */
interface JuryVoteCast {
  readonly type: "jury_vote_cast";
  readonly jurorId: PlayerId;
  readonly finalistId: PlayerId;
}

interface JuryVoteRegistered {
  readonly type: "jury_vote_registered";
  readonly jurorId: PlayerId;
  readonly castCount: number;
  readonly juryCount: number;
}

/** "The winner of Survivor is… 3… 2… 1…" — every jury vote at once. */
interface JuryVotesRevealed {
  readonly type: "jury_votes_revealed";
  readonly votes: readonly JuryVote[];
  readonly tallies: readonly {
    readonly finalistId: PlayerId;
    readonly votes: number;
  }[];
}

interface FinalTieBreakRequired {
  readonly type: "final_tie_break_required";
  readonly leaderId: PlayerId;
  readonly finalists: readonly [PlayerId, PlayerId];
  readonly deadlineMs: number;
}

/**
 * `sole_survivor` covers every win that never reaches a jury vote, which the first draft could
 * not describe at all: a Double Elimination that takes 3 players to 1 (audit #21), and a
 * `remove_player` / `leave_game` that leaves 2 players with an empty jury (no Final Council is
 * possible, so the player holding more Survivor Character Cards wins outright — and if they
 * are level, the engine emits `game_finished` with a null winner and no `winner_declared`).
 */
interface WinnerDeclared {
  readonly type: "winner_declared";
  readonly winnerId: PlayerId;
  readonly method: "jury_majority" | "leader_tie_break" | "sole_survivor";
  /** Absent for `sole_survivor`: there was no jury vote to count. */
  readonly votes?: number;
  readonly juryCount?: number;
}

// ---------------------------------------------------------------------------
// Pending windows and policy disclosure
// ---------------------------------------------------------------------------

interface PendingOpened {
  readonly type: "pending_opened";
  readonly pendingId: PendingId;
  readonly pendingKind: PendingKind;
  readonly waitingOnIds: readonly PlayerId[];
  readonly deadlineMs: number;
}

/**
 * `defaultApplied` is a closed union, not a sentence. The engine writes no prose (see the file
 * header): a free-form string here would be a sentence produced by the engine, printed
 * verbatim by the renderer, and untestable except by string matching.
 */
export type PendingDefault =
  /** The take window closed with no Sorry For You: the cards moved. */
  | "take_resolved"
  /** The discard window closed: the engine picked a card at random. */
  | "discard_auto_selected"
  /** No submission arrived: that participant forfeits the challenge round. */
  | "challenge_forfeited"
  /** No card was picked: the engine picked one of the offered uids. */
  | "card_choice_auto_selected"
  /** No alliance target was named: the partner steals from nobody. */
  | "alliance_target_forfeited"
  /** It's a Numbers Game's winner never named a victim: the steal is forfeited. */
  | "steal_victim_forfeited"
  /** The Leader never chose: the engine picked from `candidates`, lowest seat first. */
  | "leader_choice_auto_selected"
  /** Nobody claimed the hand: it goes face up on the Discard Pile. */
  | "inheritance_forfeited";

interface PendingExpired {
  readonly type: "pending_expired";
  readonly pendingId: PendingId;
  readonly pendingKind: PendingKind;
  /** What the engine did instead of waiting. */
  readonly defaultApplied: PendingDefault;
}

interface PendingCancelled {
  readonly type: "pending_cancelled";
  readonly pendingId: PendingId;
  readonly pendingKind: PendingKind;
  readonly reason:
    "blocked" | "superseded" | "player_eliminated" | "game_ended" | "declined";
}

/** Identifies one of the documented rules gaps this bot has had to invent an answer for. */
export type HouseRuleId = keyof HouseRulesConfig | "idol_nullifier_included";

/** The real type of a house rule's value: boolean for twelve of them, a union for the policy. */
export type HouseRuleSetting<R extends HouseRuleId> = R extends keyof HouseRulesConfig
  ? HouseRulesConfig[R]
  : boolean;

interface HouseRuleAppliedOf<R extends HouseRuleId> {
  readonly type: "house_rule_applied";
  readonly rule: R;
  readonly setting: HouseRuleSetting<R>;
  readonly affectedPlayerIds: readonly PlayerId[];
}

/**
 * Emitted whenever a house rule actually decided an outcome. docs/RULES.md: "Any implementation
 * is inventing a rule here, and should say so in-app." This is how it says so.
 *
 * Distributed over `HouseRuleId` so `setting` keeps its real type all the way to the renderer:
 * `rule: 'drawPileExhaustionPolicy'` narrows `setting` to `'final_council' | 'draw'`, and
 * every other rule narrows it to `boolean`. Stringifying it here would have forced the
 * renderer to parse `"true"` back into a boolean to choose its copy.
 */
type HouseRuleApplied = {
  [R in HouseRuleId]: HouseRuleAppliedOf<R>;
}[HouseRuleId];

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export type GameEventBody =
  // lifecycle
  | GameCreated
  | PlayerJoined
  | PlayerLeft
  | PlayerRemoved
  | HostChanged
  | ColorChosen
  | CastawaysNamed
  | PlayerConnectionChanged
  | GameStarted
  | DeckBuilt
  | VoteCardsDealt
  | HandsDealt
  | GameAbandoned
  | GameFinished
  | SnapshotRestored
  // turn
  | TurnStarted
  | TurnPhaseChanged
  | PlayStepSkipped
  | CardPlayed
  | CardDrawn
  | TurnEnded
  | DrawPileExhausted
  // takes
  | TakeDeclared
  | TakeResolved
  | CardsTransferred
  | TakeBlocked
  | TakeFoundNothing
  | SorryForYouPlayed
  | ForcedDiscardOpened
  | CardDiscarded
  // card effects
  | CampRaidPlaced
  | CampRaidResolved
  | KnowledgeIsPowerAsked
  | KnowledgeIsPowerAnswered
  | SpyShackPeeked
  | AllianceFormed
  | AllianceTargetChosen
  // challenges
  | ChallengeStarted
  | ChallengeSubmissionReceived
  | ChallengeRevealed
  | ChallengeReplayed
  | ChallengeResolved
  | ChallengeSwapCompleted
  // council
  | CouncilStarted
  | CouncilPhaseChanged
  | CouncilLeaderChanged
  | AdvantagePlayed
  | VoteCardTaken
  | GoodwillGambleGiven
  | VotingOpened
  | VoteCast
  | VoterFinished
  | VotesForfeited
  | VotingClosed
  | IdolWindowOpened
  | IdolPlayed
  | NullifierWindowOpened
  | IdolNullified
  | VotesRevealed
  | TallyComputed
  | TieBreakRequired
  | TieBreakTierDescended
  | LeaderChoseEliminations
  | CharacterCardFlipped
  | PlayerEliminated
  | InheritanceWindowOpened
  | InheritanceClaimed
  | HandDiscardedOnElimination
  | VoteCardsReturned
  | CouncilEnded
  // final council
  | FinalCouncilStarted
  | FinalCouncilPhaseChanged
  | FinalistHandRevealed
  | JurorReady
  | JuryVoteCast
  | JuryVoteRegistered
  | JuryVotesRevealed
  | FinalTieBreakRequired
  | WinnerDeclared
  // pending / policy
  | PendingOpened
  | PendingExpired
  | PendingCancelled
  | HouseRuleApplied;

/** Every event the engine can emit, envelope included. */
export type GameEvent = WithMeta<GameEventBody>;

export type GameEventType = GameEventBody["type"];

/** Narrow an event by its discriminator, e.g. `EventOf<'votes_revealed'>`. */
export type EventOf<K extends GameEventType> = Extract<GameEvent, { readonly type: K }>;

/** True when this event may be posted in the public channel. */
export const isPublic = (event: GameEvent): boolean => event.audience.kind === "public";

/**
 * The players a private event goes to, or an empty list for a public one.
 *
 * Together with `isPublic` this is the whole audience decision, and it belongs here — where the
 * envelope is defined — rather than open-coded in the renderer. It was open-coded in the
 * renderer, twice, while these exports sat unused two files away: the exact configuration that
 * produced audit #119/#126, in which one surface decided visibility differently from the next.
 */
export const recipientsOf = (event: GameEvent): readonly PlayerId[] =>
  event.audience.kind === "players" ? event.audience.playerIds : [];

// ---------------------------------------------------------------------------
// The audience policy
// ---------------------------------------------------------------------------

export type EventVisibility = "public" | "private";

/**
 * Visibility, decided ONCE per event type, by the rule that governs it.
 *
 * WHY this table exists on top of the `audience` field: `audience` is a runtime value chosen
 * at each of ~80 emit sites, so `{...meta, audience: PUBLIC, type: 'card_drawn'}` typechecks
 * perfectly and `onlyFor(leaderId)` on `player_eliminated` does too. That is the same ad-hoc
 * decision audit #119/#126 are made of, merely relocated. `Record<GameEventType, …>` makes a
 * missing key a compile error, and one test asserts every emitted event's audience against
 * this table — so the decision is data, checkable, and in one place.
 *
 * `private` means the `players` variant; the rule below says who those players are.
 */
export const EVENT_AUDIENCE_POLICY: Readonly<Record<GameEventType, EventVisibility>> = {
  // Lifecycle — all public. Who is at the table is table information.
  game_created: "public",
  player_joined: "public",
  player_left: "public",
  player_removed: "public",
  host_changed: "public",
  color_chosen: "public",
  castaways_named: "public",
  player_connection_changed: "public",
  game_started: "public",
  deck_built: "public",
  vote_cards_dealt: "public",
  hands_dealt: "public",
  game_abandoned: "public",
  game_finished: "public",
  snapshot_restored: "public",

  // Turn — public, except the identity of the card you drew.
  turn_started: "public",
  turn_phase_changed: "public",
  play_step_skipped: "public",
  card_played: "public",
  card_drawn: "private", // the drawer
  turn_ended: "public",
  draw_pile_exhausted: "public",

  // Takes — the attempt and the counts are public; WHICH cards moved is not.
  take_declared: "public",
  take_resolved: "private", // taker + victim
  cards_transferred: "public",
  take_blocked: "public",
  take_found_nothing: "public",
  sorry_for_you_played: "public",
  forced_discard_opened: "public",
  card_discarded: "public",

  // Card effects.
  camp_raid_placed: "public",
  camp_raid_resolved: "private", // raider + victim: it names the exact card taken
  knowledge_is_power_asked: "public",
  knowledge_is_power_answered: "public", // a miss teaches the whole table something
  spy_shack_peeked: "private", // the spy, and only the spy
  alliance_formed: "public",
  alliance_target_chosen: "public",

  // Challenges — THAT you submitted is public, WHAT you submitted is not, until the reveal.
  challenge_started: "public",
  challenge_submission_received: "public",
  challenge_revealed: "public",
  challenge_replayed: "public",
  challenge_resolved: "public",
  challenge_swap_completed: "private", // the two swappers

  // Council — the ballot is secret until the box is opened.
  council_started: "public",
  council_phase_changed: "public",
  council_leader_changed: "public",
  advantage_played: "public",
  vote_card_taken: "public",
  goodwill_gamble_given: "public",
  voting_opened: "public",
  vote_cast: "private", // the voter
  voter_finished: "public",
  votes_forfeited: "public",
  voting_closed: "public",
  idol_window_opened: "public",
  idol_played: "public",
  nullifier_window_opened: "public",
  idol_nullified: "public",
  votes_revealed: "public", // this event IS the moment the ballot becomes public
  tally_computed: "public",
  tie_break_required: "public",
  tie_break_tier_descended: "public",
  leader_chose_eliminations: "public",
  character_card_flipped: "public",
  player_eliminated: "public",
  inheritance_window_opened: "public",
  inheritance_claimed: "public",
  hand_discarded_on_elimination: "public",
  vote_cards_returned: "public",
  council_ended: "public",

  // Final council — jury votes are held until the "3… 2… 1…".
  final_council_started: "public",
  final_council_phase_changed: "public",
  finalist_hand_revealed: "public",
  juror_ready: "public",
  jury_vote_cast: "private", // the juror
  jury_vote_registered: "public",
  jury_votes_revealed: "public",
  final_tie_break_required: "public",
  winner_declared: "public",

  // Pending windows and policy disclosure.
  pending_opened: "public",
  pending_expired: "public",
  pending_cancelled: "public",
  house_rule_applied: "public",
};

/** The audience kind this event type is REQUIRED to carry. */
export const requiredAudienceKind = (type: GameEventType): EventAudience["kind"] =>
  EVENT_AUDIENCE_POLICY[type] === "public" ? "public" : "players";

/** True when an event's audience matches the policy. Asserted over every event in one test. */
export const audienceMatchesPolicy = (event: GameEvent): boolean =>
  event.audience.kind === requiredAudienceKind(event.type);
