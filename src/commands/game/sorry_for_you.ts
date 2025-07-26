import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = false;
const REQUIRED_CARD = "Sorry for You";
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = true;

export default {
  data: new SlashCommandBuilder()
    .setName("sorry_for_you")
    .setDescription("Play the Sorry For You card, stopping an interaction"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTABLE,
      STOPPING_INTERACTION,
    );

    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { player } = result;

    // if (!player) {
    //     return interaction.reply({content: 'You are not a player in the current game!', flags: MessageFlags.Ephemeral});
    // }
    // //check if the player has the Sorry For You card
    // if (!player.hasCard('Sorry for You')) {
    //     return interaction.reply({content: 'You do not have the Sorry For You card!', flags: MessageFlags.Ephemeral});
    // }
    // if (!Game.interruption.active) {
    //     return interaction.reply({content: 'You can\'t play this here', flags: MessageFlags.Ephemeral});
    // }
    // if (Game.interruption.sender && Game.interruption.sender.id === player.id) {
    //     return interaction.reply({content: 'You can\'t stop your own interaction!', flags: MessageFlags.Ephemeral});
    // }
    // //Remove the Sorry For You card from the player's hand
    // player.removeCard('Sorry For You');
    let targetId = Game.interruption.sender?.id;
    //Game.stopInterruption(); // Replace the manual assignment
    Game.interruption.stopped = true; // Mark the interruption as stopped
    await interaction.reply({
      content: `<@${player.id}> played the Sorry For You card and stopped <@${targetId}>'s interaction!`,
      ephemeral: false,
    });
  },
};
