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
const REQUIRED_CARD = null;
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = false;

export default {
  data: new SlashCommandBuilder()
    .setName("give")
    .setDescription("Give a card to another player")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to give a card to")
        .setRequired(true),
    ),
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
    const { player, targetPlayer } = result;

    if (!targetPlayer) {
      return interaction.reply({
        content: "You must specify a player to give a card to.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (player.hand.length === 0) {
      return interaction.reply({
        content: "You have no cards to give!",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Create dropdown with player's cards
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("give_select")
      .setPlaceholder("Choose a card to give")
      .addOptions(
        player.hand.map((card, index) => ({
          label: card.getName(),
          description: card.compactDescription || "No description",
          value: index.toString(),
        })),
      );

    // Create confirm button
    const confirmButton = new ButtonBuilder()
      .setCustomId("give_confirm")
      .setLabel("Give Publicly")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true); // Disabled until a card is selected

    // Create private give button
    const privateButton = new ButtonBuilder()
      .setCustomId("give_private")
      .setLabel("Give Privately")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true); // Disabled until a card is selected

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      selectMenu,
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirmButton,
      privateButton,
    );

    const response = await interaction.reply({
      content: "Select a card to give away:",
      components: [row1, row2],
      flags: MessageFlags.Ephemeral,
    });

    let selectedCardIndex: number | null = null;

    // Handle interactions
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 60000, // 1 minute timeout
    });

    const buttonCollector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
    });

    collector.on("collect", async (selectInteraction) => {
      if (selectInteraction.user.id !== interaction.user.id) {
        return selectInteraction.reply({
          content: "This is not your give menu!",
          flags: MessageFlags.Ephemeral,
        });
      }

      selectedCardIndex = parseInt(selectInteraction.values[0]);
      const selectedCard = player.hand[selectedCardIndex];

      // Enable the confirm button
      const updatedConfirmButton =
        ButtonBuilder.from(confirmButton).setDisabled(false);
      const updatedPrivateButton =
        ButtonBuilder.from(privateButton).setDisabled(false);
      const updatedRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        updatedConfirmButton,
        updatedPrivateButton,
      );

      await selectInteraction.update({
        content: `Selected: **${selectedCard.getName()}**\nClick "Confirm Give" to give this card to <@${targetPlayer.id}>.`,
        components: [row1, updatedRow2],
      });
    });

    buttonCollector.on("collect", async (buttonInteraction) => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        return buttonInteraction.reply({
          content: "This is not your give menu!",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (selectedCardIndex === null) {
        return buttonInteraction.reply({
          content: "Please select a card first!",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cardToGive = player.hand[selectedCardIndex];
      player.hand.splice(selectedCardIndex, 1);
      targetPlayer.hand.push(cardToGive);

      const isPrivate = buttonInteraction.customId === "give_private";

      await buttonInteraction.update({
        content: `You gave **${cardToGive.getName()}** to <@${targetPlayer.id}>${isPrivate ? " privately" : ""}.`,
        components: [],
      });

      // Send DM to target player about receiving the card
      try {
        const targetUser = await interaction.client.users.fetch(
          targetPlayer.id,
        );
        await targetUser.send(
          `You received **${cardToGive.getName()}** from <@${player.id}> in the Survivor game!`,
        );
      } catch (error) {
        console.log(`Could not send DM to ${targetPlayer.username}:`, error);
      }

      // Send public message only if not private
      if (!isPrivate) {
        await interaction.followUp({
          content: `<@${player.id}> gave a card to <@${targetPlayer.id}>.`,
        });
      }
    });

    // Handle timeout
    collector.on("end", async () => {
      if (selectedCardIndex === null) {
        await interaction.editReply({
          content: "Give menu timed out.",
          components: [],
        });
      }
    });
  },
};
