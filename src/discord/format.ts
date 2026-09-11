/**
 * Shared formatting. Every word a player reads is assembled from something in this file or in
 * `render.ts` — the engine emits data and never prose (see the header of `engine/events.ts`).
 *
 * WHY it is its own module: audit #85 was literally `"they have ${lives} lives left"`, which
 * printed "they have 1 lives left" at the single most dramatic moment in the game. Grammar that
 * is derived at forty call sites is wrong at some of them. Here it is derived once.
 *
 * Nothing here imports discord.js. These are strings; the component and embed builders live in
 * `ui.ts` and `render.ts`. That keeps this file trivially unit-testable.
 */

import { CARD_CATALOG, getColorDefinition } from "../engine/cards.js";
import type {
  CardInstance,
  CardKind,
  PlayerColor,
  PlayerId,
  TieBreakTier,
  TribalCouncilKind,
} from "../engine/types.js";

// ---------------------------------------------------------------------------
// Discord markup
// ---------------------------------------------------------------------------

/**
 * A player mention. ALWAYS use this rather than a display name for the person an event is
 * about: audit #112 showed raw snowflakes to the table, and a bare display name cannot be
 * clicked, cannot be pinged, and collides when two players pick similar names.
 */
export const mention = (playerId: PlayerId): string => `<@${playerId}>`;

export const bold = (text: string): string => `**${text}**`;
export const italic = (text: string): string => `*${text}*`;
export const code = (text: string): string => `\`${text}\``;
/** Discord renders these client-side in each viewer's own timezone. */
export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export const timestamp = (atMs: number, style: TimestampStyle = "R"): string =>
  `<t:${Math.floor(atMs / 1000)}:${style}>`;

/**
 * A deadline, rendered as a live countdown rather than a duration baked into the message text.
 * Audit #64: the old council announced "8 minutes (30 seconds for testing)" while actually
 * blocking for eight minutes, because the copy and the timer were two independent literals.
 * A Discord relative timestamp cannot disagree with the deadline it was built from.
 */
export const deadline = (atMs: number | null): string =>
  atMs === null ? "no time limit" : timestamp(atMs, "R");

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

/**
 * The noun, agreeing with `count`. Pass `plural` for anything the "+s" rule gets wrong.
 * Prefer `quantity()`, which is the form that actually stops the audit #85 bug recurring.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** "1 card" / "3 cards" / "0 cards". The one true way to print a count in this codebase. */
export function quantity(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${plural(count, singular, pluralForm)}`;
}

/** "is" / "are", for the same reason `quantity` exists. */
export const verbToBe = (count: number): string => (count === 1 ? "is" : "are");

export const verbHas = (count: number): string => (count === 1 ? "has" : "have");

/** "1st", "2nd", "3rd", "11th". Used for elimination order and seat numbers. */
export function ordinal(n: number): string {
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** "A", "A and B", "A, B and C". Empty list renders as "nobody" unless told otherwise. */
export function oxford(
  items: readonly string[],
  conjunction = "and",
  empty = "nobody",
): string {
  if (items.length === 0) return empty;
  if (items.length === 1) return items[0] ?? empty;
  if (items.length === 2) return `${items[0] ?? ""} ${conjunction} ${items[1] ?? ""}`;
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1] ?? ""}`;
}

/** Mentions, joined. The commonest sentence fragment in the whole renderer. */
export const mentionList = (
  playerIds: readonly PlayerId[],
  conjunction = "and",
  empty = "nobody",
): string => oxford(playerIds.map(mention), conjunction, empty);

/** "Chris'" not "Chris's"; "Alex's" not "Alex'". */
export function possessive(name: string): string {
  return name.endsWith("s") || name.endsWith("S") ? `${name}'` : `${name}'s`;
}

/** `snake_case` enum value -> "Snake case". For narrating engine enums without a lookup table. */
export function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A rough duration in words: "12 seconds", "4 minutes", "2 hours".
 *
 * Deliberately coarse — it describes how long the bot was away, and nobody wants that to four
 * significant figures. Goes through `quantity()` so it cannot produce "1 minutes" (audit #85).
 */
export function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return quantity(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return quantity(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return quantity(hours, "hour");
  return quantity(Math.round(hours / 24), "day");
}

// ---------------------------------------------------------------------------
// Game vocabulary
// ---------------------------------------------------------------------------

export const cardName = (kind: CardKind): string => CARD_CATALOG[kind].name;

/** An Inheritance or Survivor Character card is named by its colour; everything else is not. */
export function instanceName(card: CardInstance): string {
  const base = cardName(card.kind);
  return "color" in card ? `${base} (${getColorDefinition(card.color).label})` : base;
}

export const colorEmoji = (color: PlayerColor): string =>
  getColorDefinition(color).emoji;

export const colorLabel = (color: PlayerColor): string =>
  getColorDefinition(color).label;

export const colorHex = (color: PlayerColor): number => getColorDefinition(color).hex;

/**
 * Survivor Character Cards as torches: lit ones then snuffed ones.
 *
 * The rulebook is explicit that a flipped card stays FACE UP showing "VOTED OUT" — it is public
 * information that a player is down to their last life, and hiding it would be a rules change.
 */
export function torches(remaining: number, total: number): string {
  const snuffed = Math.max(0, total - remaining);
  return `${"🔥".repeat(Math.max(0, remaining))}${"🕯️".repeat(snuffed)}`;
}

/** "2 torches" / "1 torch" — the counted form, for sentences rather than tables. */
export const torchCount = (remaining: number): string =>
  quantity(remaining, "torch", "torches");

export const councilKindLabel = (kind: TribalCouncilKind): string =>
  kind === "double" ? "Double Elimination" : "Single Elimination";

/**
 * The tie-break rungs, in players' words. The third one gets a full sentence because it reads
 * as a bug to anyone who has not read the rulebook's fine print: an Immunity Idol is not
 * absolute protection, and tier 3 exists precisely so a council can never end with nobody out.
 */
export const tieBreakTierLabel = (tier: TieBreakTier): string => {
  switch (tier) {
    case "voted_non_immune":
      return "players who received votes and are not immune";
    case "unvoted_non_immune":
      return "players who received no votes and are not immune";
    case "played_or_protected_by_idol":
      return "players who played an Immunity Idol — an idol is not absolute protection, and somebody must go home";
    default:
      return "eligible players";
  }
};

// ---------------------------------------------------------------------------
// Length discipline
// ---------------------------------------------------------------------------

/**
 * Is this UTF-16 code unit the FIRST half of a surrogate pair?
 *
 * The unit that matters for both helpers below. Discord — and @sapphire/shapeshift's
 * `lengthLessThanOrEqual`, which is what actually throws out of `setDescription` — measures in
 * code units, and a cut that lands between the halves of an astral character (every emoji this
 * renderer uses: 🔥 🕯️ 🌀 🔺 🟧) emits a lone surrogate.
 */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * Trim to `max` CODE UNITS, ending in an ellipsis, never mid-surrogate-pair.
 *
 * The two helpers in this section are what everything else relies on to stay inside Discord's
 * limits, and they used to measure in different units: this one TESTED `text.length` (code
 * units) and then BUILT its result from `[...text].slice(…)` (code points), so for text holding
 * any astral character the returned string could be up to twice `max` code units long — and
 * `truncate(text, maxEmbedDescriptionLength)` could still throw out of `setDescription`. One
 * helper was surrogate-safe but not length-safe and the other was length-safe but not
 * surrogate-safe, and both were presented as the answer to audit #86.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  let end = max - 1;
  // Never leave a dangling high surrogate in front of the ellipsis.
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Split a block of text into pieces no longer than `max`, preferring line boundaries.
 *
 * Audit #86: several renderers built unbounded strings and Discord rejected the whole message
 * with a 400, so the player saw nothing at all. Splitting is always better than losing the
 * message; a single line longer than `max` is hard-split rather than dropped.
 */
export function splitByLength(text: string, max: number): readonly string[] {
  if (max <= 0) return [];
  if (text.length <= max) return text === "" ? [] : [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current === "" ? line : `${current}\n${line}`;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
    if (line.length <= max) {
      current = line;
      continue;
    }
    // The hard split measured correctly but cut blindly, so it could halve a surrogate pair —
    // the exact failure `truncate`'s own doc comment promises to avoid.
    for (let i = 0; i < line.length;) {
      let end = Math.min(i + max, line.length);
      if (
        end < line.length &&
        end - 1 > i &&
        isHighSurrogate(line.charCodeAt(end - 1))
      ) {
        end -= 1;
      }
      chunks.push(line.slice(i, end));
      i = end;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** Join lines, then split. The shape every batched public message goes through. */
export const joinAndSplit = (
  lines: readonly string[],
  max: number,
): readonly string[] => splitByLength(lines.join("\n"), max);
