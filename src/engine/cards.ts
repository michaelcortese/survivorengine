/**
 * The complete card catalog, as data.
 *
 * SOURCE OF TRUTH for `rulesText` and `clarifications` is the official Survival Guide
 * ("Read this if you have questions about specific cards"), transcribed at
 * scratchpad/sg_mine.txt. Those strings are VERBATIM, including the publisher's typographic
 * apostrophes and, in Camp Raid, the lower-case "you" that starts its second sentence. Do not
 * "fix" them — a diff against the printed card is a bug report, and copy-editing this file
 * destroys that property. Anything we wrote ourselves lives in `compactText`.
 *
 * Audit #113: "Card reference data is incomplete and diverges from the printed card text."
 * The old `src/game/cardlist.json` was missing FOUR entire card types the physical game
 * depends on — Vote (6), Tribal Council (9, in two variants), Inheritance (6) and the Survivor
 * Character Cards (12) — and its 14 types summed to 46 against a printed box count of 67.
 * This catalog sums to exactly 67 Action Cards + 12 Character Cards + the hidden 68th.
 *
 * This module is pure data plus lookup helpers. No game logic.
 */

import type { EngineConfig } from "../config.js";
import type { DeckConfig, PlayerCount } from "../config.js";
import {
  CardKind,
  type CardCategory,
  type CardInstance,
  type CardTiming,
  type ColoredCardInstance,
  type DeckCompositionEntry,
  type PlayerColor,
  type TargetRequirement,
  type TribalCouncilKind,
} from "./types.js";

// ---------------------------------------------------------------------------
// Box contents (printed on the box; these are facts, not settings)
// ---------------------------------------------------------------------------

/** "Gather all 67 Action Cards". Includes the 9 Tribal Council and 6 Vote cards. */
export const ACTION_CARDS_IN_BOX = 67;

/**
 * 67 Action Cards minus the 9 Tribal Council cards minus the 6 Vote Cards, all of which setup
 * step 2 removes BEFORE the shuffle. This is the pile every player's opening hand comes out
 * of. Derived arithmetic, asserted in `validateCatalog()` — a future edit that changes a
 * printed quantity without changing a deck role would otherwise pass the 67 check silently.
 */
export const SHUFFLED_CARDS_IN_BOX = 52;

/** 6 colours x 2. Two per player are the "lives"; the reverse reads "VOTED OUT". */
export const CHARACTER_CARDS_IN_BOX = 12;

/**
 * The Idol Nullifier: a 68th card sealed under a false cardboard bottom inside the box. It
 * appears in NEITHER official PDF (grep both: zero hits) and is excluded from the printed
 * 67. Including it in the shuffled deck is a documented divergence — see
 * `config.engine.deck.includeIdolNullifier`.
 */
export const HIDDEN_CARDS_IN_BOX = 1;

/**
 * Where a card lives during setup. Setup step 2 removes the Tribal Council and Vote cards
 * BEFORE the shuffle, which is why "shuffled" is a smaller set than "action card".
 */
export type DeckRole =
  /** Part of the 52 cards shuffled to form the draw pile. */
  | "shuffled"
  /** Removed before the shuffle, then re-inserted at chosen positions (setup step 5). */
  | "tribal_council"
  /** Removed before the shuffle and handed out one per player; surplus leaves the game. */
  | "dealt_at_setup"
  /** Never in any deck: the two face-up cards in front of each player. */
  | "player_component"
  /** Not among the 67. Enters play only if `includeIdolNullifier` is on. */
  | "hidden_easter_egg";

/**
 * Provenance of a quoted passage, so a reader knows what is quotable and what is invented.
 * `unofficial` marks anything not printed by Exploding Kittens — third-party transcription or
 * our own editorial note. Nothing marked `unofficial` should ever be presented as a rule.
 */
export type RulesSource = "survival_guide" | "rulebook" | "unofficial";

/**
 * A sidebar or supplementary rule quoted alongside a card. Tagged individually because the two
 * official PDFs cover different things: the Survival Guide is the per-card FAQ, the rulebook
 * carries the setup table, the Leader script, the tie rules and the elimination cascade.
 */
export interface Clarification {
  readonly text: string;
  readonly source: RulesSource;
}

const sg = (text: string): Clarification => ({ text, source: "survival_guide" });
const rb = (text: string): Clarification => ({ text, source: "rulebook" });
const note = (text: string): Clarification => ({ text, source: "unofficial" });

export interface CardDefinition {
  readonly kind: CardKind;
  /** Display name, matching the printed card. */
  readonly name: string;
  readonly category: CardCategory;
  /** VERBATIM printed rules text. See the file header before editing. */
  readonly rulesText: string;
  /** VERBATIM sidebars and clarifications, each tagged with which document it came from. */
  readonly clarifications: readonly Clarification[];
  /** OUR summary, for hand lists and buttons. Ours to edit freely. */
  readonly compactText: string;
  readonly timing: CardTiming;
  readonly target: TargetRequirement;
  /** How many are printed in the box. */
  readonly quantityInBox: number;
  readonly deckRole: DeckRole;
  /** True for the two card types that exist once per player colour. */
  readonly perColor: boolean;
  /** Does playing this use up your single card play for the turn? */
  readonly consumesTurnPlay: boolean;
  readonly imageUrl: string | null;
  readonly source: RulesSource;
  /** Stable ordering for rendering a hand. */
  readonly sortOrder: number;
  /** Alternate spellings accepted by `lookupCardKindByName` (Knowledge is Power). */
  readonly aliases: readonly string[];
}

/**
 * Shared Survival Guide text for BOTH Tribal Council variants — the printed card carries one
 * block of text under a header that lists "(4 SINGLE ELIMINATION CARDS) (5 DOUBLE ELIMINATION
 * CARDS)". The single/double difference is stated only in the rulebook, so it lives in
 * `clarifications` with a `rulebook` provenance note in the entries below.
 */
const TRIBAL_COUNCIL_RULES_TEXT =
  "When you draw this card, you must put it on the table in front of you IMMEDIATELY. You are the Tribal Council Leader.\n\n" +
  "Start the Tribal Council by encouraging players to talk about who they might be voting for. You decide when it’s time to vote, and you are responsible for breaking ties.\n\n" +
  "Place this card in the Discard Pile after the Tribal Council is finished.";

/**
 * Art. Preserved from the old `src/game/cardlist.json` and `src/game/deck.ts` so the bot keeps
 * the images it already had.
 *
 * The old `tribal_council.ts` stored `https://imgur.com/MPRxVdV` for `tribal_council_single` —
 * an imgur *page*, not a direct image, so it silently failed to embed. The direct form was
 * verified to serve a real 3.9 MB `image/png`, so it is used here. Every entry is an
 * `i.imgur.com` direct link; anything else will not render in a Discord embed.
 */
export const CARD_CATALOG: Readonly<Record<CardKind, CardDefinition>> = {
  [CardKind.TribalCouncilSingle]: {
    kind: CardKind.TribalCouncilSingle,
    name: "Tribal Council (Single Elimination)",
    category: "tribal_council",
    rulesText: TRIBAL_COUNCIL_RULES_TEXT,
    clarifications: [
      // Rulebook, not Survival Guide.
      rb(
        "With a Single Elimination Tribal Council Card, players will vote out 1 player.",
      ),
      rb(
        "The player with the most votes must turn over one of their Survivor Character Cards to indicate that they have been voted out.",
      ),
      rb(
        "Tribal Council Cards are intentionally bigger than the rest of the Action Cards so you always know when the next Tribal Council is coming.",
      ),
    ],
    compactText: "Starts a Tribal Council when drawn. One player is voted out.",
    timing: "never",
    target: { kind: "none" },
    quantityInBox: 4,
    deckRole: "tribal_council",
    perColor: false,
    consumesTurnPlay: false,
    // Direct form of the old imgur page link; see the header note.
    imageUrl: "https://i.imgur.com/MPRxVdV.png",
    source: "survival_guide",
    sortOrder: 0,
    aliases: ["tribal council", "single elimination", "single tribal"],
  },

  [CardKind.TribalCouncilDouble]: {
    kind: CardKind.TribalCouncilDouble,
    name: "Tribal Council (Double Elimination)",
    category: "tribal_council",
    rulesText: TRIBAL_COUNCIL_RULES_TEXT,
    clarifications: [
      rb(
        "With a Double Elimination Tribal Council Card, players will vote out 2 different players.",
      ),
      rb(
        "The 2 different players with the most votes must each turn over one of their Survivor Character Cards to indicate that they have been voted out.",
      ),
      // The word "different" is load-bearing: one player can never lose both character cards
      // at a single Double Elimination, however the votes fall.
      rb(
        "If there are only 3 players left and 2 players would be eliminated at the same time (leaving you with only 1 player left in the game), the Tribal Council Leader decides which of the tied players is eliminated. Immediately begin The Final Tribal Council.",
      ),
    ],
    compactText:
      "Starts a Tribal Council when drawn. Two DIFFERENT players are voted out.",
    timing: "never",
    target: { kind: "none" },
    quantityInBox: 5,
    deckRole: "tribal_council",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/jdv8TpI.png",
    source: "survival_guide",
    sortOrder: 1,
    aliases: ["double elimination", "double tribal"],
  },

  [CardKind.Vote]: {
    kind: CardKind.Vote,
    name: "Vote",
    category: "vote",
    rulesText:
      "Every player gets 1 Vote Card at the start of the game.\n\n" +
      "When voting during a Tribal Council, you MUST place this card in one of the slots in the Voting Box. You must vote for a player in the current Tribal Council.",
    clarifications: [
      rb(
        "After voting has ended, return 1 Vote Card to every player who still has at least one Survivor Character Card left in the game.",
      ),
    ],
    compactText:
      "Your mandatory vote at every Tribal Council. Returned to you after each council.",
    timing: "council_voting",
    // Printed text says "a player", not "another player", and the Voting Box has a slot for
    // every colour including your own — so self-voting is legal here and narrowed, if wanted,
    // by houseRules.allowSelfVote rather than by the catalog.
    target: { kind: "one_player", allowSelf: true, mustBeInGame: true },
    quantityInBox: 6,
    deckRole: "dealt_at_setup",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: null,
    source: "survival_guide",
    sortOrder: 2,
    aliases: ["vote card"],
  },

  [CardKind.ExtraVote]: {
    kind: CardKind.ExtraVote,
    name: "Extra Vote",
    category: "vote",
    rulesText:
      "When voting during a Tribal Council, you MAY place this card in one of the slots in the Voting Box (or save it for later). You must vote for a player in the current Tribal Council.",
    clarifications: [
      rb(
        "If you have Extra Vote Cards, you can use them against the same player, a different player, or save them for later.",
      ),
    ],
    compactText:
      "Optional extra vote during a council. Bankable across councils if unused.",
    // NOT a Tribal Advantage: this is cast DURING voting, not in the pre-voting window.
    // Audit #69: the old code let it be played in any council phase.
    timing: "council_voting",
    target: { kind: "one_player", allowSelf: true, mustBeInGame: true },
    quantityInBox: 7,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/pLcaVhA.jpeg",
    source: "survival_guide",
    sortOrder: 3,
    aliases: ["extra vote card"],
  },

  [CardKind.ImmunityIdol]: {
    kind: CardKind.ImmunityIdol,
    name: "Immunity Idol",
    category: "idol",
    rulesText:
      "Can only be played at Tribal Council AFTER all players have voted, but BEFORE votes are tallied. Any votes cast for you (or the player you choose) do not count.",
    clarifications: [
      sg(
        "If you’re feeling secure and want to make (or protect) an ally, you can use this card for another player instead of yourself.",
      ),
      rb("Any votes for a player who plays an Idol DO NOT count!"),
    ],
    compactText:
      "After all votes, before the tally: zero the votes against you or an ally.",
    timing: "council_idol_window",
    target: { kind: "one_player", allowSelf: true, mustBeInGame: true },
    quantityInBox: 4,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/W7LHM8n.png",
    source: "survival_guide",
    sortOrder: 4,
    aliases: ["idol", "immunity"],
  },

  [CardKind.IdolNullifier]: {
    kind: CardKind.IdolNullifier,
    name: "Idol Nullifier",
    category: "idol",
    // UNOFFICIAL. Absent from both official PDFs. This wording comes from Geeky Hobbies'
    // transcription and matches the old cardlist.json; the printed card face is unverified.
    rulesText:
      "Can only be played after an immunity idol, but before votes are tallied. Cancels that immunity idol.",
    clarifications: [
      note(
        "Not an official card: it is a 68th card hidden in the box under the card holder and a fake cardboard bottom, and appears in neither the rulebook nor the Survival Guide.",
      ),
    ],
    compactText:
      "Cancels one Immunity Idol that was just played, before votes are counted.",
    timing: "council_nullifier_window",
    target: { kind: "played_idol" },
    quantityInBox: 1,
    deckRole: "hidden_easter_egg",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/ZMzsa5c.jpeg",
    source: "unofficial",
    sortOrder: 5,
    aliases: ["nullifier", "idol nullifier"],
  },

  [CardKind.SorryForYou]: {
    kind: CardKind.SorryForYou,
    name: "Sorry For You",
    category: "reaction",
    rulesText:
      "Play ANY time someone tries to take cards from you. Instead, they get nothing from you and must discard 1 card (regardless of how many cards you owe them).",
    clarifications: [
      sg(
        "This includes any card they attempt to steal from you at the start of their turn or any cards they would steal from you as an effect of another card (like the Do Or Die Card).",
      ),
      sg(
        "If you play a Sorry For You after a card that would allow more than 1 player to take cards from you, each of those players gets nothing, and must EACH discard 1 card instead.",
      ),
    ],
    compactText:
      "Cancel any attempted take. The thief (or EACH thief) discards 1 card.",
    timing: "reaction_to_take",
    // Targets the pending take, not a player — which is why the action carries a PendingId.
    target: { kind: "none" },
    quantityInBox: 7,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/hDQD9fq.jpeg",
    source: "survival_guide",
    sortOrder: 6,
    aliases: ["sorry for you", "sorry", "sfy"],
  },

  [CardKind.ControlTheVote]: {
    kind: CardKind.ControlTheVote,
    name: "Tribal Advantage: Control the Vote",
    category: "tribal_advantage",
    rulesText:
      "Play this card during a Tribal Council before voting begins to take any player’s Vote Card. You MUST use that Vote Card in addition to your Vote Card during the Tribal Council at which this card is played.",
    clarifications: [
      sg("If the player you pick has more than 1 Vote Card, you only take 1."),
      rb(
        "You can play as many Tribal Advantage Cards as you would like during this discussion, but NOT once voting has started!",
      ),
      rb(
        "If any votes are gained from a Tribal Advantage Card, they MUST be used during the current Tribal Council.",
      ),
    ],
    compactText:
      "Before voting: take a player’s Vote Card. You must cast both votes this council.",
    timing: "council_before_voting",
    // Printed text says "any player". Taking your own Vote Card is a strict no-op — you would
    // hand it to yourself and owe the same two casts — so the engine refuses it as a misclick
    // rather than as a rules change. Same justification as Camp Raid's `allowSelf: false`.
    target: { kind: "one_player", allowSelf: false, mustBeInGame: true },
    quantityInBox: 2,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/jNlZ87z.jpeg",
    source: "survival_guide",
    sortOrder: 7,
    aliases: ["control the vote", "control vote", "ctv"],
  },

  [CardKind.GoodwillGamble]: {
    kind: CardKind.GoodwillGamble,
    name: "Tribal Advantage: Goodwill Gamble",
    category: "tribal_advantage",
    rulesText:
      "Give this card to another player during a Tribal Council before voting begins. This card counts as 1 vote, and MUST be used during the Tribal Council at which it is played (just like a Vote Card). They can use it to vote for any player they want.",
    clarifications: [
      rb(
        "If any votes are gained from a Tribal Advantage Card, they MUST be used during the current Tribal Council.",
      ),
    ],
    compactText:
      "Before voting: hand another player a vote they MUST cast — at anyone, including you.",
    timing: "council_before_voting",
    target: { kind: "one_player", allowSelf: false, mustBeInGame: true },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/PdlGGRU.jpeg",
    source: "survival_guide",
    sortOrder: 8,
    aliases: ["goodwill gamble", "goodwill"],
  },

  [CardKind.ImTheLeaderNow]: {
    kind: CardKind.ImTheLeaderNow,
    name: "Tribal Advantage: I’m the Leader Now",
    category: "tribal_advantage",
    rulesText:
      "Play this card during a Tribal Council before voting begins to become the Tribal Council Leader. It’s your turn when the Tribal Council ends (or the player after you if you are eliminated).",
    clarifications: [
      rb(
        "You can play as many Tribal Advantage Cards as you would like during this discussion, but NOT once voting has started!",
      ),
    ],
    // Two effects, and audit #70 implemented only the first.
    compactText:
      "Before voting: become Leader (you break every tie) AND take the next turn.",
    timing: "council_before_voting",
    target: { kind: "none" },
    quantityInBox: 1,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/jBGDVDm.jpeg",
    source: "survival_guide",
    sortOrder: 9,
    aliases: [
      "im the leader now",
      "i am the leader now",
      "leader now",
      "im the leader",
    ],
  },

  [CardKind.CampRaid]: {
    kind: CardKind.CampRaid,
    name: "Camp Raid",
    category: "action",
    // The lower-case "you" beginning the second sentence is how the card is printed.
    rulesText:
      "Place this card face up in front of any player. you take the next card they draw at the end of their turn, no matter what it is, but only after they look at it. Then, place this card in the Discard Pile.",
    clarifications: [
      sg(
        "You can’t play this card on a player who already has a Camp Raid in front of them.",
      ),
    ],
    compactText:
      "Mark a player: you take the next card they draw, after they have seen it.",
    timing: "turn_play_step",
    // "Place this card face up in front of ANY PLAYER", and the only printed restriction is the
    // sidebar's "you can't play this card on a player who already has a Camp Raid in front of
    // them" (which the engine checks). Placing it on yourself is self-defeating rather than
    // illegal — and refusing it meant a player whose opponents all carried markers had no legal
    // way to spend the card at all.
    target: { kind: "one_player", allowSelf: true, mustBeInGame: true },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/oKKioMs.jpeg",
    source: "survival_guide",
    sortOrder: 10,
    aliases: ["camp raid", "raid"],
  },

  [CardKind.KnowledgeIsPower]: {
    kind: CardKind.KnowledgeIsPower,
    name: "Knowledge is Power",
    category: "action",
    rulesText:
      "Ask any player for a card by name. If they have it, they must give you 1.",
    clarifications: [
      sg("You can refer back to this Survival Guide if you forget the name of a card."),
    ],
    compactText:
      "Name a card and a player. If they hold it, they hand you exactly one.",
    timing: "turn_play_step",
    target: { kind: "one_player_and_card_kind", allowSelf: false },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/zplia7u.jpeg",
    source: "survival_guide",
    sortOrder: 11,
    aliases: ["knowledge is power", "knowledge", "kip"],
  },

  [CardKind.TheSpyShack]: {
    kind: CardKind.TheSpyShack,
    name: "The Spy Shack",
    category: "action",
    rulesText: "Look at any player’s cards and take one.",
    clarifications: [],
    compactText: "See a player’s whole hand, then take the card you want.",
    timing: "turn_play_step",
    target: { kind: "one_player", allowSelf: false, mustBeInGame: true },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/3gl7xcr.jpeg",
    source: "survival_guide",
    sortOrder: 12,
    aliases: ["the spy shack", "spy shack", "spy"],
  },

  [CardKind.LetsFormAnAlliance]: {
    kind: CardKind.LetsFormAnAlliance,
    name: "Let’s Form an Alliance",
    category: "action",
    // NOTE the absence of the word "random" here, which Power Pair, Do or Die and It's a
    // Numbers Game all print. Genuinely ambiguous; resolved by houseRules.allianceStealIsRandom.
    rulesText:
      "Pick a player to be your partner. You and your partner EACH steal 1 card from any other player (for a total of 2 cards stolen). You can steal from the same player, but you can’t steal from each other.",
    clarifications: [],
    compactText: "Pick a partner; you each steal 1 card — never from each other.",
    timing: "turn_play_step",
    target: { kind: "partner_and_victim" },
    quantityInBox: 4,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/qsFgMZF.png",
    source: "survival_guide",
    sortOrder: 13,
    aliases: ["lets form an alliance", "form an alliance", "alliance"],
  },

  [CardKind.Inheritance]: {
    kind: CardKind.Inheritance,
    name: "Inheritance",
    category: "inheritance",
    rulesText:
      "Each Inheritance Card targets a different color player. When that player is eliminated from the game (by having both of their Survivor Character Cards turned over), you can IMMEDIATELY play this card. You get all of the cards in their hand instead of their cards going in the Discard Pile.",
    clarifications: [
      sg(
        "It can be useful to have the Inheritance for a player that isn’t in the game. You can discard it if someone plays a Sorry For You against you!",
      ),
    ],
    compactText: "When your colour’s player is eliminated, take their entire hand.",
    timing: "reaction_to_elimination",
    // The colour is printed on the card, so there is nothing to point at when playing it.
    target: { kind: "none" },
    quantityInBox: 6,
    // All 6 stay in the deck at every player count: the publisher's own sidebar tells you a
    // dead-colour Inheritance is still useful as Sorry For You discard fodder.
    deckRole: "shuffled",
    perColor: true,
    consumesTurnPlay: false,
    imageUrl: "https://i.imgur.com/DG0IZxh.png",
    source: "survival_guide",
    sortOrder: 14,
    aliases: ["inheritance"],
  },

  [CardKind.DoOrDie]: {
    kind: CardKind.DoOrDie,
    name: "Reward Challenge: Do or Die",
    category: "reward_challenge",
    rulesText:
      "This is a game of trust. Pick any player to play a single game of Rock Paper Scissors against. If you tie, you each swap 1 card of your choice. BUT if either player wins, they steal 2 random cards from the loser.",
    clarifications: [
      sg(
        "You can strategize with the other player before you play! If you want to be nice you can both agree to play the same thing (and discuss which cards you want to swap), OR you can be sneaky and tell them one thing but do another!",
      ),
    ],
    // A SINGLE round: a tie is its own defined outcome, not a replay.
    compactText:
      "One round of Rock Paper Scissors. Winner steals 2 random cards; a tie swaps 1 each.",
    timing: "turn_play_step",
    target: { kind: "one_player", allowSelf: false, mustBeInGame: true },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/ITSs5sv.jpeg",
    source: "survival_guide",
    sortOrder: 15,
    aliases: ["do or die", "rps", "rock paper scissors"],
  },

  [CardKind.PowerPair]: {
    kind: CardKind.PowerPair,
    name: "Reward Challenge: Power Pair",
    category: "reward_challenge",
    rulesText:
      "Pick 2 other players. On the count of three, all 3 players (including you) hold out 1, 2, or 3 fingers.\n\n" +
      "If EXACTLY 2 players show the same number of fingers, they each steal 1 random card from the 3rd player. If ALL players show the same number, each player discards 1 card.\n\n" +
      "If everyone shows a different number of fingers, play again.",
    clarifications: [
      sg(
        "You can discuss what you’re going to do before starting, but you don’t have to tell the truth!",
      ),
    ],
    compactText:
      "You + 2 others show 1-3 fingers. Exactly two matching steal from the third.",
    timing: "turn_play_step",
    target: { kind: "two_players" },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/djyaHCJ.jpeg",
    source: "survival_guide",
    sortOrder: 16,
    aliases: ["power pair"],
  },

  [CardKind.ItsANumbersGame]: {
    kind: CardKind.ItsANumbersGame,
    name: "Reward Challenge: It’s a Numbers Game",
    category: "reward_challenge",
    rulesText:
      "On the count of three, all players (including you) will show 1-5 fingers. The player who shows the lowest UNIQUE number gets to steal 2 random cards from any player.\n\n" +
      "If necessary, repeat until there’s a single winner.",
    clarifications: [],
    // EVERY player participates, and the winner may not be you.
    compactText:
      "Everyone shows 1-5 fingers. Lowest unique number steals 2 random cards from anyone.",
    timing: "turn_play_step",
    target: { kind: "all_players" },
    quantityInBox: 3,
    deckRole: "shuffled",
    perColor: false,
    consumesTurnPlay: true,
    imageUrl: "https://i.imgur.com/nzOc8Cr.jpeg",
    source: "survival_guide",
    sortOrder: 17,
    aliases: ["its a numbers game", "numbers game", "numbers"],
  },

  [CardKind.SurvivorCharacter]: {
    kind: CardKind.SurvivorCharacter,
    name: "Survivor Character Card",
    category: "character",
    // Rulebook, not Survival Guide — the Survival Guide covers Action Cards only.
    rulesText:
      "As long as you have at least one Survivor Character Card, you’re still in the game. When both your Survivor Character Cards are gone, you’re out, but you’ll still play an important role at the end of the game.",
    clarifications: [
      rb(
        "If both of your Survivor Character Cards have been turned over, you are eliminated from the game. When this happens, put your cards face up on top of the Discard Pile.",
      ),
      note(
        'The reverse side reads "VOTED OUT" and shows a snuffed torch. It is turned OVER, not face down — it stays visible.',
      ),
    ],
    compactText:
      "One of your two lives. Both turned over means you are out and join the Jury.",
    timing: "never",
    target: { kind: "none" },
    quantityInBox: 12,
    deckRole: "player_component",
    perColor: true,
    consumesTurnPlay: false,
    imageUrl: null,
    source: "rulebook",
    sortOrder: 18,
    aliases: ["survivor character card", "character card", "torch", "life"],
  },
};

// ---------------------------------------------------------------------------
// Player colours
// ---------------------------------------------------------------------------

export interface PlayerColorDefinition {
  readonly color: PlayerColor;
  readonly label: string;
  /** The icon printed beside the colour on the Survival Guide's Inheritance entry. */
  readonly symbol: string;
  readonly emoji: string;
  /** Hex for Discord embed accents. */
  readonly hex: number;
}

/**
 * The six colours, in Survival Guide order. There are exactly six because there are exactly
 * six Inheritance cards and twelve Survivor Character Cards.
 */
export const PLAYER_COLORS: readonly PlayerColorDefinition[] = [
  { color: "red", label: "Dark Red", symbol: "triangle", emoji: "🔺", hex: 0x8b1a1a },
  { color: "orange", label: "Orange", symbol: "square", emoji: "🟧", hex: 0xe07b16 },
  { color: "magenta", label: "Magenta", symbol: "swirl", emoji: "🌀", hex: 0xc2186f },
  { color: "green", label: "Green", symbol: "leaf", emoji: "🍃", hex: 0x2e8b57 },
  { color: "teal", label: "Teal", symbol: "wave", emoji: "🌊", hex: 0x1a8b8b },
  { color: "yellow", label: "Yellow", symbol: "sun", emoji: "☀️", hex: 0xd9b310 },
];

export function getColorDefinition(color: PlayerColor): PlayerColorDefinition {
  const found = PLAYER_COLORS.find((c) => c.color === color);
  if (!found) throw new Error(`Unknown player color: ${color}`);
  return found;
}

// ---------------------------------------------------------------------------
// The Tribal Council table (rulebook setup step 4)
// ---------------------------------------------------------------------------

export interface TribalCouncilAllocation {
  readonly single: number;
  readonly double: number;
}

/**
 * VERBATIM from the rulebook's setup table, read off the rendered page (the PDF's text
 * extraction scrambles the columns). Independently corroborated by Geeky Hobbies.
 *
 * | Players                | 3 | 4 | 5 | 6 |
 * | Single Elimination     | 4 | 2 | 2 | 0 |
 * | Double Elimination     | 0 | 2 | 3 | 5 |
 * | TOTAL used             | 4 | 4 | 5 | 5 |
 *
 * Audit #6: "Tribal Council single/double counts do not match the official player-count table
 * at any player count" — the old code derived them from a `doubleTribalsRatio` and
 * `playerCount - 1`. There is no formula. It is a lookup table, and this is it.
 */
export const TRIBAL_COUNCIL_TABLE: Readonly<
  Record<PlayerCount, TribalCouncilAllocation>
> = {
  3: { single: 4, double: 0 },
  4: { single: 2, double: 2 },
  5: { single: 2, double: 3 },
  6: { single: 0, double: 5 },
};

export function tribalCouncilAllocation(
  playerCount: PlayerCount,
): TribalCouncilAllocation {
  return TRIBAL_COUNCIL_TABLE[playerCount];
}

export function councilKindOf(kind: CardKind): TribalCouncilKind | null {
  if (kind === CardKind.TribalCouncilSingle) return "single";
  if (kind === CardKind.TribalCouncilDouble) return "double";
  return null;
}

/** How many players go home at a council of this kind. */
export function eliminationsFor(kind: TribalCouncilKind): number {
  return kind === "double" ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Deck composition
// ---------------------------------------------------------------------------

export interface DeckComposition {
  readonly playerCount: PlayerCount;
  /** The cards shuffled together to form the body of the draw pile (setup step 3). */
  readonly shuffled: readonly DeckCompositionEntry[];
  /** Inserted into that pile afterwards, one of them at the very bottom (setup step 5). */
  readonly tribalCouncil: TribalCouncilAllocation;
  /** One per player; the rest leave the game ("put the extras away"). */
  readonly voteCardsDealt: number;
  readonly voteCardsRemoved: number;
  /** Two per player; unused colours leave the game. */
  readonly characterCardsInUse: number;
  readonly characterCardsRemoved: number;
  readonly unusedTribalCouncilCards: number;
  /** Total shuffled cards before dealing. */
  readonly shuffledTotal: number;
  /** Size of the draw pile at the first turn, after hands are dealt and councils inserted. */
  readonly drawPileAtStart: number;
  readonly idolNullifierIncluded: boolean;
}

/**
 * The exact deck for a given player count and configuration.
 *
 * Setup order matters and is encoded here: remove the 9 Tribal Council and 6 Vote cards, deal
 * one Vote Card each, shuffle what remains, deal 3 to each player, THEN insert the Tribal
 * Council cards. That is why `drawPileAtStart` subtracts the dealt hands before adding the
 * council cards.
 */
export function deckCompositionFor(
  playerCount: PlayerCount,
  config: EngineConfig,
): DeckComposition {
  const includeNullifier = config.deck.includeIdolNullifier;

  const shuffled: DeckCompositionEntry[] = [];
  for (const definition of Object.values(CARD_CATALOG)) {
    const included =
      definition.deckRole === "shuffled" ||
      (definition.deckRole === "hidden_easter_egg" && includeNullifier);
    if (included)
      shuffled.push({ kind: definition.kind, count: definition.quantityInBox });
  }
  shuffled.sort(
    (a, b) => CARD_CATALOG[a.kind].sortOrder - CARD_CATALOG[b.kind].sortOrder,
  );

  const shuffledTotal = shuffled.reduce((sum, entry) => sum + entry.count, 0);
  const alloc = TRIBAL_COUNCIL_TABLE[playerCount];
  const councilCards = alloc.single + alloc.double;

  const voteCardsDealt = playerCount * config.limits.voteCardsPerPlayerAtSetup;
  const characterCardsInUse = playerCount * config.limits.characterCardsPerPlayer;
  const dealtToHands = playerCount * config.limits.startingHandSize;

  return {
    playerCount,
    shuffled,
    tribalCouncil: alloc,
    voteCardsDealt,
    voteCardsRemoved: CARD_CATALOG[CardKind.Vote].quantityInBox - voteCardsDealt,
    characterCardsInUse,
    characterCardsRemoved: CHARACTER_CARDS_IN_BOX - characterCardsInUse,
    unusedTribalCouncilCards:
      CARD_CATALOG[CardKind.TribalCouncilSingle].quantityInBox +
      CARD_CATALOG[CardKind.TribalCouncilDouble].quantityInBox -
      councilCards,
    shuffledTotal,
    drawPileAtStart: shuffledTotal - dealtToHands + councilCards,
    idolNullifierIncluded: includeNullifier,
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getCard(kind: CardKind): CardDefinition {
  return CARD_CATALOG[kind];
}

/**
 * Read the colour off a card instance without narrowing by hand.
 *
 * `CardInstance` is a union: only Inheritance and Survivor Character instances carry a
 * `color`, and for those two it is mandatory rather than optional (audit #100). This is the
 * one place that distinction is turned back into a nullable for callers that do not care.
 */
export function colorOf(card: CardInstance): PlayerColor | null {
  return isColoredCard(card) ? card.color : null;
}

export function isColoredCard(card: CardInstance): card is ColoredCardInstance {
  return card.kind === CardKind.Inheritance || card.kind === CardKind.SurvivorCharacter;
}

/**
 * Cards a player could be asked to name — the legal answers to Knowledge is Power.
 *
 * TAKES THE DECK CONFIG, because `hidden_easter_egg` is the Idol Nullifier alone and whether
 * the Idol Nullifier exists at all is a per-game setting: `deckCompositionFor` only includes it
 * when `deck.includeIdolNullifier` is true, so with the flag off no instance is ever minted.
 * The engine already guards the card's own action with `feature_disabled` for exactly this
 * reason — but this list did not, so a table playing the box as printed was OFFERED "Idol
 * Nullifier" by the autocomplete, asked for it, and was told the target did not have it. A
 * guaranteed miss that burns one of only three copies of the card, and the "no" is public
 * information (`knowledge_is_power_answered`), so the whole table drew a conclusion from an
 * answer that could only ever have been no.
 */
export function nameableKinds(
  deck: Pick<DeckConfig, "includeIdolNullifier">,
): readonly CardKind[] {
  return Object.values(CARD_CATALOG)
    .filter(
      (c) =>
        c.deckRole === "shuffled" ||
        (c.deckRole === "hidden_easter_egg" && deck.includeIdolNullifier),
    )
    .map((c) => c.kind);
}

/** Strip case and punctuation so "I'm the Leader Now" and "im the leader now" both match. */
function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NAME_INDEX: ReadonlyMap<string, CardKind> = (() => {
  const index = new Map<string, CardKind>();
  for (const definition of Object.values(CARD_CATALOG)) {
    index.set(normalizeName(definition.name), definition.kind);
    index.set(normalizeName(definition.kind), definition.kind);
    for (const alias of definition.aliases) {
      // First registration wins, so a shared alias never silently reassigns a card.
      if (!index.has(normalizeName(alias)))
        index.set(normalizeName(alias), definition.kind);
    }
  }
  return index;
})();

/**
 * Resolve a human-typed card name to a `CardKind`.
 *
 * Audit #80/#91: `/knowledge_is_power` took a free-text, case-sensitive card name with no
 * autocomplete and burned the card on a typo. The rewrite passes a `CardKind` in the action;
 * this helper exists only to back the autocomplete handler.
 */
export function lookupCardKindByName(input: string): CardKind | null {
  return NAME_INDEX.get(normalizeName(input)) ?? null;
}

// ---------------------------------------------------------------------------
// Self-check (used by tests; pure, no side effects)
// ---------------------------------------------------------------------------

/**
 * Verify the catalog against the printed box contents. Returns a list of problems; an empty
 * list means the data matches the physical game. The old cardlist.json summed to 46 against a
 * printed 67, and nothing in the codebase noticed.
 */
export function validateCatalog(): readonly string[] {
  const problems: string[] = [];

  const actionCardTotal = Object.values(CARD_CATALOG)
    .filter(
      (c) => c.deckRole !== "player_component" && c.deckRole !== "hidden_easter_egg",
    )
    .reduce((sum, c) => sum + c.quantityInBox, 0);
  if (actionCardTotal !== ACTION_CARDS_IN_BOX) {
    problems.push(
      `Action cards sum to ${actionCardTotal}, expected ${ACTION_CARDS_IN_BOX}`,
    );
  }

  const characterTotal = CARD_CATALOG[CardKind.SurvivorCharacter].quantityInBox;
  if (characterTotal !== CHARACTER_CARDS_IN_BOX) {
    problems.push(
      `Survivor Character cards sum to ${characterTotal}, expected ${CHARACTER_CARDS_IN_BOX}`,
    );
  }

  // The hidden 68th card, checked for the same reason as the printed 67: `nameableKinds()` and
  // `deckCompositionFor()` both branch on `hidden_easter_egg`, so a second card acquiring that
  // role would silently change what Knowledge is Power may name and what the deck can hold.
  const hiddenTotal = Object.values(CARD_CATALOG)
    .filter((c) => c.deckRole === "hidden_easter_egg")
    .reduce((sum, c) => sum + c.quantityInBox, 0);
  if (hiddenTotal !== HIDDEN_CARDS_IN_BOX) {
    problems.push(
      `Hidden cards sum to ${hiddenTotal}, expected ${HIDDEN_CARDS_IN_BOX} (the Idol Nullifier)`,
    );
  }

  // The 52 that actually get shuffled. Derived from the 67 by removing the 9 Tribal Council
  // and 6 Vote cards; a deckRole edit that leaves the printed quantities alone would slip past
  // the check above but not past this one.
  const shuffledTotal = Object.values(CARD_CATALOG)
    .filter((c) => c.deckRole === "shuffled")
    .reduce((sum, c) => sum + c.quantityInBox, 0);
  if (shuffledTotal !== SHUFFLED_CARDS_IN_BOX) {
    problems.push(
      `Shuffled cards sum to ${shuffledTotal}, expected ${SHUFFLED_CARDS_IN_BOX}`,
    );
  }

  const perColorCount = PLAYER_COLORS.length;
  if (perColorCount !== 6) {
    problems.push(`PLAYER_COLORS must hold exactly 6 colours, has ${perColorCount}`);
  }
  if (CARD_CATALOG[CardKind.Inheritance].quantityInBox !== perColorCount) {
    problems.push("Inheritance quantity must equal the number of player colours");
  }
  if (characterTotal !== perColorCount * 2) {
    problems.push("Survivor Character quantity must be 2 per player colour");
  }

  // Setup step 4's printed grid: 3p 4/0, 4p 2/2, 5p 2/3, 6p 0/5 — totals 4, 4, 5, 5.
  const EXPECTED_COUNCIL_TOTALS: Readonly<Record<string, number>> = {
    "3": 4,
    "4": 4,
    "5": 5,
    "6": 5,
  };
  for (const [playerCount, alloc] of Object.entries(TRIBAL_COUNCIL_TABLE)) {
    if (alloc.single > CARD_CATALOG[CardKind.TribalCouncilSingle].quantityInBox) {
      problems.push(`${playerCount}p uses more Single Elimination cards than exist`);
    }
    if (alloc.double > CARD_CATALOG[CardKind.TribalCouncilDouble].quantityInBox) {
      problems.push(`${playerCount}p uses more Double Elimination cards than exist`);
    }
    const expectedTotal = EXPECTED_COUNCIL_TOTALS[playerCount];
    if (expectedTotal === undefined) {
      problems.push(`TRIBAL_COUNCIL_TABLE has an entry for ${playerCount} players`);
    } else if (alloc.single + alloc.double !== expectedTotal) {
      problems.push(
        `${playerCount}p uses ${alloc.single + alloc.double} Tribal Council cards, printed table says ${expectedTotal}`,
      );
    }
  }

  for (const definition of Object.values(CARD_CATALOG)) {
    if (definition.rulesText.trim() === "") {
      problems.push(`${definition.kind} has empty rules text`);
    }
    if (definition.timing === "turn_play_step" && !definition.consumesTurnPlay) {
      problems.push(
        `${definition.kind} is played on your turn but does not consume the play`,
      );
    }
    if (definition.timing !== "turn_play_step" && definition.consumesTurnPlay) {
      problems.push(`${definition.kind} consumes the turn play outside the play step`);
    }
    // "Tribal Advantage" is a printed CATEGORY, and the pre-voting window belongs to it and
    // nothing else. Audit #69 is exactly this drift: Extra Vote filed as a Tribal Advantage
    // and therefore playable before voting opened, when it is cast DURING the vote.
    if (
      definition.timing === "council_before_voting" &&
      definition.category !== "tribal_advantage"
    ) {
      problems.push(
        `${definition.kind} has the pre-voting timing but is not a tribal_advantage`,
      );
    }
    if (
      definition.category === "tribal_advantage" &&
      definition.timing !== "council_before_voting"
    ) {
      problems.push(
        `${definition.kind} is a tribal_advantage but is not playable before voting`,
      );
    }
  }

  return problems;
}
