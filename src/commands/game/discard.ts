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

const HAS_TARGET = false;
const REQUIRED_CARD = null;
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;

export default {
  data: new SlashCommandBuilder()
    .setName("discard")
    .setDescription("Discard a card from your hand"),
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

    if (player.hand.length === 0) {
      return interaction.reply({
        content: "You have no cards to discard!",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Create dropdown with player's cards
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("discard_select")
      .setPlaceholder("Choose a card to discard")
      .addOptions(
        player.hand.map((card, index) => ({
          label: card.getName(),
          description: card.compactDescription || "No description",
          value: index.toString(),
        })),
      );

    // Create confirm button
    const confirmButton = new ButtonBuilder()
      .setCustomId("discard_confirm")
      .setLabel("Discard Publicly")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true); // Disabled until a card is selected

    // Create private discard button
    const privateButton = new ButtonBuilder()
      .setCustomId("discard_private")
      .setLabel("Discard Privately")
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
      content: "Select a card to discard:",
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
          content: "This is not your discard menu!",
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
        content: `Selected: **${selectedCard.getName()}**\nClick "Discard Publicly" or "Discard Privately".`,
        components: [row1, updatedRow2],
      });
    });

    buttonCollector.on("collect", async (buttonInteraction) => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        return buttonInteraction.reply({
          content: "This is not your discard menu!",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (selectedCardIndex === null) {
        return buttonInteraction.reply({
          content: "Please select a card first!",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cardToDiscard = player.hand[selectedCardIndex];
      player.hand.splice(selectedCardIndex, 1);

      const isPrivate = buttonInteraction.customId === "discard_private";

      await buttonInteraction.update({
        content: `You discarded **${cardToDiscard.getName()}**${isPrivate ? " privately" : ""}.`,
        components: [],
      });

      // Send public message only if not private
      if (!isPrivate) {
        await interaction.followUp({
          content: `<@${player.id}> discarded **${cardToDiscard.getName()}**!`,
        });
      }
    });

    // Handle timeout
    collector.on("end", async () => {
      if (selectedCardIndex === null) {
        await interaction.editReply({
          content: "Discard menu timed out.",
          components: [],
        });
      }
    });
  },
};
