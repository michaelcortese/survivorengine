import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

export default {
  data: new SlashCommandBuilder()
    .setName("hand")
    .setDescription("View your hand"),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!Game.active) {
      return interaction.reply("No game is currently in progress!");
    }

    const player = Game.getPlayerFromUserId(interaction.user.id);
    if (!player) {
      return interaction.reply("You are not a player in the current game!");
    }

    const cardCounts: Record<string, { count: number; desc: string; url: string }> = {};

    for (const card of player.hand) {
      const name = card.getName();

      if (!cardCounts[name]) {
        cardCounts[name] = {
          count: 1,
          desc: card.getDescription() ?? "No description available.",
          url: card.getImage() ?? ""
        };
      } else {
        cardCounts[name].count++;
      }
    }

    const textList = Object.entries(cardCounts)
      .map(([name, data]) => {
        const quantity = data.count > 1 ? ` (${data.count}x)` : "";
        return `**${name}${quantity}** - *${data.desc}*`;
      })
      .join("\n");

    const imageList = Object.values(cardCounts)
      .filter(data => data.url !== "")
      .map((data, i) => `${data.url}?v=${i}`)
      .join("\n");

    await interaction.reply({
      content: `${textList}\n\n${imageList}`.trim(),
      flags: MessageFlags.Ephemeral,
    });
  },
};
