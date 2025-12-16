import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "Tribal Advantage: Goodwill Gamble";
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("goodwill_gamble")
    .setDescription("Play Tribal Advantage: Goodwill Gamble - Give an extra vote to another player at Tribal Council")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to give the extra vote to")
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

    // Increment the target player's votes
    targetPlayer.votes += 1;

    // Send DM to the target player
    try {
      const targetUser = await interaction.guild?.members.fetch(targetPlayer.id);
      if (targetUser) {
        await targetUser.send(
          `You have received an extra vote from <@${player.id}> via Tribal Advantage: Goodwill Gamble! You now have ${targetPlayer.votes} vote(s) for this Tribal Council.`
        );
      }
    } catch (error) {
      console.error("Failed to send DM:", error);
    }

    await interaction.reply({
      content: `You have given an extra vote to <@${targetPlayer.id}> using Tribal Advantage: Goodwill Gamble.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
