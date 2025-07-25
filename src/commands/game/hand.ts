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

    const hand = player.hand
      .map((card) => card.getName() + "\n" + card.getImage())
      .join("\n");
    await interaction.reply({
      content: `${hand}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
