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
import type Card from "../../game/card";
import type Player from "../../game/player";
import { CardName } from "../../game/cards";
import { GameConfig } from "../../game/config";
import { handSelectOptions, replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.SorryForYou;

function discardRandom(player: Player): Card | undefined {
  if (player.hand.length === 0) return undefined;
  const index = Math.floor(Math.random() * player.hand.length);
  return player.hand.splice(index, 1)[0];
}

export default {
  data: new SlashCommandBuilder()
    .setName("sorry_for_you")
    .setDescription("Play the Sorry For You card, stopping an interaction"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      requiredCard: REQUIRED_CARD,
      // Knowledge is Power can be played at Tribal Council, so this can be too
      tribalCouncil: "allowed",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const defender = result.player; // player who plays Sorry For You

    const interruption = Game.interruption;
    if (!interruption) {
      return replyEphemeral(interaction, "There is no interaction to stop!");
    }
    // Ensure only the targeted player (victim) can play Sorry For You
    if (interruption.target !== defender) {
      return replyEphemeral(
        interaction,
        `Only the targeted player (<@${interruption.target.id}>) can play Sorry For You right now!`,
      );
    }
    if (interruption.attacker === defender) {
      return replyEphemeral(interaction, "You cannot play Sorry For You on your own action!");
    }

    defender.removeCard(REQUIRED_CARD);
    // Signal to the ongoing action that it was stopped
    const attacker = Game.blockInterruption();
    if (!attacker) {
      return replyEphemeral(interaction, "There is no interaction to stop!");
    }

    await interaction.reply({
      content: `<@${defender.id}> played **Sorry For You** and stopped <@${attacker.id}>'s action! <@${attacker.id}> must discard 1 card.`,
    });

    if (attacker.hand.length === 0) {
      await interaction.followUp({
        content: `<@${attacker.id}> has no cards and cannot discard.`,
      });
      return;
    }

    const menuSeconds = Math.round(GameConfig.timings.menuMs / 1000);
    let resolved = false;
    const settle = async (cardName: string | null, publicText: (card: Card) => string) => {
      if (resolved) return undefined;
      resolved = true;
      const card = (cardName ? attacker.removeCard(cardName) : undefined) ?? discardRandom(attacker);
      if (card) await interaction.followUp({ content: publicText(card) }).catch(() => undefined);
      return card;
    };

    // Public notice (no hand revealed)
    const openButton = new ButtonBuilder()
      .setCustomId("forced_discard_open")
      .setLabel("Discard a Card")
      .setStyle(ButtonStyle.Danger);
    const notice = await interaction.followUp({
      content: `<@${attacker.id}> must discard 1 card (${menuSeconds}s until a random card gets discarded). Click the button to choose privately.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(openButton)],
    });

    const openCollector = notice.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: GameConfig.timings.menuMs,
    });

    openCollector.on("collect", async (btn) => {
      if (btn.user.id !== attacker.id) {
        await btn.reply({
          content: "You are not the player forced to discard. Stop hitting buttons you shouldn't be.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      openCollector.stop("opened");

      // Disable the public button so it can't be opened twice
      await btn.update({
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ButtonBuilder.from(openButton).setDisabled(true),
          ),
        ],
      });

      if (attacker.hand.length === 0) {
        resolved = true;
        await btn.followUp({ content: "You have no cards left to discard.", flags: MessageFlags.Ephemeral });
        return;
      }

      // Private (ephemeral) discard menu for the attacker
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("forced_discard_select")
        .setPlaceholder("Choose a card to discard")
        .addOptions(handSelectOptions(attacker.hand));
      const confirmButton = new ButtonBuilder()
        .setCustomId("forced_discard_confirm")
        .setLabel("Discard Selected")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true);
      const randomButton = new ButtonBuilder()
        .setCustomId("forced_discard_cancel")
        .setLabel("Cancel (Random)")
        .setStyle(ButtonStyle.Secondary);
      const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      const rowButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, randomButton);

      const menu = await btn.followUp({
        content: "Select a card to discard:",
        components: [rowSelect, rowButtons],
        flags: MessageFlags.Ephemeral,
      });

      let chosenName: string | null = null;
      const selectCollector = menu.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: GameConfig.timings.menuMs,
      });
      const buttonCollector = menu.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GameConfig.timings.menuMs,
      });
      const stopMenus = () => {
        selectCollector.stop("done");
        buttonCollector.stop("done");
      };

      selectCollector.on("collect", async (comp) => {
        chosenName = comp.values[0];
        await comp.update({
          content: `Selected **${chosenName}**. Confirm to discard or cancel for random.`,
          components: [
            rowSelect,
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              ButtonBuilder.from(confirmButton).setDisabled(false),
              randomButton,
            ),
          ],
        });
      });

      buttonCollector.on("collect", async (comp) => {
        if (comp.customId === "forced_discard_confirm" && chosenName === null) {
          await comp.reply({ content: "Select first.", flags: MessageFlags.Ephemeral });
          return;
        }
        const random = comp.customId === "forced_discard_cancel";
        // settle() marks the discard as done before stopping the menus, because
        // stopping a collector fires its "end" handler straight away.
        const discarding = settle(random ? null : chosenName, (discarded) =>
          random
            ? `<@${attacker.id}> discarded a card.`
            : `<@${attacker.id}> discarded **${discarded.getName()}**.`,
        );
        stopMenus();
        const card = await discarding;
        await comp.update({
          content: card
            ? `${random ? "Auto-discarded" : "You discarded"} **${card.getName()}**.`
            : "You have no cards left to discard.",
          components: [],
        });
      });

      buttonCollector.on("end", async (_collected, reason) => {
        if (reason !== "time" || resolved) return;
        stopMenus();
        const card = await settle(null, () => `<@${attacker.id}> failed to choose and auto-discarded a card.`);
        if (card) {
          await btn
            .editReply({ message: menu.id, content: `Auto-discarded **${card.getName()}** (timeout).`, components: [] })
            .catch(() => undefined);
        }
      });
    });

    openCollector.on("end", async (_collected, reason) => {
      if (reason !== "time" || resolved) return;
      // Never opened → auto-discard
      await notice.edit({ components: [] }).catch(() => undefined);
      await settle(null, () => `<@${attacker.id}> failed to open discard menu and auto-discarded a card.`);
    });
  },
};
