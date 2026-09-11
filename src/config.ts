/**
 * Every tunable in the entire bot lives here.
 *
 * WHY: audit finding #95 — "Every duration is a hardcoded literal scattered across seven
 * files, with no config module and no way to shorten a council for testing — and the UI
 * text already contradicts the code". The rule for the rewrite is absolute: no other module
 * may contain a bare numeric literal that represents a duration, a limit, or a deck option.
 * If a number describes a *rule* (7 Sorry For You cards, 4 Tribal Council cards at 3 players)
 * it belongs in `src/engine/cards.ts` as catalog data instead; if it describes a *policy*
 * (how long we wait for a reaction, whether the hidden 68th card is in play) it belongs here.
 *
 * PURITY: this module reads `process.env` exactly once, at import time, to produce the live
 * `config` singleton. It imports nothing — deliberately, so that `src/engine/**` importing a
 * *type* from here can never become an import cycle with a runtime edge. Engine modules may
 * import the types and `DEFAULT_CONFIG`, but must receive their working config as an explicit
 * parameter (see `EngineConfig`), so a test can construct a game with different timings without
 * touching the environment and the engine stays deterministic.
 *
 * VALIDATION: `loadConfig` clamps every value it reads and `validateConfig` reports anything
 * still out of range. A typo in a deployment env var must fail at startup, not manifest as a
 * wedged game two hours later.
 */

/** Milliseconds. Aliased so every duration in the file is self-describing. */
export type Milliseconds = number;

/** Legal player counts. The rulebook's Tribal Council table is defined only for 3-6. */
export type PlayerCount = 3 | 4 | 5 | 6;

// ---------------------------------------------------------------------------
// Slices
// ---------------------------------------------------------------------------

/**
 * Hard structural limits taken from the printed components and setup steps.
 *
 * These are NOT house rules — changing them produces a game that is not Survivor. They live
 * in config anyway so that tests and the deck builder read one number instead of ten.
 */
export interface LimitsConfig {
  /** Rulebook: "3-6 players". */
  readonly minPlayers: PlayerCount;
  readonly maxPlayers: PlayerCount;
  /** Setup step 3: "deal 3 of them face down to each player". */
  readonly startingHandSize: number;
  /** Setup step 1: each player takes "the 2 Survivor Character Cards of that color". */
  readonly characterCardsPerPlayer: number;
  /** Setup step 2: "Give each player 1 Vote Card, and put the extras away". */
  readonly voteCardsPerPlayerAtSetup: number;
  /**
   * Rulebook: no maximum hand size is stated and there is no discard-down step, so this is
   * `null` by default. A finite value here is a house rule, not a rule.
   */
  readonly maxHandSize: number | null;
  /**
   * How many Tribal Council cards must sit below the last non-council card, i.e. the
   * bottom-of-deck guarantee from setup step 5 ("place 1 face down at the bottom").
   * Audit #7: the old deck builder guaranteed this at 6 players only.
   */
  readonly tribalCouncilCardsAtDeckBottom: number;
  /**
   * How many times `afterMutation` may run its fixpoint before it declares the state machine
   * stuck.
   *
   * The engine's ONE progress bound, and it was a bare `16` in the middle of `game.ts` — which
   * this file's own header forbids in as many words ("no other module may contain a bare
   * numeric literal that represents a duration, a limit, or a deck option"). Worse, exhausting
   * it was indistinguishable from finishing: the loop simply fell out, `dispatch` reported a
   * clean `changed: true`, the snapshot was written, and the table was narrated a state that
   * had stopped half way. Exhaustion is now an invariant break, because "the fixpoint did not
   * converge" is a bug in the engine and must never be mistaken for "there was nothing left to
   * do" — and the bound is set well above the deepest cascade the rules can produce (a double
   * elimination with two Inheritance windows and a knock-on Final Council is about ten steps).
   */
  readonly maxCascadeSteps: number;
}

/**
 * Deck construction options.
 *
 * `includeIdolNullifier` is the one genuinely non-canonical toggle: the Idol Nullifier is a
 * physically hidden 68th card that appears in NEITHER official PDF. The old bot shuffled it
 * into the deck as an ordinary card, so the default stays ON for continuity — but it is a
 * documented divergence and the Discord layer is expected to say so in-app (see the
 * `house_rule_applied` event).
 */
export interface DeckConfig {
  readonly includeIdolNullifier: boolean;
  /**
   * Fixed seed for the game PRNG. `null` means "the caller supplies one".
   *
   * NOTE: the engine no longer has a fallback. `CreateGameParams.seed` is REQUIRED, and
   * `randomSeed()` lives in the Discord/session layer (`src/discord/seed.ts`), because
   * `Math.random()` and `Date.now()` are platform calls and `src/engine/**` may make neither.
   * A seed makes an entire game reproducible, which is the whole point of `engine/rng.ts`.
   */
  readonly rngSeed: number | null;
  /**
   * Setup step 5: the non-bottom Tribal Council cards are spaced "evenly(ish)" through the
   * deck. This is the jitter, as a fraction of one even segment, applied to each ideal slot.
   * 0 = perfectly even (fully predictable), 1 = a full segment of slop either way.
   * Clamped to [0, 1] on read: a jitter above 1 pushes insertion slots outside the deck.
   */
  readonly tribalCouncilSpacingJitter: number;
}

/**
 * Every interruption window in the game, keyed by the `PendingKind` it belongs to.
 *
 * WHY a record and not eight named fields: audit #95 recurs the moment a new pending kind has
 * no home here and its implementer reaches for a bare literal. `PendingAllianceTarget` and
 * `PendingStealVictim` were exactly that gap. `src/engine/types.ts` asserts at COMPILE TIME
 * that this key set equals `PendingKind` (see `PendingWindowsCoverEveryPendingKind`), so
 * adding a ninth pending kind is a type error in this file rather than a missing literal in
 * the engine.
 *
 * Kept as a plain string union rather than importing `PendingKind` so that config.ts still
 * imports nothing at all.
 */
export type PendingWindowKind =
  | "take"
  | "discard"
  | "challenge"
  | "card_choice"
  | "alliance_target"
  | "steal_victim"
  | "leader_decision"
  | "inheritance";

/**
 * Every clock in the game.
 *
 * WHY these are all backstops: audit #25/#44/#64/#72 — the old Tribal Council ran on a fixed
 * 10m30s of `setTimeout` sleeps against a Discord interaction token that dies at 15 minutes,
 * so its later messages simply threw, and there was no way to end a phase early. In the
 * rewrite EVERY phase advances on an explicit Leader action; these deadlines exist only so a
 * disconnected player cannot wedge a game forever. The engine stores deadlines as absolute
 * timestamps in state and expires them inside `tick()`; it never calls `setTimeout` itself.
 */
export interface TimingConfig {
  /**
   * One window per pending kind. `take` is the Sorry For You reaction window; `inheritance`
   * is short because the card says "IMMEDIATELY"; `leader_decision` is a generous safety
   * backstop because the Leader, not the clock, decides a tie (audit #31, #77).
   */
  readonly pendingWindows: Readonly<Record<PendingWindowKind, Milliseconds>>;

  // --- Council phase windows. Phases, not pendings: nobody is being waited on by id. ---

  /** Immunity Idol window: after every vote is in, before the box is opened. */
  readonly idolWindow: Milliseconds;
  /** Idol Nullifier window: after an idol is played, still before the tally. */
  readonly nullifierWindow: Milliseconds;

  // --- Safety backstops. Generous by design: the Leader, not the clock, runs the council. ---

  /** Backstop on the whole turn (steal + play + draw) before the game nags/auto-advances. */
  readonly turnSafetyTimeout: Milliseconds;
  /** Backstop on the Tribal Advantage + Discussion phases combined. */
  readonly councilDiscussionSafetyTimeout: Milliseconds;
  /** Backstop on the voting phase once the Leader has opened it. */
  readonly councilVotingSafetyTimeout: Milliseconds;
  /** Backstop on any single Final Tribal Council phase. */
  readonly finalCouncilPhaseSafetyTimeout: Milliseconds;
  /** Backstop on the Jury vote. */
  readonly juryVoteSafetyTimeout: Milliseconds;
  /** Pause between revealing consecutive votes during the dramatic tally. */
  readonly voteRevealInterval: Milliseconds;
  /**
   * How often the Discord layer should call `Game.tick()` when a deadline is pending.
   * The layer schedules a single timer to `nextDeadline()`; this is the floor on it.
   */
  readonly tickInterval: Milliseconds;
}

/**
 * Answers to the rules questions the printed rulebook genuinely does not answer.
 *
 * WHY they are config and not constants: docs/RULES.md lists each of these as unresolved,
 * with the sources that make it unresolved. Hard-coding a reading would silently make the bot
 * "wrong" for a table that reads it the other way. Defaults follow the most-supported reading
 * and the engine emits a `house_rule_applied` event whenever one of these actually decides an
 * outcome, so the table can see the bot showing its work.
 */
export interface HouseRulesConfig {
  /**
   * Knowledge is Power says the target "must GIVE you 1"; Sorry For You triggers on "TAKE".
   * Default true = the broader reading of "Play ANY time someone tries to take cards from you".
   */
  readonly sorryForYouBlocksKnowledgeIsPower: boolean;
  /** The Spy Shack says "take", so it should be blockable. */
  readonly sorryForYouBlocksSpyShack: boolean;
  /**
   * If Spy Shack is blocked, did the spy already see the hand? Default true: the card reads
   * "Look at any player's cards and take one" — the look happens first in reading order.
   */
  readonly spyShackLookHappensBeforeBlock: boolean;
  /**
   * Camp Raid is a delayed take of a card not yet drawn. Default true = blockable at the
   * moment it resolves (not at the moment the marker is placed).
   */
  readonly sorryForYouBlocksCampRaid: boolean;
  /**
   * Control the Vote says it "takes" a Vote Card and Sorry For You says "ANY time someone
   * tries to TAKE cards from you", so on the plain reading it is blockable. Nothing printed
   * addresses the pair directly, so it is disclosed here rather than decided silently.
   */
  readonly sorryForYouBlocksControlTheVote: boolean;
  /**
   * BGG 3513552, unrefuted community answer, quoting Camp Raid's "no matter what it is":
   * the raider takes a drawn Tribal Council card and becomes Leader. Directly contradicts the
   * rulebook's "place it face up in front of YOU immediately"; genuinely open.
   */
  readonly campRaidTakesTribalCouncilCard: boolean;
  /**
   * Vote card: "You must vote for a player in the current Tribal Council" — it does not say
   * "another player", and the Voting Box has a slot for every color including your own.
   */
  readonly allowSelfVote: boolean;
  /** Nothing forbids voting for a player who has already been fully eliminated; we do. */
  readonly allowVotingForEliminatedPlayer: boolean;
  /**
   * BGG 3487916: "Can one player play more than 1 immunity idol?" The one-card-per-turn limit
   * does not apply at Tribal Council, which argues yes.
   */
  readonly allowMultipleIdolsPerPlayerPerCouncil: boolean;
  /**
   * Let's Form an Alliance omits the word "random" that Power Pair, Do or Die and It's a
   * Numbers Game all print. Default true (random) matches the old bot and the other steals.
   */
  readonly allianceStealIsRandom: boolean;
  /**
   * Idol Nullifier: cancels the one idol play it names, not every idol played that council.
   * (4 idols exist and only 1 nullifier, so "all" would be wildly out of scale.)
   */
  readonly nullifierCancelsAllIdols: boolean;
  /**
   * The turn-start steal is mandatory, but nothing says what to do when every legal target
   * has an empty hand. Default true = you may declare the steal against an empty hand and
   * simply get nothing, which keeps the step mandatory without deadlocking the turn.
   */
  readonly allowStealFromEmptyHand: boolean;
  /**
   * Is the Vote Card part of your hand for the purposes of a steal?
   *
   * docs/RULES.md:406 asserts it is held apart and cannot be stolen, but cites no printed
   * sentence — nothing in either PDF says so. It is a good reading (a stolen Vote Card would
   * break "Everyone must vote") but it IS a reading, so it is disclosed here like the others.
   * Default false = the Vote Card lives in its own zone and only Control the Vote takes it.
   */
  readonly voteCardIsStealable: boolean;
  /**
   * Tie-break ladder, third rung. The rulebook says "Choose from the players who played
   * Immunity Idols" — the players who PLAYED them, which is not the same set as the players
   * PROTECTED by them, because an idol may protect an ally. Default false = the printed
   * reading (idol players only). True widens the rung to include protected players too.
   * See `TIE_BREAK_LADDER` in engine/types.ts.
   */
  readonly tieBreakIdolTierIncludesProtected: boolean;
  /**
   * DRAW PILE EXHAUSTION. Setup guarantees the bottom card is a Tribal Council card, so the
   * last draw always fires a council — but nothing covers a council that ends with 3+ players
   * alive and an empty pile. This is an invented rule either way.
   *
   * `final_council` (default): every player except the two holding the most Survivor Character
   * Cards is FULLY eliminated, in reverse turn order from the current player, so they enter
   * the Jury through the normal `player_eliminated` path and the Final Council Leader stays
   * derivable from `max(eliminatedAtSeq)`. Ties on character-card count are broken by fewest
   * cards flipped, then by the game RNG. `draw` ends the game with no winner.
   *
   * (`sudden_death` was removed: it was specified as "keep drawing councils" from a pile that
   * is by definition empty, and was incoherent as written.)
   */
  readonly drawPileExhaustionPolicy: "final_council" | "draw";
}

/** Persistence policy. Not engine state — the engine is pure and never touches a disk. */
export interface AutosaveConfig {
  readonly enabled: boolean;
  /**
   * Directory for snapshots. One file per channel-scoped game.
   * These files contain real Discord snowflakes; `.gitignore` covers this path.
   *
   * NOTE: the snapshot SCHEMA VERSION is deliberately NOT here. It is
   * `SNAPSHOT_SCHEMA_VERSION` in `engine/types.ts`, because the engine owns its own format
   * and `restoreGame` — which must reject an unsupported version — is not handed an
   * `AutosaveConfig` and never will be (audit #98/#102).
   */
  readonly directory: string;
  /**
   * Save after every state-changing dispatch, not just at end of turn (audit #60: the old
   * bot's only save trigger was /end_turn, so every Tribal Council was lost on a crash).
   * The write rule is exactly `if (outcome.changed)` — see `DispatchOutcome.changed`.
   */
  readonly saveOnEveryMutation: boolean;
  /** Minimum gap between writes so a burst of actions does not thrash the disk. */
  readonly debounceInterval: Milliseconds;
  /** How many historical snapshots to retain per game before pruning. At least 1. */
  readonly keepSnapshots: number;
  /**
   * Audit #124: /resume read an arbitrary caller-supplied filesystem path with no
   * authorization. Restores are keyed by game id inside `directory` and nothing else.
   */
  readonly allowArbitraryRestorePaths: boolean;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Discord-layer knobs and platform constants. Never imported by the engine. */
export interface DiscordConfig {
  /** Env var holding the bot token. The token itself never lives in config. */
  readonly tokenEnvVar: string;
  readonly clientIdEnvVar: string;
  readonly devGuildIdEnvVar: string;
  /** Hard Discord platform limits, centralized so no renderer re-derives them (audit #86). */
  readonly maxMessageLength: number;
  readonly maxEmbedDescriptionLength: number;
  readonly maxSelectMenuOptions: number;
  readonly maxButtonsPerRow: number;
  readonly maxActionRowsPerMessage: number;
  /**
   * Discord rejects a `custom_id` longer than this. `discord/ui.ts` refuses to mint one rather
   * than discovering it as a 400 from the API at the worst possible moment.
   */
  readonly maxCustomIdLength: number;
  /** Select option label and description ceiling. Longer text is elided, never rejected. */
  readonly maxSelectOptionLabelLength: number;
  /**
   * A BUTTON's label ceiling, which is 80 — NOT the select option's 100. `ui.button()` used the
   * select ceiling, so an 81-character label would have been passed through unchanged and the
   * API would have rejected the whole message with a 400 rather than clipping one button. This
   * is exactly the "several renderers re-derived Discord's limits and one of them got it wrong"
   * failure the table exists to prevent (audit #86/#95).
   */
  readonly maxButtonLabelLength: number;
  readonly maxEmbedFieldValueLength: number;
  readonly maxEmbedsPerMessage: number;
  /**
   * Discord's ceiling on the total text across ALL embeds in one message. `/hand` is the only
   * surface that can approach it — an unbounded hand plus two remembered peeks — and it budgets
   * against this rather than hoping the box is small enough.
   */
  readonly maxEmbedTotalLength: number;
  /**
   * How many past hand-peeks (`Spy Shack`, `Knowledge is Power`) `/hand` shows back to a player.
   * A display POLICY, not a platform limit, which is why it is named here rather than left as a
   * bare `.slice(-2)` in the renderer where nothing recorded that 2 was a decision.
   */
  readonly handRevealHistoryShown: number;
  /**
   * Consecutive failed `channel.send`s before a session gives up on its channel.
   *
   * `GameSession.dispose()` documents itself as covering "a channel that has gone away", and
   * nothing ever called it for that reason: a deleted channel, a bot kicked from a guild or an
   * archived thread left a live, ticking, autosaving session playing the game to completion
   * against a channel nobody could see, for hours. This is the trigger that makes the
   * documented path reachable, and it covers the kicked-from-guild case a `channelDelete`
   * listener would not. The save is FLUSHED, never deleted, so `/survivor resume` picks the
   * game up if the channel comes back.
   */
  readonly maxConsecutivePublishFailures: number;
  /**
   * Discord closes an unacknowledged interaction after 3 seconds and shows the player "The
   * application did not respond" — audit #16/#42. `discord/interactions.ts` treats this as a
   * hard deadline rather than a guideline.
   */
  readonly initialResponseDeadline: Milliseconds;
  /**
   * How long a handler may work before the acknowledgement helper defers on its own initiative.
   * MUST be less than `initialResponseDeadline`; `validateConfig` enforces it.
   */
  readonly autoDeferAfter: Milliseconds;
  /**
   * Node silently clamps a `setTimeout` delay above 2^31-1 ms to 1 ms — i.e. a deadline three
   * weeks out would fire immediately, forever. The session timer re-arms in hops of at most
   * this instead (see `discord/registry.ts`).
   */
  readonly maxTimerDelay: Milliseconds;
  /** Discord kills an interaction token after 15 minutes; we refuse to plan past this. */
  readonly interactionTokenLifetime: Milliseconds;
  /** Component collectors are scoped per message and per user; this is their ceiling. */
  readonly componentCollectorTimeout: Milliseconds;
  /** Audit #90: card art was pasted as bare URLs and vanished without Embed Links. */
  readonly renderCardArt: boolean;
  /** Prefix for every custom_id we mint, so collectors can be scoped by game id. */
  readonly customIdPrefix: string;
  /** Audit #41/#43: there was no logging or ops story at all. See ARCHITECTURE.md §10. */
  readonly logLevel: LogLevel;
}

/**
 * The slice handed to the engine. Deliberately excludes `discord` and `autosave` so that
 * `src/engine/**` cannot even name them, and so a snapshot can embed the exact rule policy a
 * game was started under (a mid-game config change must never retroactively alter a game).
 */
export interface EngineConfig {
  readonly limits: LimitsConfig;
  readonly deck: DeckConfig;
  readonly timings: TimingConfig;
  readonly houseRules: HouseRulesConfig;
}

export interface SurvivorConfig {
  readonly engine: EngineConfig;
  readonly autosave: AutosaveConfig;
  readonly discord: DiscordConfig;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const DEFAULT_CONFIG: SurvivorConfig = {
  engine: {
    limits: {
      minPlayers: 3,
      maxPlayers: 6,
      startingHandSize: 3,
      characterCardsPerPlayer: 2,
      voteCardsPerPlayerAtSetup: 1,
      maxHandSize: null,
      tribalCouncilCardsAtDeckBottom: 1,
      maxCascadeSteps: 64,
    },
    deck: {
      includeIdolNullifier: true,
      rngSeed: null,
      tribalCouncilSpacingJitter: 0.25,
    },
    timings: {
      pendingWindows: {
        take: 20 * SECOND,
        discard: 60 * SECOND,
        challenge: 60 * SECOND,
        card_choice: 60 * SECOND,
        alliance_target: 60 * SECOND,
        steal_victim: 60 * SECOND,
        leader_decision: 5 * MINUTE,
        inheritance: 30 * SECOND,
      },

      idolWindow: 45 * SECOND,
      nullifierWindow: 30 * SECOND,

      turnSafetyTimeout: 10 * MINUTE,
      councilDiscussionSafetyTimeout: 20 * MINUTE,
      councilVotingSafetyTimeout: 5 * MINUTE,
      finalCouncilPhaseSafetyTimeout: 20 * MINUTE,
      juryVoteSafetyTimeout: 10 * MINUTE,
      voteRevealInterval: 2500,
      tickInterval: SECOND,
    },
    houseRules: {
      sorryForYouBlocksKnowledgeIsPower: true,
      sorryForYouBlocksSpyShack: true,
      spyShackLookHappensBeforeBlock: true,
      sorryForYouBlocksCampRaid: true,
      sorryForYouBlocksControlTheVote: true,
      campRaidTakesTribalCouncilCard: true,
      allowSelfVote: true,
      allowVotingForEliminatedPlayer: false,
      allowMultipleIdolsPerPlayerPerCouncil: true,
      allianceStealIsRandom: true,
      nullifierCancelsAllIdols: false,
      allowStealFromEmptyHand: true,
      voteCardIsStealable: false,
      tieBreakIdolTierIncludesProtected: false,
      drawPileExhaustionPolicy: "final_council",
    },
  },
  autosave: {
    enabled: true,
    directory: ".survivor-state",
    saveOnEveryMutation: true,
    debounceInterval: 2 * SECOND,
    keepSnapshots: 3,
    allowArbitraryRestorePaths: false,
  },
  discord: {
    tokenEnvVar: "DISCORD_TOKEN",
    clientIdEnvVar: "DISCORD_CLIENT_ID",
    devGuildIdEnvVar: "DISCORD_GUILD_ID",
    maxMessageLength: 2000,
    maxEmbedDescriptionLength: 4096,
    maxSelectMenuOptions: 25,
    maxButtonsPerRow: 5,
    maxActionRowsPerMessage: 5,
    maxCustomIdLength: 100,
    maxSelectOptionLabelLength: 100,
    maxButtonLabelLength: 80,
    maxEmbedFieldValueLength: 1024,
    maxEmbedsPerMessage: 10,
    maxEmbedTotalLength: 6000,
    handRevealHistoryShown: 2,
    maxConsecutivePublishFailures: 5,
    initialResponseDeadline: 3 * SECOND,
    autoDeferAfter: 2 * SECOND,
    maxTimerDelay: 2_147_483_647,
    interactionTokenLifetime: 15 * MINUTE,
    componentCollectorTimeout: 5 * MINUTE,
    renderCardArt: true,
    customIdPrefix: "sv",
    logLevel: "info",
  },
};

// ---------------------------------------------------------------------------
// Environment overrides
// ---------------------------------------------------------------------------

/** Shape of the environment we read. Kept structural so tests can pass a plain object. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** Every env var is namespaced so an unrelated `SEED` in the shell cannot reach the game. */
export const ENV_PREFIX = "SURVIVOR_";

/**
 * Inclusive bounds applied to a value read from the environment.
 * WHY clamp rather than only report: `SURVIVOR_IDOL_MS=-1` produces a window that has already
 * expired the instant it opens, which makes every idol play impossible. Clamping means a typo
 * degrades to the nearest legal value; `validateConfig` still reports it.
 */
interface NumberRange {
  readonly min?: number;
  readonly max?: number;
}

function clampToRange(value: number, range?: NumberRange): number {
  let out = value;
  if (range?.min !== undefined && out < range.min) out = range.min;
  if (range?.max !== undefined && out > range.max) out = range.max;
  return out;
}

/** Smallest duration we will accept: below this, a window is unusable. */
const MIN_DURATION_MS = 1;
/** A tick faster than this is a busy loop against the Discord gateway, not a timer. */
const MIN_TICK_MS = 50;

function readInt(
  env: Environment,
  key: string,
  fallback: number,
  range?: NumberRange,
): number {
  const raw = env[ENV_PREFIX + key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? clampToRange(parsed, range) : fallback;
}

/** Every pending/phase duration reads through here, so the floor is stated exactly once. */
function readDuration(
  env: Environment,
  key: string,
  fallback: Milliseconds,
): Milliseconds {
  return readInt(env, key, fallback, { min: MIN_DURATION_MS });
}

function readOptionalInt(
  env: Environment,
  key: string,
  fallback: number | null,
): number | null {
  const raw = env[ENV_PREFIX + key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw.trim().toLowerCase() === "null") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(
  env: Environment,
  key: string,
  fallback: number,
  range?: NumberRange,
): number {
  const raw = env[ENV_PREFIX + key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? clampToRange(parsed, range) : fallback;
}

function readBool(env: Environment, key: string, fallback: boolean): boolean {
  const raw = env[ENV_PREFIX + key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readString(env: Environment, key: string, fallback: string): string {
  const raw = env[ENV_PREFIX + key];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

function readEnum<T extends string>(
  env: Environment,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = env[ENV_PREFIX + key];
  if (raw === undefined) return fallback;
  // The cast follows the check that justifies it: narrow only once `includes` has proved the
  // string is a member. This is the only cast in the file.
  const normalized = raw.trim().toLowerCase();
  return (allowed as readonly string[]).includes(normalized)
    ? (normalized as T)
    : fallback;
}

/** Env var name for each pending window, so the mapping is data rather than eight call sites. */
const PENDING_WINDOW_ENV_KEYS: Readonly<Record<PendingWindowKind, string>> = {
  take: "SORRY_FOR_YOU_MS",
  discard: "FORCED_DISCARD_MS",
  challenge: "CHALLENGE_MS",
  card_choice: "CARD_SELECTION_MS",
  alliance_target: "ALLIANCE_TARGET_MS",
  steal_victim: "STEAL_VICTIM_MS",
  leader_decision: "LEADER_DECISION_TIMEOUT_MS",
  inheritance: "INHERITANCE_MS",
};

function readPendingWindows(
  env: Environment,
  fallback: TimingConfig["pendingWindows"],
): TimingConfig["pendingWindows"] {
  const out: Record<PendingWindowKind, Milliseconds> = { ...fallback };
  for (const kind of Object.keys(PENDING_WINDOW_ENV_KEYS) as PendingWindowKind[]) {
    out[kind] = readDuration(env, PENDING_WINDOW_ENV_KEYS[kind], fallback[kind]);
  }
  return out;
}

/**
 * Build a config from an environment. Pure: same env in, same config out.
 * Only genuinely operational knobs are exposed to the environment — the structural limits
 * (3-6 players, 3 starting cards, 2 character cards) are rules, not deployment settings.
 */
export function loadConfig(env: Environment): SurvivorConfig {
  const d = DEFAULT_CONFIG;
  const t = d.engine.timings;
  const h = d.engine.houseRules;

  return {
    engine: {
      limits: d.engine.limits,
      deck: {
        includeIdolNullifier: readBool(
          env,
          "INCLUDE_IDOL_NULLIFIER",
          d.engine.deck.includeIdolNullifier,
        ),
        rngSeed: readOptionalInt(env, "RNG_SEED", d.engine.deck.rngSeed),
        tribalCouncilSpacingJitter: readFloat(
          env,
          "TRIBAL_SPACING_JITTER",
          d.engine.deck.tribalCouncilSpacingJitter,
          { min: 0, max: 1 },
        ),
      },
      timings: {
        pendingWindows: readPendingWindows(env, t.pendingWindows),
        idolWindow: readDuration(env, "IDOL_MS", t.idolWindow),
        nullifierWindow: readDuration(env, "NULLIFIER_MS", t.nullifierWindow),
        turnSafetyTimeout: readDuration(env, "TURN_TIMEOUT_MS", t.turnSafetyTimeout),
        councilDiscussionSafetyTimeout: readDuration(
          env,
          "COUNCIL_DISCUSSION_TIMEOUT_MS",
          t.councilDiscussionSafetyTimeout,
        ),
        councilVotingSafetyTimeout: readDuration(
          env,
          "COUNCIL_VOTING_TIMEOUT_MS",
          t.councilVotingSafetyTimeout,
        ),
        finalCouncilPhaseSafetyTimeout: readDuration(
          env,
          "FINAL_COUNCIL_TIMEOUT_MS",
          t.finalCouncilPhaseSafetyTimeout,
        ),
        juryVoteSafetyTimeout: readDuration(
          env,
          "JURY_VOTE_TIMEOUT_MS",
          t.juryVoteSafetyTimeout,
        ),
        voteRevealInterval: readDuration(env, "VOTE_REVEAL_MS", t.voteRevealInterval),
        tickInterval: readInt(env, "TICK_MS", t.tickInterval, { min: MIN_TICK_MS }),
      },
      houseRules: {
        sorryForYouBlocksKnowledgeIsPower: readBool(
          env,
          "SFY_BLOCKS_KIP",
          h.sorryForYouBlocksKnowledgeIsPower,
        ),
        sorryForYouBlocksSpyShack: readBool(
          env,
          "SFY_BLOCKS_SPY_SHACK",
          h.sorryForYouBlocksSpyShack,
        ),
        spyShackLookHappensBeforeBlock: readBool(
          env,
          "SPY_SHACK_LOOK_FIRST",
          h.spyShackLookHappensBeforeBlock,
        ),
        sorryForYouBlocksCampRaid: readBool(
          env,
          "SFY_BLOCKS_CAMP_RAID",
          h.sorryForYouBlocksCampRaid,
        ),
        sorryForYouBlocksControlTheVote: readBool(
          env,
          "SFY_BLOCKS_CONTROL_THE_VOTE",
          h.sorryForYouBlocksControlTheVote,
        ),
        campRaidTakesTribalCouncilCard: readBool(
          env,
          "CAMP_RAID_TAKES_TRIBAL",
          h.campRaidTakesTribalCouncilCard,
        ),
        allowSelfVote: readBool(env, "ALLOW_SELF_VOTE", h.allowSelfVote),
        allowVotingForEliminatedPlayer: readBool(
          env,
          "ALLOW_VOTE_ELIMINATED",
          h.allowVotingForEliminatedPlayer,
        ),
        allowMultipleIdolsPerPlayerPerCouncil: readBool(
          env,
          "ALLOW_MULTI_IDOL",
          h.allowMultipleIdolsPerPlayerPerCouncil,
        ),
        allianceStealIsRandom: readBool(
          env,
          "ALLIANCE_STEAL_RANDOM",
          h.allianceStealIsRandom,
        ),
        nullifierCancelsAllIdols: readBool(
          env,
          "NULLIFIER_CANCELS_ALL",
          h.nullifierCancelsAllIdols,
        ),
        allowStealFromEmptyHand: readBool(
          env,
          "ALLOW_STEAL_EMPTY_HAND",
          h.allowStealFromEmptyHand,
        ),
        voteCardIsStealable: readBool(
          env,
          "VOTE_CARD_STEALABLE",
          h.voteCardIsStealable,
        ),
        tieBreakIdolTierIncludesProtected: readBool(
          env,
          "TIE_BREAK_IDOL_TIER_INCLUDES_PROTECTED",
          h.tieBreakIdolTierIncludesProtected,
        ),
        drawPileExhaustionPolicy: readEnum(
          env,
          "DRAW_PILE_EXHAUSTION",
          ["final_council", "draw"] as const,
          h.drawPileExhaustionPolicy,
        ),
      },
    },
    autosave: {
      enabled: readBool(env, "AUTOSAVE", d.autosave.enabled),
      directory: readString(env, "STATE_DIR", d.autosave.directory),
      saveOnEveryMutation: readBool(
        env,
        "SAVE_EVERY_MUTATION",
        d.autosave.saveOnEveryMutation,
      ),
      debounceInterval: readInt(env, "SAVE_DEBOUNCE_MS", d.autosave.debounceInterval, {
        min: 0,
      }),
      keepSnapshots: readInt(env, "KEEP_SNAPSHOTS", d.autosave.keepSnapshots, {
        min: 1,
      }),
      allowArbitraryRestorePaths: readBool(
        env,
        "ALLOW_ARBITRARY_RESTORE_PATHS",
        d.autosave.allowArbitraryRestorePaths,
      ),
    },
    discord: {
      ...d.discord,
      renderCardArt: readBool(env, "RENDER_CARD_ART", d.discord.renderCardArt),
      autoDeferAfter: readDuration(env, "AUTO_DEFER_MS", d.discord.autoDeferAfter),
      componentCollectorTimeout: readDuration(
        env,
        "COLLECTOR_TIMEOUT_MS",
        d.discord.componentCollectorTimeout,
      ),
      logLevel: readEnum(
        env,
        "LOG_LEVEL",
        ["debug", "info", "warn", "error"] as const,
        d.discord.logLevel,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check a config for values that are legal TypeScript but illegal policy.
 *
 * Same shape as `validateCatalog()` in engine/cards.ts: returns a list of problems, empty
 * means good. The entry point calls it once at startup and exits non-zero on any problem, so
 * a typo in a deployment env var fails immediately instead of wedging a game hours later.
 */
export function validateConfig(c: SurvivorConfig): readonly string[] {
  const problems: string[] = [];

  const requirePositive = (label: string, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`${label} must be a positive number of milliseconds, got ${value}`);
    }
  };

  const t = c.engine.timings;
  for (const [kind, ms] of Object.entries(t.pendingWindows)) {
    requirePositive(`timings.pendingWindows.${kind}`, ms);
  }
  requirePositive("timings.idolWindow", t.idolWindow);
  requirePositive("timings.nullifierWindow", t.nullifierWindow);
  requirePositive("timings.turnSafetyTimeout", t.turnSafetyTimeout);
  requirePositive(
    "timings.councilDiscussionSafetyTimeout",
    t.councilDiscussionSafetyTimeout,
  );
  requirePositive("timings.councilVotingSafetyTimeout", t.councilVotingSafetyTimeout);
  requirePositive(
    "timings.finalCouncilPhaseSafetyTimeout",
    t.finalCouncilPhaseSafetyTimeout,
  );
  requirePositive("timings.juryVoteSafetyTimeout", t.juryVoteSafetyTimeout);
  requirePositive("timings.voteRevealInterval", t.voteRevealInterval);
  if (t.tickInterval < MIN_TICK_MS) {
    problems.push(`timings.tickInterval must be at least ${MIN_TICK_MS}ms`);
  }

  const jitter = c.engine.deck.tribalCouncilSpacingJitter;
  if (!(jitter >= 0 && jitter <= 1)) {
    problems.push(
      `deck.tribalCouncilSpacingJitter must be within [0, 1], got ${jitter}`,
    );
  }

  const limits = c.engine.limits;
  if (limits.minPlayers > limits.maxPlayers) {
    problems.push("limits.minPlayers must not exceed limits.maxPlayers");
  }
  if (limits.startingHandSize < 0) {
    problems.push("limits.startingHandSize must not be negative");
  }
  if (limits.characterCardsPerPlayer < 1) {
    problems.push("limits.characterCardsPerPlayer must be at least 1");
  }
  if (limits.voteCardsPerPlayerAtSetup < 1) {
    problems.push("limits.voteCardsPerPlayerAtSetup must be at least 1");
  }
  if (limits.maxHandSize !== null && limits.maxHandSize < limits.startingHandSize) {
    problems.push("limits.maxHandSize must be at least limits.startingHandSize");
  }
  if (limits.tribalCouncilCardsAtDeckBottom < 1) {
    problems.push(
      "limits.tribalCouncilCardsAtDeckBottom must be at least 1: setup step 5 guarantees the last card drawn is a Tribal Council card",
    );
  }

  if (c.autosave.keepSnapshots < 1) {
    problems.push("autosave.keepSnapshots must be at least 1");
  }
  if (c.autosave.debounceInterval < 0) {
    problems.push("autosave.debounceInterval must not be negative");
  }
  if (c.autosave.enabled && c.autosave.directory.trim() === "") {
    problems.push("autosave.directory must not be empty when autosave is enabled");
  }

  // An auto-defer that fires at or after Discord's own 3s cutoff is not a safety net: the
  // interaction is already dead and the player has already seen "The application did not
  // respond" (audit #16/#42).
  if (c.discord.autoDeferAfter >= c.discord.initialResponseDeadline) {
    problems.push(
      `discord.autoDeferAfter (${c.discord.autoDeferAfter}ms) must be less than discord.initialResponseDeadline (${c.discord.initialResponseDeadline}ms)`,
    );
  }
  if (c.discord.maxTimerDelay < 1) {
    problems.push("discord.maxTimerDelay must be at least 1ms");
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Test/override helpers
// ---------------------------------------------------------------------------

/** Partial timings, with `pendingWindows` mergeable one key at a time. */
export type TimingOverrides = Partial<Omit<TimingConfig, "pendingWindows">> & {
  readonly pendingWindows?: Partial<Record<PendingWindowKind, Milliseconds>>;
};

/**
 * Deep-merge partial overrides onto a base config. Tests use this to shrink timings without
 * restating the whole tree; nothing in production should call it.
 */
export function withOverrides(
  base: SurvivorConfig,
  overrides: {
    readonly engine?: {
      readonly limits?: Partial<LimitsConfig>;
      readonly deck?: Partial<DeckConfig>;
      readonly timings?: TimingOverrides;
      readonly houseRules?: Partial<HouseRulesConfig>;
    };
    readonly autosave?: Partial<AutosaveConfig>;
    readonly discord?: Partial<DiscordConfig>;
  },
): SurvivorConfig {
  const timingOverrides = overrides.engine?.timings;
  return {
    engine: {
      limits: { ...base.engine.limits, ...overrides.engine?.limits },
      deck: { ...base.engine.deck, ...overrides.engine?.deck },
      timings: {
        ...base.engine.timings,
        ...timingOverrides,
        pendingWindows: {
          ...base.engine.timings.pendingWindows,
          ...timingOverrides?.pendingWindows,
        },
      },
      houseRules: { ...base.engine.houseRules, ...overrides.engine?.houseRules },
    },
    autosave: { ...base.autosave, ...overrides.autosave },
    discord: { ...base.discord, ...overrides.discord },
  };
}

/**
 * The live config. Read once at import. The Discord layer uses this; the engine receives
 * `config.engine` as an explicit constructor argument so tests can substitute their own.
 *
 * `src/engine/**` must never import either of these two bindings — only the TYPES above.
 * That rule is enforced by an eslint `no-restricted-imports` override on `src/engine/**` and
 * by a grep step in CI, not by good intentions.
 */
export const config: SurvivorConfig = loadConfig(process.env);

/** Convenience alias for the engine slice of the live config. */
export const engineConfig: EngineConfig = config.engine;
