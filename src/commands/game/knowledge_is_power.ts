import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "Knowledge is Power";
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = false; // Can be played anytime

export default {
  data: new SlashCommandBuilder()
    .setName("knowledge_is_power")
    .setDescription("Play Knowledge is Power - Ask another player for a specific card")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to ask for the card")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("card_name")
        .setDescription("The name of the card to ask for")
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

    const cardName = interaction.options.getString("card_name");
    if (!cardName) {
      return interaction.reply({
        content: "You must specify a card name.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Check if target has the card
    if (!targetPlayer.hasCard(cardName)) {
      return interaction.reply({
        content: `<@${targetPlayer.id}> does not have the card "${cardName}".`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Auto-transfer the card (they must give it)
    const card = targetPlayer.hand.find((c) => c.name === cardName);
    if (card) {
      targetPlayer.removeCard(cardName);
      player.hand.push(card);
      await interaction.reply({
        content: `<@${player.id}> asked <@${targetPlayer.id}> for "${cardName}" and received it!`,
      });
    }
  },
};
