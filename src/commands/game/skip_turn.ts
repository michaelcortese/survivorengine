import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("skip_turn")
    .setDescription("Skip the current player's turn (for when they're away)"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, { interruptible: true });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;

    const skipped = Game.currentPlayer();
    if (!skipped) {
      return replyEphemeral(interaction, "It isn't anyone's turn right now.");
    }
    if (skipped === player) {
      return replyEphemeral(
        interaction,
        "You can't skip your own turn. Draw a card with /draw to end it.",
      );
    }

    const next = Game.advanceTurn(skipped);
    return interaction.reply({
      content: `⏭️ <@${player.id}> skipped <@${skipped.id}>'s turn.${next ? ` It's now <@${next.id}>'s turn.` : ""}`,
    });
  },
};
