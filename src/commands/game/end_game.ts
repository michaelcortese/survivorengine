import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

const CONFIRM_MS = 30_000;

export default {
  data: new SlashCommandBuilder()
    .setName("end_game")
    .setDescription("End the current game (or cancel a game being set up) so a new one can start"),
  async execute(interaction: ChatInputCommandInteraction) {
    const lobbyOpen = !!Game.lobby && !Game.lobby.closed;
    if (!Game.active && !lobbyOpen) {
      return replyEphemeral(interaction, "There's no game or game setup to end.");
    }
    if (!Game.canManage(interaction)) {
      return replyEphemeral(
        interaction,
        "Only players in the game (or the host, or a server manager) can end it.",
      );
    }

    const what = Game.active ? "the current game" : "the game being set up";
    const confirm = new ButtonBuilder()
      .setCustomId("end_game_confirm")
      .setLabel(Game.active ? "End the game" : "Cancel the setup")
      .setStyle(ButtonStyle.Danger);
    const keep = new ButtonBuilder()
      .setCustomId("end_game_keep")
      .setLabel("Keep playing")
      .setStyle(ButtonStyle.Secondary);

    const response = await interaction.reply({
      content: `End ${what} for everyone? This can't be undone.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, keep)],
      flags: MessageFlags.Ephemeral,
    });

    const gameId = Game.id;
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: CONFIRM_MS,
      max: 1,
    });
    collector.on("collect", async (click) => {
      if (click.customId !== "end_game_confirm") {
        await click.update({ content: "Carry on! Nothing was changed.", components: [] });
        return;
      }
      if (!Game.isCurrentGame(gameId)) {
        await click.update({ content: "That game already ended.", components: [] });
        return;
      }
      Game.reset(`<@${interaction.user.id}> cancelled this game setup with /end_game.`);
      await click.update({ content: `You ended ${what}.`, components: [] });
      await interaction.followUp({
        content: `🛑 <@${interaction.user.id}> ended ${what}. Start a new one with /setup or /start.`,
      });
    });
    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        await interaction
          .editReply({ content: "No changes made.", components: [] })
          .catch(() => undefined);
      }
    });
  },
};
