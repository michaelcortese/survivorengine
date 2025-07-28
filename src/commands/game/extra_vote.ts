import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = false;
const REQUIRED_CARD = "Extra Vote";
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = false;
const CAN_PLAY_DURING_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("extra_vote")
    .setDescription(
      "Play the Extra Vote card, giving you and extra vote in the upcoming Tribal Council.",
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTABLE,
      STOPPING_INTERACTION,
      CAN_PLAY_DURING_TRIBAL_COUNCIL,
      ONLY_DURING_TRIBAL_COUNCIL,
    );

    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { player } = result;
    player.votes++;
    await interaction.reply({
      content: `You played an **Extra Vote** and gave yourself an extra vote in the upcoming Tribal Council! You currently have ${player.votes} votes.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
