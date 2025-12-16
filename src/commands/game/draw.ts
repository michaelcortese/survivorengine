// TODO add draw TRIBAL
import { TribalCouncil, TribalCouncilType } from "../../game/tribal_council";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
const HAS_TARGET = false;
const REQUIRED_CARD = null;
const INTERRUPTIBLE = true;
const STOPPING_INTERACTION = false;

export default {
  data: new SlashCommandBuilder()
    .setName("draw")
    .setDescription("Draw a card from the deck"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTIBLE,
      STOPPING_INTERACTION,
    );
    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { player } = result;
    const card = Game.deck.drawCard();
    if (card === undefined) {
      return interaction.reply("No cards left in the deck.");
    }

    // CHECK FOR TRIBAL COUNCIL
    if (card.getName() === "Tribal Council") {
      // Card drawn was tribal council, tell game
      Game.tribalCouncilState = TribalCouncilState.Discussion;

      // Determine tribal council type from option or default to single
      const tribalType = card.tribalValue;
      // messy, so why do we even need this?
      const tribalCouncilType =
        tribalType === 2 ? TribalCouncilType.DOUBLE : TribalCouncilType.SINGLE;

      Game.setTribalCouncil(new TribalCouncil(interaction, tribalCouncilType));
      await Game.tribalCouncil?.init();
      return;
    }

    // check for camp raid
    if (player.campRaid) {

      // Respond immediately to Discord (public message)
      let msg = await interaction.reply({
        content: `<@${player.campRaid.id}> is attempting to steal <@${player.id}>'s draw... (<@${player.id}> has ~15 seconds remaining to play "Sorry For You")`,
      });

      // show player card
      await interaction.followUp({
        content: `You drew a ${card.getName()} (${card.getImage()}), and <@${player.campRaid.id}> is attempting to raid your camp and steal it`,
        flags: MessageFlags.Ephemeral,
      });

      Game.startCooldown(player.campRaid, player);

      // Wait for interruption or timeout
      const startTime = Date.now();
      const countdownDuration = 15000; // 15 seconds in milliseconds
      let lastDisplayedSecond = 15;

      while (Game.interruption.active) {
        if (Game.interruption.stopped) {
          await interaction.editReply({
            content: `Steal attempt was interrupted with ${lastDisplayedSecond} seconds remaining`,
          });

          await interaction.followUp({
            content: `You drew a ${card.getName()} (${card.getImage()}).`,
            flags: MessageFlags.Ephemeral,
          });
          return await interaction.followUp({
            content: `<@${player.id}> drew a card.`,
            flags: undefined,
          });
        }

        const elapsed = Date.now() - startTime;
        const remaining = Math.max(
          0,
          Math.ceil((countdownDuration - elapsed) / 1000),
        );

        // Only update the message when the second actually changes
        if (remaining !== lastDisplayedSecond) {
          lastDisplayedSecond = remaining;
          await interaction.editReply({
            content: `<@${player.campRaid.id}> is attempting to steal <@${player.id}>'s draw... (<@${player.id}> has ~${remaining} seconds remaining to play "Sorry For You")`,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 100)); // Check more frequently but update less
      }

      await interaction.editReply({
        content: `<@${player.campRaid.id}> has stolen a card from <@${player.id}>!!!`,
      });

      // add card to camp raid hand
      player.campRaid.hand.push(card);

      // Send DM to target player about receiving the card
      try {
        const targetUser = await interaction.client.users.fetch(
          player.campRaid.id,
        );
        await targetUser.send(
          `You received **${card.getName()}** from <@${player.id}> from your camp raid!`,
        );
      } catch (error) {
        console.log(`Could not send DM to <@${player.campRaid.id}>:`, error);
      }

      await interaction.followUp({
        content: `<@${player.id}> drew a card, but it was stolen by <@${player.campRaid.id}>`,
        flags: undefined,
      });

      player.campRaid = undefined;

      return;
    }

    player.hand.push(card);
    await interaction.reply({
      content: `You drew a ${card.getName()} (${card.getImage()}).`,
      flags: MessageFlags.Ephemeral,
    });
    return await interaction.followUp({
      content: `<@${player.id}> drew a card.`,
      flags: undefined,
    });
  },
};
