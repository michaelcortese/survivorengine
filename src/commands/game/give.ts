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
import { handSelectOptions, replyEphemeral, sendDM } from "../../util/discord";

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
    const result = Game.validateAction(interaction, { target: true });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;

    if (!targetPlayer) {
      return replyEphemeral(interaction, "You must specify a player to give a card to.");
    }
    if (player.hand.length === 0) {
      return replyEphemeral(interaction, "You have no cards to give!");
    }

    // Create dropdown with player's cards
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("give_select")
      .setPlaceholder("Choose a card to give")
      .addOptions(handSelectOptions(player.hand));

    const confirmButton = new ButtonBuilder()
      .setCustomId("give_confirm")
      .setLabel("Give Publicly")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true); // Disabled until a card is selected

    const privateButton = new ButtonBuilder()
      .setCustomId("give_private")
      .setLabel("Give Privately")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true); // Disabled until a card is selected

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, privateButton);

    const response = await interaction.reply({
      content: "Select a card to give away:",
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
        content: `Selected: **${selectedCardName}**\nChoose "Give Publicly" or "Give Privately" to give this card to <@${targetPlayer.id}>.`,
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
      if (!Game.active || !player.isAlive() || !targetPlayer.isAlive()) {
        done = true;
        collector.stop("done");
        buttonCollector.stop("done");
        return buttonInteraction.update({
          content: "That give can't happen anymore.",
          components: [],
        });
      }

      const cardToGive = player.removeCard(selectedCardName);
      if (!cardToGive) {
        return buttonInteraction.reply({
          content: `You don't have **${selectedCardName}** anymore.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      done = true;
      collector.stop("done");
      buttonCollector.stop("done");
      targetPlayer.hand.push(cardToGive);

      const isPrivate = buttonInteraction.customId === "give_private";
      await buttonInteraction.update({
        content: `You gave **${cardToGive.getName()}** to <@${targetPlayer.id}>${isPrivate ? " privately" : ""}.`,
        components: [],
      });

      // Send DM to target player about receiving the card
      await sendDM(
        interaction.client,
        targetPlayer.id,
        `You received **${cardToGive.getName()}** from <@${player.id}> in the Survivor game!`,
      );

      // Send public message only if not private
      if (!isPrivate) {
        await interaction.followUp({
          content: `<@${player.id}> gave a card to <@${targetPlayer.id}>.`,
        });
      }
    });

    // Handle timeout
    collector.on("end", async () => {
      if (!done) {
        await interaction
          .editReply({ content: "Give menu timed out.", components: [] })
          .catch(() => undefined);
      }
    });
  },
};
