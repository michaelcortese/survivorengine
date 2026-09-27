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
import { CardName } from "../../game/cards";
import { GameConfig } from "../../game/config";
import {
  handSelectOptions,
  replyEphemeral,
  runSorryForYouWindow,
  sendDM,
} from "../../util/discord";

const REQUIRED_CARD = CardName.SpyShack;

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
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
      interruptible: true,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "You must specify a player to spy on.");
    }
    if (targetPlayer.hand.length === 0) {
      // Checked before the card is played, so you keep your Spy Shack
      return replyEphemeral(interaction, `<@${targetPlayer.id}> has no cards to spy on!`);
    }

    // The card is played now, whether or not the spying gets blocked
    const played = player.removeCard(REQUIRED_CARD)!;
    let window;
    try {
      window = await runSorryForYouWindow(
        interaction,
        player,
        targetPlayer,
        (seconds) =>
          `<@${player.id}> is attempting to spy on <@${targetPlayer.id}>... (They have ~${seconds} seconds remaining to play "Sorry For You")`,
      );
    } catch (error) {
      player.hand.push(played); // Discord failed: give the card back
      throw error;
    }
    if (!window) {
      player.hand.push(played);
      return replyEphemeral(
        interaction,
        "This action cannot be played at this time. Wait a moment and try again.",
      );
    }

    if (window.outcome === "stopped") {
      await interaction.editReply({
        content: `Spy attempt was interrupted with ${window.secondsLeft} seconds remaining`,
      });
      return interaction.followUp({
        content: "Your spy attempt was interrupted!",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (targetPlayer.hand.length === 0) {
      return interaction.editReply({
        content: `<@${player.id}> spied on <@${targetPlayer.id}>, but their hand was empty.`,
      });
    }

    await interaction.editReply({
      content: `<@${player.id}> is spying on <@${targetPlayer.id}>'s hand`,
    });

    // Show the target player's hand to the spy with selection interface
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("spy_select")
      .setPlaceholder("Choose a card to take")
      .addOptions(handSelectOptions(targetPlayer.hand));

    const takeButton = new ButtonBuilder()
      .setCustomId("spy_take")
      .setLabel("Take Card")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true); // Disabled until a card is selected

    const cancelButton = new ButtonBuilder()
      .setCustomId("spy_cancel")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(takeButton, cancelButton);

    const spyResponse = await interaction.followUp({
      content: `Select a card to take from <@${targetPlayer.id}>'s hand:`,
      components: [row1, row2],
      flags: MessageFlags.Ephemeral,
    });

    let selectedCardName: string | null = null;
    let done = false;

    const collector = spyResponse.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: GameConfig.timings.menuMs,
    });
    const buttonCollector = spyResponse.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: GameConfig.timings.menuMs,
    });

    collector.on("collect", async (selectInteraction) => {
      if (selectInteraction.user.id !== interaction.user.id) {
        return selectInteraction.reply({
          content: "This is not your spy menu!",
          flags: MessageFlags.Ephemeral,
        });
      }
      selectedCardName = selectInteraction.values[0];
      const updatedRow2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ButtonBuilder.from(takeButton).setDisabled(false),
        cancelButton,
      );
      await selectInteraction.update({
        content: `Selected: **${selectedCardName}**\nClick "Take Card" to take this card or "Cancel" to leave empty-handed.`,
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
        done = true;
        collector.stop("done");
        buttonCollector.stop("done");
        await buttonInteraction.update({
          content: `You chose not to take any cards from <@${targetPlayer.id}>.`,
          components: [],
        });
        await interaction.editReply({
          content: `<@${player.id}> spied on <@${targetPlayer.id}> but took nothing.`,
        });
        return;
      }

      if (selectedCardName === null) {
        return buttonInteraction.reply({
          content: "Please select a card first!",
          flags: MessageFlags.Ephemeral,
        });
      }

      const cardToTake = targetPlayer.removeCard(selectedCardName);
      if (!cardToTake) {
        return buttonInteraction.reply({
          content: `<@${targetPlayer.id}> doesn't have **${selectedCardName}** anymore. Pick another card.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      done = true;
      collector.stop("done");
      buttonCollector.stop("done");
      player.hand.push(cardToTake);

      await buttonInteraction.update({
        content: `You took **${cardToTake.getName()}** from <@${targetPlayer.id}>.`,
        components: [],
      });
      await sendDM(
        interaction.client,
        targetPlayer.id,
        `<@${player.id}> spied on your hand and took **${cardToTake.getName()}** in the Survivor game!`,
      );
      await interaction.editReply({
        content: `<@${player.id}> spied on <@${targetPlayer.id}> and took a card.`,
      });
    });

    // Handle timeout
    collector.on("end", async () => {
      if (!done) {
        await interaction
          .editReply({ content: `<@${player.id}>'s spy attempt timed out.` })
          .catch(() => undefined);
      }
    });
  },
};
