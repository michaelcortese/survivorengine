/**
 * Components, and THE custom_id protocol.
 *
 * ============================ THE PROTOCOL ============================
 *
 *     sv|<game>|<intent>|<actor>|<arg>|<inc>-<seq>
 *      │    │       │        │      │        │
 *      │    │       │        │      │        └─ nonce: the state this was rendered against
 *      │    │       │        │      └────────── payload: uids / target ids / phases (`~`-joined)
 *      │    │       │        └───────────────── the ONE player this component is for
 *      │    │       └────────────────────────── 2-3 char code for an Action or a UI step
 *      │    └────────────────────────────────── the game (channel) it belongs to
 *      └─────────────────────────────────────── config.discord.customIdPrefix
 *
 * Every field is load-bearing, and each one closes a specific defect:
 *
 *  - `game` + `inc` — audit #48 (one global game per process) and #78 (no way to start over).
 *    A button minted for the previous game in this channel decodes cleanly and is then rejected,
 *    rather than being applied to the game that replaced it.
 *  - `actor` — audit #30/#47: collectors were channel-wide and filtered only on the customId, so
 *    two concurrent flows cross-wired and one crashed the process. A component now names the
 *    single player entitled to press it, and `interactionCreate` compares that to the clicker.
 *  - `arg` — audit #39/#50: selections spliced a hand by an array INDEX captured up to 60
 *    seconds earlier. Cards are addressed BY UID here, always. `optionValue()` is the only way
 *    to put a card in a component and it takes a `CardUid`.
 *  - `seq` — the state the component was rendered against, so a handler can tell a fresh click
 *    from one against a board that has since moved and re-render instead of guessing.
 *
 * Snowflakes are stored base36 (19 decimal digits -> 12 chars) purely to buy room inside
 * Discord's 100-character custom_id limit. `encode()` REFUSES to mint an over-length id rather
 * than letting the API reject the whole message at send time (audit #86).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type MessageActionRowComponentBuilder,
  type TopLevelComponent,
} from "discord.js";

import type { DiscordConfig } from "../config.js";
import { CARD_CATALOG } from "../engine/cards.js";
import type {
  ActionKind,
  CardInstance,
  CardUid,
  CouncilPhase,
  FinalCouncilPhase,
  GameId,
  LegalAction,
  PendingId,
  PlayerId,
  PublicPlayerView,
  Result,
} from "../engine/types.js";
import {
  asCardUid,
  asGameId,
  asPendingId,
  asPlayerId,
  err,
  ok,
} from "../engine/types.js";
import { colorEmoji, torches, truncate } from "./format.js";

// ---------------------------------------------------------------------------
// Field separators
// ---------------------------------------------------------------------------

/** Between the six fields. Absent from snowflakes, card uids, pending ids and action codes. */
const FIELD = "|";
/** Between sub-values inside `arg`, e.g. `pnd-42~c007:sorry_for_you`. */
const SUBFIELD = "~";
/** Between the incarnation and the sequence inside the nonce. */
const NONCE = "-";

const FIELD_COUNT = 6;

// ---------------------------------------------------------------------------
// Intent codes
// ---------------------------------------------------------------------------

/**
 * Every engine action, as a short code.
 *
 * `Record<ActionKind, string>` is the point: a 41st action is a COMPILE ERROR here, so no
 * action can ever reach the UI without a code. Audit #74 is the same failure one layer down —
 * 13 of 47 deck cards had no command implementation at all and nothing noticed.
 *
 * INVARIANT: no action code begins with `u`. That is what keeps the action space and the UI
 * space disjoint without a discriminator field, and `assertIntentCodesAreDisjoint()` checks it.
 */
export const ACTION_CODE: Readonly<Record<ActionKind, string>> = {
  join_game: "jg",
  leave_game: "lg",
  choose_color: "cc",
  name_castaways: "nc",
  start_game: "sg",
  abandon_game: "ab",
  remove_player: "rp",
  transfer_host: "th",
  steal_random: "sr",
  play_camp_raid: "cr",
  play_knowledge_is_power: "kp",
  play_spy_shack: "ss",
  play_lets_form_an_alliance: "al",
  play_do_or_die: "dd",
  play_power_pair: "pp",
  play_its_a_numbers_game: "ng",
  skip_play_step: "sk",
  draw_card: "dr",
  play_sorry_for_you: "sy",
  play_inheritance: "ih",
  decline_reaction: "dc",
  submit_challenge_choice: "sc",
  choose_alliance_target: "at",
  choose_card: "ch",
  choose_steal_victim: "cs",
  discard_card: "di",
  advance_council: "ac",
  play_control_the_vote: "ct",
  play_goodwill_gamble: "gg",
  play_im_the_leader_now: "il",
  cast_vote: "vt",
  finish_voting: "fv",
  play_immunity_idol: "ii",
  play_idol_nullifier: "in",
  leader_choose_eliminations: "le",
  advance_final_council: "af",
  reveal_hand: "rh",
  juror_ready: "jr",
  cast_jury_vote: "jv",
  final_leader_break_tie: "bt",
};

/**
 * Steps that are NOT engine actions: menu navigation and confirmations.
 *
 * These exist because several cards need two or three pieces of information before an action is
 * even well-formed (Let's Form an Alliance needs a partner AND a victim), and because a
 * destructive command must never be a bare button — audit #19/#24: `/abandon` had no
 * confirmation and no authorization.
 */
export const UI_INTENT = {
  /** Open the ephemeral "what can I play right now?" select. Backs `/play`. */
  OpenPlayMenu: "up",
  /** A card was picked; the flow now needs a target. `arg` carries the uid chosen so far. */
  PickTarget: "ut",
  /** A colour was picked in the lobby. */
  PickColor: "uk",
  /** Second target of a two-target card (Power Pair, Let's Form an Alliance). */
  PickSecondTarget: "u2",
  /** Yes on a confirmation. `arg` carries whatever the confirmed step needs. */
  Confirm: "uy",
  /** No on a confirmation, or "back" out of a menu step. */
  Cancel: "un",
  /** Re-render a board that has moved on. Never mutates. */
  Refresh: "ur",
  /** A deliberately inert component (a disabled placeholder, a page label). */
  Inert: "u0",
} as const;

export type UiIntent = (typeof UI_INTENT)[keyof typeof UI_INTENT];

const ACTION_BY_CODE: ReadonlyMap<string, ActionKind> = new Map(
  Object.entries(ACTION_CODE).map(([action, code]) => [code, action as ActionKind]),
);

const UI_BY_CODE: ReadonlySet<string> = new Set(Object.values(UI_INTENT));

/**
 * Checked once at boot by `src/index.ts`. Two actions sharing a code would silently route one
 * card's button to another card's handler, which is audit #37 with better spelling.
 */
export function assertIntentCodesAreDisjoint(): readonly string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [action, code] of Object.entries(ACTION_CODE)) {
    if (code.startsWith("u")) {
      problems.push(
        `action code for ${action} must not start with 'u' (reserved for UI steps)`,
      );
    }
    const clash = seen.get(code);
    if (clash !== undefined)
      problems.push(`action code ${code} is used by both ${clash} and ${action}`);
    seen.set(code, action);
  }
  for (const code of Object.values(UI_INTENT)) {
    if (seen.has(code)) problems.push(`UI intent ${code} collides with an action code`);
  }
  return problems;
}

/** Player-facing labels, one per action. Also `Record<ActionKind, …>`, for the same reason. */
export const ACTION_LABEL: Readonly<Record<ActionKind, string>> = {
  join_game: "Join",
  leave_game: "Leave",
  choose_color: "Pick a colour",
  name_castaways: "Pick your castaways",
  start_game: "Begin the game",
  abandon_game: "Abandon this game",
  remove_player: "Remove a player",
  transfer_host: "Pass the host role on",
  steal_random: "Steal a random card",
  play_camp_raid: "Camp Raid",
  play_knowledge_is_power: "Knowledge is Power",
  play_spy_shack: "The Spy Shack",
  play_lets_form_an_alliance: "Let's Form an Alliance",
  play_do_or_die: "Do or Die",
  play_power_pair: "Power Pair",
  play_its_a_numbers_game: "It's a Numbers Game",
  skip_play_step: "Play nothing",
  draw_card: "Draw",
  play_sorry_for_you: "Sorry For You!",
  play_inheritance: "Claim the Inheritance",
  decline_reaction: "Let it happen",
  submit_challenge_choice: "Make your choice",
  choose_alliance_target: "Pick who you steal from",
  choose_card: "Take a card",
  choose_steal_victim: "Pick who you steal from",
  discard_card: "Discard",
  advance_council: "Next phase",
  play_control_the_vote: "Control the Vote",
  play_goodwill_gamble: "Goodwill Gamble",
  play_im_the_leader_now: "I'm the Leader Now",
  cast_vote: "Vote",
  finish_voting: "I'm done voting",
  play_immunity_idol: "Immunity Idol",
  play_idol_nullifier: "Idol Nullifier",
  leader_choose_eliminations: "Decide who goes home",
  advance_final_council: "Next phase",
  reveal_hand: "Reveal my hand",
  juror_ready: "I'm ready",
  cast_jury_vote: "Vote for the winner",
  final_leader_break_tie: "Break the tie",
};

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * The marker on a value that was NOT packed.
 *
 * The encoding has to be self-describing rather than guessed from the character class. `packId`
 * has always promised that "test ids and anything unexpected pass through", but `unpackId` used
 * to base36-decode any `[0-9a-z]` string — so `encode({actor: "p1"})` wrote `p1` and
 * `parseCustomId` read it back as `901`: the actor a component named was not the actor it
 * decoded to, and `playerArg()` had the same asymmetry. Production never hit it (a Discord
 * snowflake is decimal and round-trips exactly), but a documented involution that is not one is
 * a trap for the next person, and `mayPress()` silently refusing a presser is a miserable thing
 * to debug.
 *
 * The marker goes on the PASS-THROUGH branch rather than on the packed one, so it costs nothing
 * in the 100-character budget for the case production actually has: every real id is a decimal
 * snowflake and packs to marker-free base36. `.` is the marker because base36 output is
 * `[0-9a-z]` and can never begin with it.
 */
const UNPACKED_MARKER = ".";

/** Snowflakes are decimal; base36 fits the same value in ~12 characters instead of 19. */
function packId(raw: string): string {
  // Test ids and anything unexpected pass through — marked, so the decoder knows they did.
  if (!/^[0-9]{1,25}$/.test(raw)) return `${UNPACKED_MARKER}${raw}`;
  return BigInt(raw).toString(36);
}

/** The exact inverse of `packId`: it decodes what `packId` packed, and nothing else. */
function unpackId(packed: string): string {
  if (packed.startsWith(UNPACKED_MARKER)) return packed.slice(UNPACKED_MARKER.length);
  // An id from a previous protocol or another application. Hand it back untouched rather than
  // inventing a value for it; the router refuses it a moment later either way.
  if (!/^[0-9a-z]{1,20}$/.test(packed)) return packed;
  try {
    let value = 0n;
    for (const char of packed) {
      const digit = Number.parseInt(char, 36);
      if (Number.isNaN(digit)) return packed;
      value = value * 36n + BigInt(digit);
    }
    return value.toString(10);
  } catch {
    return packed;
  }
}

export interface CustomIdParts {
  readonly gameId: GameId;
  /** An engine action, or a UI step. */
  readonly intent: ActionKind | UiIntent;
  /** The ONE player who may press this. */
  readonly actor: PlayerId;
  /** Payload, in a fixed order per intent. Card uids, target ids, a council phase. */
  readonly args?: readonly string[];
  /** `GameState.createdAtMs` — distinguishes this game from the last one in this channel. */
  readonly incarnation: number;
  /** `GameState.seq` at render time. */
  readonly seq: number;
}

/**
 * Mint a custom_id, or explain why it cannot be minted.
 *
 * A `Result` rather than a throw because the failure mode is a card uid or player list that is
 * unexpectedly long, and the right response is to fall back to a select menu — not to take the
 * whole message down.
 */
/**
 * The two-character code an intent travels as.
 *
 * `CustomIdParts.intent` is an `ActionKind` or a `UiIntent`, but the wire format is the CODE:
 * `parseCustomId` resolves it through `ACTION_BY_CODE`, which is keyed by code. Writing the
 * `ActionKind` itself produced an id that decoded as "unknown step", so every button
 * `componentsForLegalActions()` minted came back to the player as "no longer valid" — and it
 * spent up to 21 characters of the 100-character budget on a field that needs two.
 *
 * A `UiIntent` is already its own code, and so is a code handed in twice: neither is a key of
 * `ACTION_CODE`, so both fall through unchanged and this is idempotent.
 */
function intentCode(intent: ActionKind | UiIntent): string {
  const codes: Readonly<Record<string, string | undefined>> = ACTION_CODE;
  return codes[intent] ?? intent;
}

export function encode(parts: CustomIdParts, discord: DiscordConfig): Result<string> {
  const args = (parts.args ?? []).map((arg) => arg.trim());
  for (const arg of args) {
    if (arg.includes(FIELD) || arg.includes(SUBFIELD)) {
      return err(
        "internal_invariant_violated",
        `custom_id argument ${JSON.stringify(arg)} contains a protocol separator`,
      );
    }
  }
  const raw = [
    discord.customIdPrefix,
    packId(parts.gameId),
    intentCode(parts.intent),
    packId(parts.actor),
    args.join(SUBFIELD),
    `${parts.incarnation.toString(36)}${NONCE}${parts.seq.toString(36)}`,
  ].join(FIELD);

  if (raw.length > discord.maxCustomIdLength) {
    return err(
      "internal_invariant_violated",
      `custom_id is ${raw.length} characters, over Discord's limit of ${discord.maxCustomIdLength}`,
      { intent: parts.intent, length: raw.length },
    );
  }
  return ok(raw);
}

/** `encode`, for the many call sites where a failure is a bug rather than a condition. */
export function encodeOrThrow(parts: CustomIdParts, discord: DiscordConfig): string {
  const result = encode(parts, discord);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type ParsedIntent =
  | { readonly kind: "action"; readonly action: ActionKind }
  | { readonly kind: "ui"; readonly ui: UiIntent };

export interface ParsedCustomId {
  readonly raw: string;
  readonly gameId: GameId;
  readonly intent: ParsedIntent;
  readonly actor: PlayerId;
  readonly args: readonly string[];
  readonly incarnation: number;
  readonly seq: number;
}

/**
 * Decode a custom_id.
 *
 * Total: every malformed input comes back as an `err`, because this function's inputs arrive
 * from the network. A component minted by a previous deployment, a hand-crafted id from a
 * curious player, and a stray collector from some other bot all land here, and none of them may
 * throw — audit #22/#46: one bad interaction took the whole process down.
 */
export function parseCustomId(
  raw: string,
  discord: DiscordConfig,
): Result<ParsedCustomId> {
  const fields = raw.split(FIELD);
  if (fields.length !== FIELD_COUNT) {
    return err("component_malformed", "custom_id does not have the expected shape");
  }
  const [prefix, packedGame, code, packedActor, argBlob, nonce] = fields;
  if (prefix !== discord.customIdPrefix) {
    return err("component_malformed", "custom_id belongs to another application");
  }
  if (
    packedGame === undefined ||
    code === undefined ||
    packedActor === undefined ||
    argBlob === undefined ||
    nonce === undefined
  ) {
    return err("component_malformed", "custom_id has an empty field");
  }

  const action = ACTION_BY_CODE.get(code);
  const intent: ParsedIntent | null = action
    ? { kind: "action", action }
    : UI_BY_CODE.has(code)
      ? { kind: "ui", ui: code as UiIntent }
      : null;
  if (!intent) {
    return err("component_malformed", `custom_id names an unknown step: ${code}`);
  }

  const [incRaw, seqRaw] = nonce.split(NONCE);
  const incarnation = Number.parseInt(incRaw ?? "", 36);
  const seq = Number.parseInt(seqRaw ?? "", 36);
  if (!Number.isFinite(incarnation) || !Number.isFinite(seq)) {
    return err("component_malformed", "custom_id has a malformed nonce");
  }

  return ok({
    raw,
    gameId: asGameId(unpackId(packedGame)),
    intent,
    actor: asPlayerId(unpackId(packedActor)),
    args: argBlob === "" ? [] : argBlob.split(SUBFIELD),
    incarnation,
    seq,
  });
}

// --- typed argument accessors. Never index `args` directly at a call site. ---

export const argAt = (parsed: ParsedCustomId, index: number): string | null =>
  parsed.args[index] ?? null;

export const cardArg = (parsed: ParsedCustomId, index = 0): CardUid | null => {
  const raw = argAt(parsed, index);
  return raw === null || raw === "" ? null : asCardUid(raw);
};

export const playerArg = (parsed: ParsedCustomId, index = 0): PlayerId | null => {
  const raw = argAt(parsed, index);
  return raw === null || raw === "" ? null : asPlayerId(unpackId(raw));
};

export const pendingArg = (parsed: ParsedCustomId, index = 0): PendingId | null => {
  const raw = argAt(parsed, index);
  return raw === null || raw === "" ? null : asPendingId(raw);
};

/** Player ids inside `args` are packed exactly like the actor field. */
export const packPlayerArg = (playerId: PlayerId): string => packId(playerId);

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

export interface ButtonSpec {
  readonly parts: CustomIdParts;
  readonly label: string;
  readonly style?: ButtonStyle;
  readonly emoji?: string;
  readonly disabled?: boolean;
}

/**
 * One button.
 *
 * A button that cannot be minted (an over-length custom_id) becomes a DISABLED button carrying
 * the reason, never a missing one: a silently absent affordance is indistinguishable from a
 * rules decision, and the player has no way to report it.
 */
export function button(spec: ButtonSpec, discord: DiscordConfig): ButtonBuilder {
  const id = encode(spec.parts, discord);
  const builder = new ButtonBuilder()
    .setLabel(truncate(spec.label, discord.maxButtonLabelLength))
    .setStyle(spec.style ?? ButtonStyle.Secondary);
  if (spec.emoji !== undefined) builder.setEmoji(spec.emoji);

  if (!id.ok) {
    return builder
      .setCustomId(
        [discord.customIdPrefix, "0", UI_INTENT.Inert, "0", "", "0-0"].join(FIELD),
      )
      .setDisabled(true);
  }
  return builder.setCustomId(id.value).setDisabled(spec.disabled === true);
}

/**
 * Pack buttons into rows, respecting both Discord ceilings.
 *
 * Surplus is made VISIBLE rather than dropped, for the same reason `button()` four lines up
 * returns a disabled button rather than no button: "a silently absent affordance is
 * indistinguishable from a rules decision, and the player has no way to report it". Past the
 * last slot the final button becomes a disabled `…and N more` marker, so a player who is short
 * of room can see that they are, instead of concluding those plays are illegal.
 */
export function buttonRows(
  buttons: readonly ButtonBuilder[],
  discord: DiscordConfig,
): Row[] {
  const capacity = discord.maxActionRowsPerMessage * discord.maxButtonsPerRow;
  const shown =
    buttons.length <= capacity
      ? [...buttons]
      : [
          ...buttons.slice(0, capacity - 1),
          new ButtonBuilder()
            .setCustomId(
              [discord.customIdPrefix, "0", UI_INTENT.Inert, "0", "", "0-0"].join(
                FIELD,
              ),
            )
            .setLabel(
              truncate(
                `…and ${String(buttons.length - capacity + 1)} more`,
                discord.maxButtonLabelLength,
              ),
            )
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        ];

  const rows: Row[] = [];
  for (let i = 0; i < shown.length; i += discord.maxButtonsPerRow) {
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
    row.addComponents(...shown.slice(i, i + discord.maxButtonsPerRow));
    rows.push(row);
  }
  return rows;
}

export interface SelectOption {
  /** What the option resolves to. A `CardUid`, a packed `PlayerId`, or a plain enum value. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly emoji?: string;
  readonly default?: boolean;
}

export interface SelectSpec {
  readonly parts: CustomIdParts;
  readonly placeholder: string;
  readonly options: readonly SelectOption[];
  readonly minValues?: number;
  readonly maxValues?: number;
  readonly disabled?: boolean;
}

/**
 * A string select.
 *
 * The `value` of every option is a stable identifier — a `CardUid` or a `PlayerId`. NEVER an
 * array index: audit #39/#50 spliced a hand by an index captured up to sixty seconds earlier,
 * against a hand that had since changed, which is how a player lost the wrong card.
 */
/** The value an option carries when its real identifier does not fit. See `select()`. */
const UNUSABLE_OPTION_VALUE = "unusable";

export function select(spec: SelectSpec, discord: DiscordConfig): Row {
  const id = encode(spec.parts, discord);
  const capped = spec.options.slice(0, discord.maxSelectMenuOptions);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(
      id.ok
        ? id.value
        : [discord.customIdPrefix, "0", UI_INTENT.Inert, "0", "", "0-0"].join(FIELD),
    )
    .setPlaceholder(truncate(spec.placeholder, discord.maxSelectOptionLabelLength))
    .setDisabled(spec.disabled === true || !id.ok || capped.length === 0);

  if (capped.length === 0) {
    // A select with no options is rejected by the API outright, so a dead one gets a single
    // inert placeholder instead of taking the message down with it.
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Nothing available")
        .setValue("none"),
    );
  } else {
    menu.addOptions(
      capped.map((option) => {
        // The LABEL is display text and may be elided. The VALUE is an identifier — a CardUid
        // or a packed PlayerId — and eliding it produces a uid that resolves to nothing, which
        // is audit #39/#50 with extra steps. An over-long value disables the option instead.
        const unusable = option.value.length > discord.maxSelectOptionLabelLength;
        // Not exported: nothing needs to RECOGNISE it. It resolves to no card and no player,
        // so every handler already refuses it with a real sentence, which is the outcome a
        // truncated uid could not produce (it resolves to the wrong thing, or to nothing, with
        // no way for the player to tell which).
        const builder = new StringSelectMenuOptionBuilder()
          .setLabel(
            unusable
              ? truncate(
                  `${option.label} (unavailable)`,
                  discord.maxSelectOptionLabelLength,
                )
              : truncate(option.label, discord.maxSelectOptionLabelLength),
          )
          .setValue(unusable ? UNUSABLE_OPTION_VALUE : option.value);
        if (option.description !== undefined && option.description !== "") {
          builder.setDescription(
            truncate(option.description, discord.maxSelectOptionLabelLength),
          );
        }
        if (option.emoji !== undefined) builder.setEmoji(option.emoji);
        if (option.default === true) builder.setDefault(true);
        return builder;
      }),
    );
  }

  const min = Math.min(spec.minValues ?? 1, capped.length || 1);
  const max = Math.min(spec.maxValues ?? 1, capped.length || 1);
  menu.setMinValues(Math.max(0, min)).setMaxValues(Math.max(1, max));

  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
}

/** Cards as select options, addressed by uid, with their compact rules text as description. */
export function cardOptions(cards: readonly CardInstance[]): readonly SelectOption[] {
  return cards.map((card) => {
    const definition = CARD_CATALOG[card.kind];
    return {
      value: card.uid,
      label: definition.name,
      description: definition.compactText,
    };
  });
}

/** Players as select options: colour, torches and hand size, all of which are public by rule. */
export function playerOptions(
  players: readonly PublicPlayerView[],
  legal: readonly PlayerId[],
  charactersPerPlayer: number,
): readonly SelectOption[] {
  const allowed = new Set(legal);
  return players
    .filter((player) => allowed.has(player.id))
    .map((player) => ({
      value: packPlayerArg(player.id),
      label: player.displayName,
      description: `${torches(player.charactersRemaining, charactersPerPlayer)} · ${player.handSize} in hand`,
      emoji: colorEmoji(player.color),
    }));
}

// ---------------------------------------------------------------------------
// legalActions() -> components
// ---------------------------------------------------------------------------

export interface LegalActionRenderOptions {
  readonly gameId: GameId;
  readonly actor: PlayerId;
  readonly incarnation: number;
  readonly seq: number;
  /** Only these actions, in this order. Omit for "everything legal, in engine order". */
  readonly only?: readonly ActionKind[];
  /** Render these as visible-but-disabled so the player can see what they cannot do yet. */
  readonly showUnavailable?: readonly ActionKind[];
  readonly primary?: readonly ActionKind[];
  readonly danger?: readonly ActionKind[];
}

/**
 * Turn `Game.legalActions(player, now)` into buttons.
 *
 * THE rule this enforces: enablement is driven by the engine, not by the renderer's opinion.
 * Audit #88 — "every component stayed enabled after its collector died, so a click produced
 * 'This interaction failed'" — is impossible when the only way a button gets rendered enabled
 * is by appearing in `legalActions()`, and when everything in `showUnavailable` that does not
 * appear there is rendered disabled instead of omitted.
 *
 * Actions needing a target or a card are rendered as a button that OPENS the picker; the picker
 * itself is `select()` above. That two-step shape is what lets one `/play` command replace the
 * old twenty-six one-command-per-card sprawl.
 */
export function componentsForLegalActions(
  actions: readonly LegalAction[],
  options: LegalActionRenderOptions,
  discord: DiscordConfig,
): Row[] {
  const byKind = new Map<ActionKind, LegalAction>();
  for (const action of actions)
    if (!byKind.has(action.kind)) byKind.set(action.kind, action);

  const order = options.only ?? actions.map((action) => action.kind);
  const wanted = [...new Set([...order, ...(options.showUnavailable ?? [])])];
  const primary = new Set(options.primary ?? []);
  const danger = new Set(options.danger ?? []);

  const buttons: ButtonBuilder[] = [];
  for (const kind of wanted) {
    const legal = byKind.get(kind);
    // "Legal but with nothing to point at" is dead too: a steal with no legal victim, a Camp
    // Raid with every opponent already raided. The engine already filtered those lists.
    const dead =
      legal === undefined ||
      (legal.legalTargets !== undefined && legal.legalTargets.length === 0) ||
      (legal.playableCardUids !== undefined && legal.playableCardUids.length === 0) ||
      (legal.optionCardUids !== undefined && legal.optionCardUids.length === 0);

    const args: string[] = [];
    if (legal?.pendingId !== undefined) args.push(legal.pendingId);
    // The phase an advance is FROM, so a stale panel is refused rather than advancing twice
    // (audit #32). Without it the two advance actions could not be minted here at all: the id
    // decoded to `target_required` and every caller had to hand-mint the button instead.
    if (legal?.fromPhase !== undefined) args.push(legal.fromPhase);
    // No target to choose, so the button can carry the whole action. Several COPIES of one card
    // are interchangeable — the rules never distinguish your first Sorry For You from your
    // second — so the first uid is a complete answer, not a guess. Requiring exactly one copy
    // was how a player holding two of a card got a button that decoded to `target_required` and
    // reached them as "I could not work out what that button was meant to do".
    if (legal?.playableCardUids !== undefined && legal.legalTargets === undefined) {
      const first = legal.playableCardUids[0];
      if (first !== undefined) args.push(first);
    }

    buttons.push(
      button(
        {
          parts: {
            gameId: options.gameId,
            intent: kind,
            actor: options.actor,
            args,
            incarnation: options.incarnation,
            seq: options.seq,
          },
          label: ACTION_LABEL[kind],
          style: danger.has(kind)
            ? ButtonStyle.Danger
            : primary.has(kind)
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary,
          disabled: dead,
        },
        discord,
      ),
    );
  }
  return buttonRows(buttons, discord);
}

// ---------------------------------------------------------------------------
// Closing a window
// ---------------------------------------------------------------------------

/**
 * The same components, every one of them disabled.
 *
 * Audit #88 again, from the other end: when a window closes — the pending resolved, the phase
 * advanced, the nonce went stale — the message it was rendered on must be re-rendered DEAD.
 * Leaving live buttons on a finished prompt is how a player gets "This interaction failed"
 * instead of an explanation.
 *
 * Takes `interaction.message.components` (raw components, not builders) because that is what a
 * handler actually has in hand at the moment it needs to kill a message.
 */
export function disableAll(
  rows: readonly TopLevelComponent[],
): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const out: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];
  for (const row of rows) {
    if (row.type !== ComponentType.ActionRow) continue;
    out.push({
      type: ComponentType.ActionRow,
      components: row.components.map((child) => ({
        ...child.toJSON(),
        disabled: true,
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Common little rows
// ---------------------------------------------------------------------------

/**
 * Yes/no on a destructive step. Audit #19/#24: `/abandon` ended a game with no confirmation and
 * no authorization check, so any player could delete everyone else's game with one click.
 */
export function confirmRow(
  parts: Omit<CustomIdParts, "intent">,
  labels: { readonly confirm: string; readonly cancel?: string },
  discord: DiscordConfig,
): Row {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    button(
      {
        parts: { ...parts, intent: UI_INTENT.Confirm },
        label: labels.confirm,
        style: ButtonStyle.Danger,
      },
      discord,
    ),
    button(
      {
        parts: { ...parts, intent: UI_INTENT.Cancel },
        label: labels.cancel ?? "Never mind",
        style: ButtonStyle.Secondary,
      },
      discord,
    ),
  );
}

/** The council phase a button was rendered against, so `advance_council.from` can carry it. */
export const phaseArg = (phase: CouncilPhase | FinalCouncilPhase): string => phase;
