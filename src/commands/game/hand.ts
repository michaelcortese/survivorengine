import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

const MESSAGE_LIMIT = 2000;

export default {
  data: new SlashCommandBuilder()
    .setName("hand")
    .setDescription("View your hand and your castaways"),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!Game.active) {
      return replyEphemeral(interaction, "No game is currently in progress!");
    }

    const player = Game.getPlayerFromUserId(interaction.user.id);
    if (!player) {
      return replyEphemeral(interaction, "You are not a player in the current game!");
    }

    const castaways = player.castaways
      .map((c) => (c.lost ? `💀 ~~${c.name}~~` : `🔥 **${c.name}**`))
      .join(" · ");
    const status = player.isAlive()
      ? `${player.lives} ${player.lives === 1 ? "life" : "lives"} left`
      : "voted out, you're on the jury";
    const header = `Your castaways: ${castaways} (${status})`;

    if (player.hand.length === 0) {
      return replyEphemeral(interaction, `${header}\n\nYour hand is empty.`);
    }

    const cardCounts: Record<string, { count: number; desc: string; compact: string; url: string }> = {};

    for (const card of player.hand) {
      const name = card.getName();

      if (!cardCounts[name]) {
        cardCounts[name] = {
          count: 1,
          desc: card.getDescription() ?? "No description available.",
          compact: card.compactDescription ?? card.getDescription() ?? "",
          url: card.getImage() ?? "",
        };
      } else {
        cardCounts[name].count++;
      }
    }

    const textList = (compact: boolean) =>
      Object.entries(cardCounts)
        .map(([name, data]) => {
          const quantity = data.count > 1 ? ` (${data.count}x)` : "";
          return `**${name}${quantity}** - *${compact ? data.compact : data.desc}*`;
        })
        .join("\n");

    const imageList = Object.values(cardCounts)
      .filter((data) => data.url !== "")
      .map((data, i) => `${data.url}?v=${i}`)
      .join("\n");

    // Big hands fall back to short descriptions to fit Discord's message limit
    let content = `${header}\n\n${textList(false)}\n\n${imageList}`.trim();
    if (content.length > MESSAGE_LIMIT) {
      content = `${header}\n\n${textList(true)}\n\n${imageList}`.trim();
    }
    if (content.length > MESSAGE_LIMIT) {
      content = `${header}\n\n${textList(true)}`.slice(0, MESSAGE_LIMIT);
    }

    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
  },
};
