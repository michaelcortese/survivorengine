import {
  ActionRowBuilder,
  BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  Message,
  MessageFlags,
  StringSelectMenuBuilder,
} from "discord.js";
import { Game } from "./game";
import type Card from "./card";
import type Player from "./player";
import { GameConfig } from "./config";
import { handSelectOptions } from "../util/discord";

/**
 * Makes `player` discard 1 card of their choice (after Sorry for You, or a
 * Power Pair where all three match). A public notice has a button that opens a
 * private menu; if they don't choose in time, a random card is discarded.
 * `post` sends the public messages. Returns once the notice is up.
 */
export async function forceDiscard(
  player: Player,
  post: (payload: BaseMessageOptions) => Promise<Message | null>,
): Promise<void> {
  if (player.hand.length === 0) {
    await post({ content: `<@${player.id}> has no cards and cannot discard.` });
    return;
  }

  const gameId = Game.id;
  const menuSeconds = Math.round(GameConfig.timings.menuMs / 1000);
  let resolved = false;
  const settle = async (cardName: string | null, publicText: (card: Card) => string) => {
    if (resolved) return undefined;
    resolved = true;
    if (!Game.isCurrentGame(gameId)) return undefined; // the game has ended
    const card = (cardName ? player.removeCard(cardName) : undefined) ?? player.removeRandomCard();
    if (card) await post({ content: publicText(card) }).catch(() => undefined);
    return card;
  };

  // Public notice (no hand revealed)
  const openButton = new ButtonBuilder()
    .setCustomId("forced_discard_open")
    .setLabel("Discard a Card")
    .setStyle(ButtonStyle.Danger);
  const notice = await post({
    content: `<@${player.id}> must discard 1 card (${menuSeconds}s until a random card gets discarded). Click the button to choose privately.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(openButton)],
  });
  if (!notice) {
    // Nowhere to show the button
    await settle(null, () => `<@${player.id}> discarded a card.`);
    return;
  }

  const openCollector = notice.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: GameConfig.timings.menuMs,
  });

  openCollector.on("collect", async (btn) => {
    if (btn.user.id !== player.id) {
      await btn.reply({
        content: "You are not the player forced to discard. Stop hitting buttons you shouldn't be.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!Game.isCurrentGame(gameId)) {
      await btn.reply({ content: "That game has ended.", flags: MessageFlags.Ephemeral });
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

    if (player.hand.length === 0) {
      resolved = true;
      await btn.followUp({ content: "You have no cards left to discard.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Private (ephemeral) discard menu
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("forced_discard_select")
      .setPlaceholder("Choose a card to discard")
      .addOptions(handSelectOptions(player.hand));
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
          ? `<@${player.id}> discarded a card.`
          : `<@${player.id}> discarded **${discarded.getName()}**.`,
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
      const card = await settle(null, () => `<@${player.id}> failed to choose and auto-discarded a card.`);
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
    await settle(null, () => `<@${player.id}> failed to open discard menu and auto-discarded a card.`);
  });
}
