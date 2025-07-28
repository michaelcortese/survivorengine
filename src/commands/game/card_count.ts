// TODO REFACTOR
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

export default {
  data: new SlashCommandBuilder()
    .setName("card_count")
    .setDescription("View the number of cards in another player's hand")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose card count you want to view")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!Game.active) {
      return interaction.reply("No game is currently in progress!");
    }
    const targetUser = interaction.options.getUser("player");
    if (!targetUser) {
      return interaction.reply({
        content: "Invalid user specified",
        flags: MessageFlags.Ephemeral,
      });
    }

    const player = Game.getPlayerFromUserId(targetUser.id);
    if (!player) {
      return interaction.reply({
        content: "The mentioned user is not a player in the current game",
        flags: MessageFlags.Ephemeral,
      });
    }

    const cardCount = player.hand.length;
    await interaction.reply({
      content: `<@${player.id}> has ${cardCount} card${cardCount !== 1 ? "s" : ""} in their hand.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
