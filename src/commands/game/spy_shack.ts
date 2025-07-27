import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { Game } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "The Spy Shack";
const INTERRUPTABLE = true;
const STOPPING_INTERACTION = false;

export default {
  data: new SlashCommandBuilder()
    .setName("spy_shack")
    .setDescription("Spy on another player's hand and take a card from it")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose hand you want to spy on")
        .setRequired(true),
    ),
  execute: async (interaction: ChatInputCommandInteraction) => {
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
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return interaction.reply({
        content: "You must specify a player to spy on.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (targetPlayer.hand.length === 0) {
      //TODO give the card back to the player
      return interaction.reply({
        content: `<@${targetPlayer.id}> has no cards to spy on!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Respond immediately to Discord (public message)
    let msg = await interaction.reply({
      content: `<@${player.id}> is attempting to spy on <@${targetPlayer.id}>... (They have ~15 seconds remaining to play "Sorry For You")`,
    });
    Game.startCooldown(player, targetPlayer);
    // Wait for interruption or timeout
    const startTime = Date.now();
    let lastDisplayedSecond = 15;
    const countdownDuration = lastDisplayedSecond * 1000; // 15 seconds in milliseconds
    while (Game.interruption.active) {
      if (Game.interruption.stopped) {
        await interaction.editReply({
          content: `Spy attempt was interrupted with ${lastDisplayedSecond} seconds remaining`,
        });
        return interaction.followUp({
          content: "Your spy attempt was interrupted!",
          flags: MessageFlags.Ephemeral,
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
          content: `<@${player.id}> is attempting to spy on <@${targetPlayer.id}>... (They have ~${remaining} seconds remaining to play "Sorry For You")`,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 100)); // Check more frequently but update less
    }

    await interaction.editReply({
      content: `<@${player.id}> is spying on <@${targetPlayer.id}>'s hand`,
    });

    // Show the target player's hand to the spy with selection interface
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("spy_select")
      .setPlaceholder("Choose a card to take")
      .addOptions(
        targetPlayer.hand.map((card, index) => ({
          label: card.getName(),
          description: card.compactDescription || "No description",
          value: index.toString(),
        })),
      );

    // Create take button
    const takeButton = new ButtonBuilder()
      .setCustomId("spy_take")
      .setLabel("Take Card")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true); // Disabled until a card is selected

    // Create cancel button
    const cancelButton = new ButtonBuilder()
      .setCustomId("spy_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      selectMenu,
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      takeButton,
      cancelButton,
    );

    const spyResponse = await interaction.followUp({
      content: `Select a card to take from <@${targetPlayer.id}>'s hand:`,
      components: [row1, row2],
      flags: MessageFlags.Ephemeral,
    });

    let selectedCardIndex: number | null = null;

    // Handle interactions
    const collector = spyResponse.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 60000, // 1 minute timeout
    });

    const buttonCollector = spyResponse.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
    });

    collector.on("collect", async (selectInteraction) => {
      if (selectInteraction.user.id !== interaction.user.id) {
        return selectInteraction.reply({
          content: "This is not your spy menu!",
          flags: MessageFlags.Ephemeral,
        });
      }

      selectedCardIndex = parseInt(selectInteraction.values[0]);
      const selectedCard = targetPlayer.hand[selectedCardIndex];

      // Enable the take button
      const updatedTakeButton =
        ButtonBuilder.from(takeButton).setDisabled(false);
      const updatedRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        updatedTakeButton,
        cancelButton,
      );

      await selectInteraction.update({
        content: `Selected: **${selectedCard.getName()}**\nClick "Take Card" to take this card or "Cancel" to leave empty-handed.`,
        components: [row1, updatedRow2],
      });
    });

    buttonCollector.on("collect", async (buttonInteraction) => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        return buttonInteraction.reply({
          content: "This is not your spy menu!",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (buttonInteraction.customId === "spy_cancel") {
        await buttonInteraction.update({
          content: `You chose not to take any cards from <@${targetPlayer.id}>.`,
          components: [],
        });

        await interaction.editReply({
          content: `<@${player.id}> spied on <@${targetPlayer.id}> but took nothing.`,
        });

        // TODO give the card back to the player
        return;
      }

      if (selectedCardIndex === null) {
        return buttonInteraction.reply({
          content: "Please select a card first!",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cardToTake = targetPlayer.hand[selectedCardIndex];
      targetPlayer.hand.splice(selectedCardIndex, 1);
      player.hand.push(cardToTake);

      await buttonInteraction.update({
        content: `You took **${cardToTake.getName()}** from <@${targetPlayer.id}>.`,
        components: [],
      });

      // Send DM to target player about losing the card
      try {
        const targetUser = await interaction.client.users.fetch(
          targetPlayer.id,
        );
        await targetUser.send(
          `<@${player.id}> spied on your hand and took **${cardToTake.getName()}** in the Survivor game!`,
        );
      } catch (error) {
        console.log(`Could not send DM to ${targetPlayer.username}:`, error);
      }

      // Update public message
      await interaction.editReply({
        content: `<@${player.id}> spied on <@${targetPlayer.id}> and took a card.`,
      });
    });

    // Handle timeout
    collector.on("end", async () => {
      if (selectedCardIndex === null) {
        await interaction.editReply({
          content: `<@${player.id}>'s spy attempt timed out.`,
        });
      }
    });
  },
};
