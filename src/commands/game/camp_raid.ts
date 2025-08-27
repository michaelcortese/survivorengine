import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "Camp Raid";
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = false;
const CAN_PLAY_DURING_TRIBAL_COUNCIL = false;
export default {
  data: new SlashCommandBuilder()
    .setName("camp_raid")
    .setDescription("Raid another player's camp, steal their next draw")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose camp you want to raid")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTABLE,
      STOPPING_INTERACTION,
      CAN_PLAY_DURING_TRIBAL_COUNCIL,
      false,
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
        content: "You must specify a player to raid.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // // Respond immediately to Discord (public message)
    // let msg = await interaction.reply({
    //   content: `Attempting to raid <@${targetPlayer.id}>... (They have ~15 seconds remaining to play "Sorry For You")`,
    // });

    // Game.startCooldown(player, targetPlayer);

    // // Wait for interruption or timeout
    // const startTime = Date.now();
    // const countdownDuration = 15000; // 15 seconds in milliseconds
    // let lastDisplayedSecond = 15;

    // while (Game.interruption.active) {
    //   if (Game.interruption.stopped) {
    //     await interaction.editReply({
    //       content: `Steal attempt was interrupted with ${lastDisplayedSecond} seconds remaining`,
    //     });
    //     return interaction.followUp({
    //       content: "Your steal attempt was interrupted!",
    //       flags: MessageFlags.Ephemeral,
    //     });
    //   }

    //   const elapsed = Date.now() - startTime;
    //   const remaining = Math.max(
    //     0,
    //     Math.ceil((countdownDuration - elapsed) / 1000),
    //   );

    //   // Only update the message when the second actually changes
    //   if (remaining !== lastDisplayedSecond) {
    //     lastDisplayedSecond = remaining;
    //     await interaction.editReply({
    //       content: `Attempting to raid <@${targetPlayer.id}>... (They have ~${remaining} seconds remaining to play "Sorry For You")`,
    //     });
    //   }

    //   await new Promise((resolve) => setTimeout(resolve, 100)); // Check more frequently but update less
    // }



    //Execute the raid
    targetPlayer.campRaid = player;

    return await interaction.reply({
      content: `<@${player.id}> successfully raided <@${targetPlayer.id}>'s camp! Their next draw will given to <@${player.id}>!!!`,
    });


  },
};
