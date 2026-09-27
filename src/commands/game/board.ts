import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Game } from "../../game/game";
import { buildBoardMessage } from "../../game/board";
import { replyEphemeral } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("board")
    .setDescription("Show the tribe board: everyone's castaways, lives, and cards in hand")
    .addBooleanOption((option) =>
      option
        .setName("share")
        .setDescription("Post it for everyone instead of just you"),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (Game.players.length === 0) {
      return replyEphemeral(
        interaction,
        "There's no game to show. Start one with /setup or /start.",
      );
    }
    const share = interaction.options.getBoolean("share") ?? false;
    await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
    await interaction.editReply(await buildBoardMessage());
  },
};
