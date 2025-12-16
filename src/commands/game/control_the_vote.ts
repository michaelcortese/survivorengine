import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "Tribal Advantage: Control the Vote";
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("control_the_vote")
    .setDescription("Play Tribal Advantage: Control the Vote - Steal another player's vote at Tribal Council")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose vote to steal")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTIBLE,
      STOPPING_INTERACTION,
      CAN_BE_PLAYED_TRIBAL_COUNCIL,
      ONLY_DURING_TRIBAL_COUNCIL,
    );
    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return interaction.reply({
        content: "Target player not found.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Check if target has votes to steal
    if (targetPlayer.votes === 0) {
      return interaction.reply({
        content: `<@${targetPlayer.id}> has no votes to steal.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Steal the vote: decrement target's votes, increment player's votes
    targetPlayer.votes -= 1;
    player.votes += 1;

    // Announce the vote steal publicly
    await interaction.followUp({
      content: `<@${player.id}> has stolen a vote from <@${targetPlayer.id}> using Tribal Advantage: Control the Vote! https://i.imgur.com/jNlZ87z.jpeg`,
    });
  },
};
