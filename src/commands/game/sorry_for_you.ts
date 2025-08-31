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
const REQUIRED_CARD = "Sorry for You";
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = true;

export default {
  data: new SlashCommandBuilder()
    .setName("sorry_for_you")
    .setDescription("Play the Sorry For You card, stopping an interaction"),
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
    const { player } = result;

    // if (!player) {
    //     return interaction.reply({content: 'You are not a player in the current game!', flags: MessageFlags.Ephemeral});
    // }
    // //check if the player has the Sorry For You card
    // if (!player.hasCard('Sorry for You')) {
    //     return interaction.reply({content: 'You do not have the Sorry For You card!', flags: MessageFlags.Ephemeral});
    // }
    // if (!Game.interruption.active) {
    //     return interaction.reply({content: 'You can\'t play this here', flags: MessageFlags.Ephemeral});
    // }
    // if (Game.interruption.sender && Game.interruption.sender.id === player.id) {
    //     return interaction.reply({content: 'You can\'t stop your own interaction!', flags: MessageFlags.Ephemeral});
    // }

    const attacker = Game.interruption.sender; // player who initiated the steal/spy
    const defender = player; // player who plays Sorry For You

    if (!attacker) {
      return interaction.reply({
        content: `There is no active interaction to stop!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Ensure only the targeted player (victim) can play Sorry For You
    if (!Game.interruption.target || Game.interruption.target.id !== defender.id) {
      return interaction.reply({
        content: `Only the targeted player (${Game.interruption.target ? `<@${Game.interruption.target.id}>` : "none"}) can play Sorry For You right now!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Prevent the initiator from using it on themselves (extra safety)
    if (attacker.id === defender.id) {
      return interaction.reply({
        content: `You cannot play Sorry For You on your own action!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Signal to the ongoing action loop that it was stopped
    Game.interruption.stopped = true;

    await interaction.reply({
      content: `<@${defender.id}> played **Sorry For You** and stopped <@${attacker.id}>'s action! <@${attacker.id}> must discard 1 card.`,
    });

    // Capture attacker's hand before resetting interruption
    const attackerHand = attacker.hand;

    // Properly clear interruption state so the original command doesn't leave the game locked.
    // (We keep stopped = true so post-loop guards can detect interruption.)
    Game.interruption.active = false;
    Game.interruption.sender = null;
    Game.interruption.target = null;

    if (attackerHand.length === 0) {
      await interaction.followUp({
        content: `<@${attacker.id}> has no cards and cannot discard.`,
      });
      return;
    }

    // Public notice (no hand revealed)
    const openButton = new ButtonBuilder()
      .setCustomId("forced_discard_open")
      .setLabel("Discard a Card")
      .setStyle(ButtonStyle.Danger);

    const openRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      openButton,
    );

    await interaction.followUp({
      content: `<@${attacker.id}> must discard 1 card (60s until a random card gets discarded). Click the button to choose privately.`,
      components: [openRow],
    });

    // Collector for the public “open” button
    const openCollector = interaction.channel?.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      filter: (i) => i.customId === "forced_discard_open",
    });

    if (!openCollector) return;

    openCollector.on("collect", async (btn) => {
      if (btn.user.id !== attacker.id) {
        return btn.reply({
          content: "You are not the player forced to discard. Stop hitting buttons you shouldn't be.",
          flags: MessageFlags.Ephemeral,
        });
      }
      // Stop further opens
      openCollector.stop("opened");
      // Build private (ephemeral) discard UI for the ATTACKER (button clicker)
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("forced_discard_select")
        .setPlaceholder("Choose a card to discard")
        .addOptions(
          attackerHand.map((card, index) => ({
            label: card.getName(),
            description: card.compactDescription || "No description",
            value: index.toString(),
          })),
        );
      const confirmButton = new ButtonBuilder()
        .setCustomId("forced_discard_confirm")
        .setLabel("Discard Selected")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true);
      const cancelButton = new ButtonBuilder()
        .setCustomId("forced_discard_cancel")
        .setLabel("Cancel (Random)")
        .setStyle(ButtonStyle.Secondary);
      const rowSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      const rowButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton);

      // Disable the public button so others can't click after attacker opens
      try {
        const disabledOpen = ButtonBuilder.from(openButton).setDisabled(true);
        await btn.message.edit({
          content: btn.message.content,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(disabledOpen)],
        });
      } catch {}

      // Ephemeral reply bound to button interaction (correct recipient = attacker)
      // Use deferReply to create ephemeral context then edit; fetch reply for collectors
      await btn.deferReply({ ephemeral: true });
      await btn.editReply({
        content: "Select a card to discard:",
        components: [rowSelect, rowButtons],
      });
      const ephemeralMessage = await btn.fetchReply();

      let chosenIndex: number | null = null;
      const selectCollector = (ephemeralMessage as any).createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60_000,
      });
      const buttonCollector = (ephemeralMessage as any).createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60_000,
      });

  selectCollector.on("collect", async (comp: any) => {
        if (comp.user.id !== attacker.id) {
          return comp.reply({ content: "Not yours.", flags: MessageFlags.Ephemeral });
        }
        chosenIndex = parseInt(comp.values[0], 10);
        const enabledConfirm = ButtonBuilder.from(confirmButton).setDisabled(false);
        const newButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(enabledConfirm, cancelButton);
        await comp.update({
          content: `Selected **${attackerHand[chosenIndex].getName()}**. Confirm to discard or cancel for random.`,
          components: [rowSelect, newButtons],
        });
      });

  buttonCollector.on("collect", async (comp: any) => {
        if (comp.user.id !== attacker.id) {
          return comp.reply({ content: "Not yours.", flags: MessageFlags.Ephemeral });
        }
        if (comp.customId === "forced_discard_cancel") {
          const randIdx = Math.floor(Math.random() * attackerHand.length);
          const auto = attackerHand[randIdx];
          attackerHand.splice(randIdx, 1);
          await comp.update({ content: `Timeout/Cancel: auto-discarded **${auto.getName()}**.`, components: [] });
          await interaction.followUp({ content: `<@${attacker.id}> discarded a card.` });
          selectCollector.stop("done");
          buttonCollector.stop("done");
          return;
        }
        if (comp.customId === "forced_discard_confirm") {
          if (chosenIndex === null) {
            return comp.reply({ content: "Select first.", flags: MessageFlags.Ephemeral });
          }
          const discarded = attackerHand[chosenIndex];
          attackerHand.splice(chosenIndex, 1);
          await comp.update({ content: `You discarded **${discarded.getName()}**.`, components: [] });
          await interaction.followUp({ content: `<@${attacker.id}> discarded **${discarded.getName()}**.` });
          selectCollector.stop("done");
          buttonCollector.stop("done");
        }
      });

      const finalize = async (reason: string) => {
        if (reason !== "done") {
          if (chosenIndex === null && attackerHand.length > 0) {
            const randIdx = Math.floor(Math.random() * attackerHand.length);
            const auto = attackerHand[randIdx];
            attackerHand.splice(randIdx, 1);
            await interaction.followUp({ content: `<@${attacker.id}> failed to choose and auto-discarded a card.` });
            try {
              await btn.editReply({ content: `Auto-discarded **${auto.getName()}** (timeout).`, components: [] });
            } catch {}
          }
        }
        Game.interruption.stopped = false;
      };

      selectCollector.on("end", finalize);
      buttonCollector.on("end", finalize);
    });

    openCollector.on("end", async (_c, reason) => {
      if (reason === "time") {
        // Never opened → auto-discard
        if (attackerHand.length > 0) {
          const randIdx = Math.floor(Math.random() * attackerHand.length);
          const auto = attackerHand[randIdx];
          attackerHand.splice(randIdx, 1);
          await interaction.followUp({
            content: `<@${attacker.id}> failed to open discard menu and auto-discarded a card.`,
          });
        }
        Game.interruption.stopped = false;
      }
    });
  },
};
