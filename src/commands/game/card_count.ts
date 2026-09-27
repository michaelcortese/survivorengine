import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

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
      return replyEphemeral(interaction, "No game is currently in progress!");
    }
    const targetUser = interaction.options.getUser("player", true);
    const player = Game.getPlayerFromUserId(targetUser.id);
    if (!player) {
      return replyEphemeral(
        interaction,
        "The mentioned user is not a player in the current game",
      );
    }

    const cardCount = player.hand.length;
    return replyEphemeral(
      interaction,
      `<@${player.id}> has ${cardCount} card${cardCount !== 1 ? "s" : ""} in their hand.`,
    );
  },
};
