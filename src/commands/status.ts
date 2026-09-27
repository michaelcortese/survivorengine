/**
 * `/status` — the board, and the one command in this file set that is PUBLIC.
 *
 * That is a rules decision, not a preference. The rulebook is explicit that you cannot hide how
 * many cards you are holding, that a turned-over Survivor Character Card stays face up showing
 * "VOTED OUT", and that Tribal Council cards are printed oversized "so you always know when the
 * next Tribal Council is coming". All of that is table state, visible to everyone sitting round
 * the table, and audit #126 is what happens when a bot forgets: the old `/status` replied
 * ephemerally, so the one person who typed it saw the board and nobody else did, while private
 * information leaked into the channel from the other direction.
 *
 * So the board goes out through `ctx.reply.announce()` — a real `channel.send`, which also
 * outlives the fifteen-minute interaction token (audit #44) — and the interaction itself gets a
 * short ephemeral acknowledgement, because a Discord interaction response can be nothing else.
 *
 * The embed itself is `render.statusEmbed`, shared with the render pipeline and with the
 * router's generic Refresh button, so the board looks the same wherever it is posted from. Where
 * the host can draw it, the tribe board picture rides along as the embed's image: everyone's
 * castaways, grayed out as they are voted out.
 */

import { SlashCommandBuilder, type EmbedBuilder } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { boardImage } from "../discord/board.js";
import type { Command, CommandContext } from "../discord/interactions.js";
import { lobbyEmbed, statusEmbed } from "../discord/render.js";
import type { GameView } from "../engine/types.js";

/** The board for a game that has actually started. */
function boardEmbed(view: GameView, config: SurvivorConfig): EmbedBuilder {
  // "Waiting on" is part of `statusEmbed` itself: every surface that shows the board — this
  // command, the render pipeline, the router's Refresh button — has to answer the same
  // question, and a second copy here would answer it in only one of them.
  return statusEmbed(view, config).setFooter({
    text: "Players are listed in turn order. Hand sizes, torches and the next Tribal Council are public by rule.",
  });
}

const status: Command = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription(
      "Post the board: whose turn, the council, everyone's torches and hand sizes.",
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) return ctx.reply.fail(found.error);
    const session = found.value;

    // Expire whatever the clock has already passed, so the board is the board as it is now and
    // not as it was when the timer last fired. `tick` cannot break a rule; it only applies
    // deadlines that are already behind us.
    session.tick(ctx.nowMs);
    const view = session.view();

    // A lobby has no turn, no torches and no draw pile; `lobbyEmbed` is the shape that reads
    // correctly for one — including when nobody has joined yet.
    const inLobby = view.status === "lobby";
    const embed = inLobby ? lobbyEmbed(view, ctx.config) : boardEmbed(view, ctx.config);
    const image = inLobby
      ? null
      : await boardImage(
          view,
          ctx.config,
          { portraits: (playerId, index) => session.portrait(playerId, index) },
          ctx.log,
        );
    if (image !== null) embed.setImage(image.url);

    const posted = await ctx.reply.announce({
      content: inLobby
        ? "This channel's game has not begun yet — the host presses **Begin** on the lobby message."
        : undefined,
      embeds: [embed],
      files: image === null ? undefined : [image.file],
    });

    // The board is public; the receipt for typing the command is not.
    await ctx.reply.send({
      content:
        posted === null
          ? "I could not post the board in this channel — check that I am allowed to send messages here."
          : "Posted the board above, where everyone can read it.",
    });
  },
};

export default status;
