/**
 * The tribe board: who is still in, who each of them is playing as, and which castaways have
 * been voted out.
 *
 * Built from the PUBLIC view and nothing else — hand sizes, torches, castaways and whose move it
 * is are all table facts — so a board can be posted anywhere without a second thought about who
 * is reading it. Two forms, from one model:
 *
 *   - the picture (`board-image.ts`), where a voted-out castaway is grayed out and stamped;
 *   - the text, one line per player, which is what the embed carries and what stands in for the
 *     picture on a host that cannot draw it.
 */

import { AttachmentBuilder, EmbedBuilder } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import type { GameEvent } from "../engine/events.js";
import type { CardUid, GameView, PlayerId, PublicPlayerView } from "../engine/types.js";
import type { Logger } from "../logger.js";
import {
  renderBoardImage,
  type BoardPlayerStatus,
  type BoardView,
} from "./board-image.js";
import { bold, colorEmoji, colorHex, quantity, truncate } from "./format.js";

/** The attachment's file name, which is also how the embed points at it. */
export const BOARD_FILE = "tribe-board.png";

/** A portrait for one castaway, if its player uploaded one. */
export type PortraitLookup = (playerId: PlayerId, index: number) => Buffer | null;

export interface BoardOptions {
  readonly title?: string;
  readonly subtitle?: string;
  /** Character cards turned over by the events being reported: drawn with a red glow. */
  readonly justVotedOut?: ReadonlySet<CardUid>;
  readonly portraits?: PortraitLookup;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

function statusOf(view: GameView, player: PublicPlayerView): BoardPlayerStatus {
  if (view.winnerId === player.id) return "winner";
  if (player.departed) return "left";
  if (player.eliminated) return "jury";
  if (view.finalCouncil?.finalists.includes(player.id) === true) return "finalist";
  if (view.winnerId !== null) return "finalist";
  return "playing";
}

/** Seat order, so the board reads in turn order like the table does. */
const seated = (view: GameView): readonly PublicPlayerView[] =>
  [...view.players].sort((a, b) => a.seat - b.seat);

const cssColor = (player: PublicPlayerView): string =>
  `#${colorHex(player.color).toString(16).padStart(6, "0")}`;

/** "Castaway 1" stands in for a name only in a board drawn from a lobby. */
const castawayName = (name: string | null, index: number): string =>
  name ?? `Castaway ${index + 1}`;

function defaultSubtitle(view: GameView): string {
  const nameOf = (id: PlayerId): string =>
    view.players.find((player) => player.id === id)?.displayName ?? "Someone";
  if (view.winnerId !== null) return `${nameOf(view.winnerId)} is the Sole Survivor!`;
  if (view.finalCouncil !== null)
    return "Final Tribal Council — the Jury decides who wins.";
  const inGame = view.players.filter(
    (player) => !player.eliminated && !player.departed,
  );
  const standing = `${inGame.length} of ${quantity(view.players.length, "player")} still in the game`;
  if (view.council !== null) return `${standing} · Tribal Council is in session`;
  if (view.turn !== null) return `${standing} · ${nameOf(view.turn.playerId)}'s turn`;
  return standing;
}

function footerText(view: GameView): string {
  const next = view.drawsUntilCouncils[0];
  return [
    `Draw pile: ${quantity(view.drawPileSize, "card")}`,
    `Tribal Councils left: ${view.drawsUntilCouncils.length}`,
    next === undefined ? "" : `Next in ${quantity(next, "draw")}`,
  ]
    .filter((part) => part !== "")
    .join("  ·  ");
}

export function boardView(
  view: GameView,
  config: SurvivorConfig,
  options: BoardOptions = {},
): BoardView {
  const perPlayer = config.engine.limits.characterCardsPerPlayer;
  return {
    title: options.title ?? (view.winnerId !== null ? "Sole Survivor" : "The Tribe"),
    subtitle: options.subtitle ?? defaultSubtitle(view),
    footer: footerText(view),
    players: seated(view).map((player) => ({
      name: player.displayName,
      color: cssColor(player),
      handCount: player.handSize,
      lives: player.charactersRemaining,
      status: statusOf(view, player),
      isTurn: view.stage === "turn" && player.isCurrentPlayer,
      isLeader: player.isCouncilLeader || view.finalCouncil?.leaderId === player.id,
      castaways: Array.from({ length: perPlayer }, (_, index) => {
        const castaway = player.castaways[index];
        const cardUid = castaway?.cardUid ?? null;
        return {
          name: castawayName(castaway?.name ?? null, index),
          image: options.portraits?.(player.id, index) ?? null,
          votedOut: castaway?.votedOut ?? false,
          justVotedOut:
            cardUid !== null && (options.justVotedOut?.has(cardUid) ?? false),
        };
      }),
    })),
  };
}

/** The character cards a batch of events turned over. */
export function flippedIn(events: readonly GameEvent[]): ReadonlySet<CardUid> {
  const out = new Set<CardUid>();
  for (const event of events) {
    if (event.type === "character_card_flipped") out.add(event.cardUid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/** One castaway: struck through once voted out. */
const castawayText = (name: string, votedOut: boolean): string =>
  votedOut ? `~~${name}~~` : bold(name);

/** A player's castaways on one line, "**Parvati Shallow** · ~~Sandra Diaz-Twine~~". */
export function castawaysLine(player: PublicPlayerView): string {
  return player.castaways
    .map((castaway, index) =>
      castawayText(castawayName(castaway.name, index), castaway.votedOut),
    )
    .join(" · ");
}

/** The board in words: one line per player, in seat order. */
export function boardText(view: GameView, config: SurvivorConfig): string {
  const lines = seated(view).map((player) => {
    const status = statusOf(view, player);
    const detail =
      status === "winner"
        ? "🏆 Sole Survivor"
        : status === "jury"
          ? "on the Jury"
          : status === "left"
            ? "left the game"
            : quantity(player.handSize, "card");
    const turn =
      view.stage === "turn" && player.isCurrentPlayer ? " ⬅️ their turn" : "";
    return `${colorEmoji(player.color)} ${bold(player.displayName)} — ${castawaysLine(player)} · ${detail}${turn}`;
  });
  return truncate(lines.join("\n"), config.discord.maxEmbedDescriptionLength);
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export interface BoardImage {
  readonly file: AttachmentBuilder;
  /** Point an embed at the picture: `embed.setImage(url)`. */
  readonly url: string;
}

/**
 * The picture, as an attachment, or null where it cannot — or, by `discord.boardImages`, should
 * not — be drawn. Never throws.
 */
export async function boardImage(
  view: GameView,
  config: SurvivorConfig,
  options: BoardOptions,
  log: Logger,
): Promise<BoardImage | null> {
  if (!config.discord.boardImages) return null;
  try {
    const png = await renderBoardImage(boardView(view, config, options), log);
    if (png === null) return null;
    return {
      file: new AttachmentBuilder(png, { name: BOARD_FILE }),
      url: `attachment://${BOARD_FILE}`,
    };
  } catch (cause) {
    log.error("could not draw the tribe board", cause);
    return null;
  }
}

/** A post of its own: the board picture under a one-line heading. Null where it cannot be drawn. */
export async function boardPost(
  view: GameView,
  config: SurvivorConfig,
  options: BoardOptions,
  log: Logger,
): Promise<{
  readonly embeds: readonly EmbedBuilder[];
  readonly files: readonly AttachmentBuilder[];
} | null> {
  const image = await boardImage(view, config, options, log);
  if (image === null) return null;
  const model = boardView(view, config, options);
  const embed = new EmbedBuilder()
    .setColor(0xf4b942)
    .setTitle(`🔥 ${model.title}`)
    .setDescription(model.subtitle)
    .setImage(image.url);
  return { embeds: [embed], files: [image.file] };
}
