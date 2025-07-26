import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = false;
const REQUIRED_CARD = null;
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = false;
const CAN_PLAY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("upcoming_tribal_councils")
    .setDescription("View the number of draws until the next tribal council"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTABLE,
      STOPPING_INTERACTION,
      CAN_PLAY_DURING_TRIBAL_COUNCIL,
    );
    if ("error" in result) {
      return await interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }

    const drawsUntilTribal = Game.deck.getDrawsUntilNextTribalCouncil();

    if (drawsUntilTribal.length === 0) {
      await interaction.reply({
        content: "There are no more tribal council cards in the deck.",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: drawsUntilTribal
          .map((cards, index) => {
            if (index === 0) {
              return `Next tribal council is in **${cards} draws**`;
            }
            return `tribal council ${index + 1} is in **${cards} draws**`;
          })
          .join(",\n"),
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
