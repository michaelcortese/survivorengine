import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { TribalCouncilType } from "../../game/tribal_council";
const HAS_TARGET = false;
const REQUIRED_CARD = "Tribal Advantage: I'm the Leader Now";
const INTERUPTABLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("im_the_leader")
    .setDescription(
      "TRIBAL COUNCIL ONLY: make yourself the leader of the current tribal council.",
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
    const { player } = result;

    if (Game.tribalCouncilState === TribalCouncilState.NotStarted) {
      return interaction.reply({
        content: "Unable to play card. Tribal Council has not started.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Game.tribalCouncil?.leader === player) {
      return interaction.reply({
        content: "You are already the leader of the tribal council.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Game.tribalCouncil?.leader) {
      if (Game.tribalCouncil.tribalCouncilType === TribalCouncilType.FINAL) {
        return interaction.reply({
          content: "Unable to play card during final Tribal Council.",
          flags: MessageFlags.Ephemeral,
        });
      }
      let oldLeaderId = Game.tribalCouncil.leader.id;
      Game.tribalCouncil.leader = player;
      return interaction.reply({
        content: `<@${player.id}> has played **Tribal Advantage: I'm the Leader Now**, and is the NEW leader of the tribal council. https://i.imgur.com/jBGDVDm.jpeg`,
      });
    }
    await interaction.reply({
      content: `An unexpected error occurred.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
