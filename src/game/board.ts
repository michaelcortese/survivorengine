import { AttachmentBuilder, BaseMessageOptions, EmbedBuilder } from "discord.js";
import { Game, TribalCouncilState } from "./game";
import type Player from "./player";
import {
  BoardPlayerStatus,
  BoardView,
  renderBoardImage,
} from "../render/board_image";

interface BoardOptions {
  title?: string;
  subtitle?: string;
  /** Highlight castaways voted out at this Tribal Council. */
  highlightTribal?: number;
  /** Text to post with the board. */
  content?: string;
}

const AVATAR_TIMEOUT_MS = 3000;
const BOARD_FILE = "tribe-board.png";

/** Downloads each player's Discord avatar once per game. */
async function ensureAvatars(players: Player[]): Promise<void> {
  await Promise.all(
    players.map(async (player) => {
      if (player.avatar !== undefined || !player.avatarUrl) return;
      try {
        const response = await fetch(player.avatarUrl, {
          signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
        });
        player.avatar = response.ok
          ? Buffer.from(await response.arrayBuffer())
          : null;
      } catch {
        player.avatar = null;
      }
    }),
  );
}

function statusOf(player: Player): BoardPlayerStatus {
  if (Game.winner) {
    if (player === Game.winner) return "winner";
    return player.isAlive() ? "finalist" : "jury";
  }
  if (!player.isAlive()) return "jury";
  return Game.tribalCouncilState === TribalCouncilState.FINAL
    ? "finalist"
    : "alive";
}

function isTurn(player: Player): boolean {
  return (
    Game.active &&
    Game.tribalCouncilState === TribalCouncilState.NotStarted &&
    Game.currentPlayer() === player
  );
}

function isLeader(player: Player): boolean {
  if (Game.tribalCouncil) return Game.tribalCouncil.leader === player;
  return (
    Game.tribalCouncilState === TribalCouncilState.FINAL &&
    !Game.winner &&
    Game.finalTribalLeader === player
  );
}

function defaultSubtitle(): string {
  if (Game.winner) return `${Game.winner.username} is the Sole Survivor!`;
  if (Game.tribalCouncilState === TribalCouncilState.FINAL) {
    return "Final Tribal Council: the jury decides who wins.";
  }
  const alive = Game.getAlivePlayers().length;
  const current = Game.currentPlayer();
  const turn =
    current && isTurn(current) ? ` · It's ${current.username}'s turn` : "";
  return `${alive} of ${Game.players.length} players are still in the game${turn}`;
}

function footerText(): string {
  const cards = Game.deck.getCardCount();
  const tribals = Game.deck.getTribalCouncilCount();
  return [
    `Draw pile: ${cards} card${cards === 1 ? "" : "s"}`,
    `Tribal Councils left: ${tribals}`,
    `Tribal Councils held: ${Game.tribalCouncilCount}`,
  ].join("  ·  ");
}

export function buildBoardView(options: BoardOptions = {}): BoardView {
  return {
    title: options.title ?? (Game.winner ? "Sole Survivor" : "The Tribe"),
    subtitle: options.subtitle ?? defaultSubtitle(),
    footer: footerText(),
    players: Game.players.map((player) => ({
      name: player.username,
      color: player.color,
      avatar: player.avatar,
      handCount: player.hand.length,
      lives: player.lives,
      status: statusOf(player),
      isTurn: isTurn(player),
      isLeader: isLeader(player),
      castaways: player.castaways.map((castaway) => ({
        name: castaway.name,
        image: castaway.image,
        lost: castaway.lost,
        justLost:
          options.highlightTribal !== undefined &&
          castaway.lostAtTribal === options.highlightTribal,
      })),
    })),
  };
}

/** One line per player, used as the embed text and as a fallback without images. */
export function boardText(): string {
  return Game.players
    .map((player) => {
      const torches = player.castaways.map((c) => (c.lost ? "💀" : "🔥")).join("");
      const names = player.castaways
        .map((c) => (c.lost ? `~~${c.name}~~` : `**${c.name}**`))
        .join(" · ");
      const status = statusOf(player);
      let detail: string;
      if (status === "winner") detail = "🏆 Sole Survivor";
      else if (status === "jury") detail = "on the jury";
      else if (status === "finalist") detail = "finalist";
      else detail = `${player.hand.length} card${player.hand.length === 1 ? "" : "s"}`;
      const turn = isTurn(player) ? " ⬅️ **their turn**" : "";
      return `${torches} <@${player.id}> — ${names} · ${detail}${turn}`;
    })
    .join("\n");
}

/** A message with the tribe board image (when available) and a text summary. */
export async function buildBoardMessage(
  options: BoardOptions = {},
): Promise<BaseMessageOptions> {
  await ensureAvatars(Game.players);
  const view = buildBoardView(options);
  const embed = new EmbedBuilder()
    .setTitle(`🔥 ${view.title}`)
    .setDescription(`${view.subtitle}\n\n${boardText()}`.slice(0, 4096))
    .setFooter({ text: view.footer })
    .setColor(0xf4b942);

  let image: Buffer | null = null;
  try {
    image = await renderBoardImage(view);
  } catch (error) {
    console.error("Failed to draw the tribe board:", error);
  }

  const files: AttachmentBuilder[] = [];
  if (image) {
    files.push(new AttachmentBuilder(image, { name: BOARD_FILE }));
    embed.setImage(`attachment://${BOARD_FILE}`);
  }
  return { content: options.content, embeds: [embed], files };
}
