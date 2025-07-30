import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
const HAS_TARGET = true;
const REQUIRED_CARD = null;
const INTERUPTABLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("break_tie")
    .setDescription(
      "TRIBAL COUNCIL LEADER ONLY: Break the tie in the tribal council.",
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERUPTABLE,
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
        content: "Unable to break tie. No target player found.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Game.tribalCouncilState === TribalCouncilState.NotStarted) {
      return interaction.reply({
        content: "Unable to play card. Tribal Council has not started.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Game.tribalCouncil?.leader !== player) {
      return interaction.reply({
        content: "You are not the leader of the tribal council.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return await Game.tribalCouncil.breakTie(targetPlayer);
    await interaction.reply({
      content: `An unexpected error occurred.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
