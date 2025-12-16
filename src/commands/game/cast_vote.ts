import { TribalCouncil } from "../../game/tribal_council";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
const HAS_TARGET = true;
const REQUIRED_CARD = null;
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("cast_vote")
    .setDescription("TRIBAL COUNCIL ONLY: Cast a vote for another player")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player cast your vote against")
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
        content: "Unable to place vote. Target player not found.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (player.votes === 0) {
      return interaction.reply({
        content: "Unable to place vote. You have no votes remaining.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Game.tribalCouncilState !== TribalCouncilState.Voting) {
      return interaction.reply({
        content: "Unable to place vote. Tribal Council is not in voting state.",
        flags: MessageFlags.Ephemeral,
      });
    }
    player.votes -= 1;
    Game.tribalCouncil?.castVote(targetPlayer);
    await interaction.reply({
      content: `You have cast a vote for <@${targetPlayer.id}>. You have ${player.votes} vote(s) remaining.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
