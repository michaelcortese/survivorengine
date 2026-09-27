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
import { GameConfig } from "../../game/config";
import { handSelectOptions, replyEphemeral } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("discard")
    .setDescription("Discard a card from your hand"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction);
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;

    if (player.hand.length === 0) {
      return replyEphemeral(interaction, "You have no cards to discard!");
    }

    // Create dropdown with player's cards
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("discard_select")
      .setPlaceholder("Choose a card to discard")
      .addOptions(handSelectOptions(player.hand));

    const confirmButton = new ButtonBuilder()
      .setCustomId("discard_confirm")
      .setLabel("Discard Publicly")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true); // Disabled until a card is selected

    const privateButton = new ButtonBuilder()
      .setCustomId("discard_private")
      .setLabel("Discard Privately")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true); // Disabled until a card is selected

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, privateButton);

    const response = await interaction.reply({
      content: "Select a card to discard:",
      components: [row1, row2],
      flags: MessageFlags.Ephemeral,
    });

    let selectedCardName: string | null = null;
    let done = false;

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: GameConfig.timings.menuMs,
    });
    const buttonCollector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: GameConfig.timings.menuMs,
    });

    collector.on("collect", async (selectInteraction) => {
      selectedCardName = selectInteraction.values[0];
      const updatedRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ButtonBuilder.from(confirmButton).setDisabled(false),
        ButtonBuilder.from(privateButton).setDisabled(false),
      );
      await selectInteraction.update({
        content: `Selected: **${selectedCardName}**\nClick "Discard Publicly" or "Discard Privately".`,
        components: [row1, updatedRow2],
      });
    });

    buttonCollector.on("collect", async (buttonInteraction) => {
      if (selectedCardName === null) {
        return buttonInteraction.reply({
          content: "Please select a card first!",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cardToDiscard = player.removeCard(selectedCardName);
      if (!cardToDiscard) {
        return buttonInteraction.reply({
          content: `You don't have **${selectedCardName}** anymore.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      done = true;
      collector.stop("done");
      buttonCollector.stop("done");

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
      if (!done) {
        await interaction
          .editReply({ content: "Discard menu timed out.", components: [] })
          .catch(() => undefined);
      }
    });
  },
};
