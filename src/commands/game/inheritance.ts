import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = null;
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = false;

export default {
  data: new SlashCommandBuilder()
    .setName("inheritance")
    .setDescription("Play inheritance to inherit an eliminated player's cards")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to inherit from")
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

    // check for card -- again??

    let inheritance_name = `Inheritance: ${targetPlayer.username}`;
    if (!player.hasCard(inheritance_name)) {
      return interaction.reply({
        content: "You dont have the card",
        flags: MessageFlags.Ephemeral,
      });
    }

    // check if target player has 0 lives left

    if (targetPlayer.isAlive()) {
      return interaction.reply({
        content: "the player is still alive",
        flags: MessageFlags.Ephemeral,
      });
    }


    // checks passed, perform hand transfer logic
    let cardNames: String[] = [];
    targetPlayer.hand.forEach((card) => {
      player.hand.push(card);
      targetPlayer.removeCard(card.name);
      cardNames.push(card.name);
    });
    await interaction.reply({
      content: `You received ${cardNames}`,
      flags: MessageFlags.Ephemeral,
    });

    return interaction.reply({
      content: `${player.username} inherited ${cardNames.length} from ${targetPlayer.username}`
    });
  }
}
