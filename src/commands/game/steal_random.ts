import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral, runSorryForYouWindow, sendDM } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("steal_random")
    .setDescription("Steal a random card from another player")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose card you want to steal")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: true,
      interruptible: true,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "You must specify a player to steal from.");
    }
    if (targetPlayer.hand.length === 0) {
      return replyEphemeral(interaction, `<@${targetPlayer.id}> has no cards to steal!`);
    }

    const gameId = Game.id;
    const window = await runSorryForYouWindow(
      interaction,
      player,
      targetPlayer,
      (seconds) =>
        `Attempting to steal from <@${targetPlayer.id}>... (They have ~${seconds} seconds remaining to play "Sorry For You")`,
    );
    if (!window) {
      return replyEphemeral(
        interaction,
        "This action cannot be played at this time. Wait a moment and try again.",
      );
    }

    if (window.outcome === "stopped") {
      await interaction.editReply({
        content: `Steal attempt was interrupted with ${window.secondsLeft} seconds remaining`,
      });
      return interaction.followUp({
        content: "Your steal attempt was interrupted!",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!Game.isCurrentGame(gameId) || targetPlayer.hand.length === 0) {
      return interaction.editReply({
        content: `<@${player.id}> tried to steal from <@${targetPlayer.id}>, but there was nothing left to take.`,
      });
    }

    // Execute the steal
    const randomIndex = Math.floor(Math.random() * targetPlayer.hand.length);
    const [cardToSteal] = targetPlayer.hand.splice(randomIndex, 1);
    player.hand.push(cardToSteal);

    await interaction.editReply({
      content: `<@${player.id}> has stolen a card from <@${targetPlayer.id}>!!!`,
    });
    await interaction.followUp({
      content: `You successfully stole *${cardToSteal.getName()}* from <@${targetPlayer.id}>!`,
      flags: MessageFlags.Ephemeral,
    });
    await sendDM(
      interaction.client,
      targetPlayer.id,
      `<@${player.id}> stole **${cardToSteal.getName()}** from you in the Survivor game!`,
    );
  },
};
