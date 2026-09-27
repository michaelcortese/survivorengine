import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import Player from "../../game/player";
import { buildBoardMessage } from "../../game/board";
import { replyEphemeral, sendableChannel, userInfo } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("start")
    .setDescription("Quick-start a game with random castaways (use /setup to let players pick)")
    .addUserOption((option) => {
      return option
        .setName("player1")
        .setDescription("player one")
        .setRequired(true);
    })
    .addUserOption((option) => {
      return option
        .setName("player2")
        .setDescription("player two")
        .setRequired(true);
    })
    .addUserOption((option) => {
      return option
        .setName("player3")
        .setDescription("player three")
        .setRequired(true);
    })
    .addUserOption((option) => {
      return option
        .setName("player4")
        .setDescription("player four")
        .setRequired(false);
    })
    .addUserOption((option) => {
      return option
        .setName("player5")
        .setDescription("player five")
        .setRequired(false);
    })
    .addUserOption((option) => {
      return option
        .setName("player6")
        .setDescription("player six")
        .setRequired(false);
    })
    .addNumberOption((option) =>
      option
        .setName("discussion_minutes")
        .setDescription("Tribal Council discussion time in minutes (default 3)")
        .setMinValue(0.5)
        .setMaxValue(15),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (Game.active) {
      return replyEphemeral(
        interaction,
        "A game is already in progress! Use /end_game to end it first.",
      );
    }

    const users = [
      interaction.options.getUser("player1", true),
      interaction.options.getUser("player2", true),
      interaction.options.getUser("player3", true),
    ];
    // Add up to 3 more optional players
    for (let i = 4; i <= 6; i++) {
      const user = interaction.options.getUser(`player${i}`);
      if (user) {
        users.push(user);
      }
    }

    if (new Set(users.map((user) => user.id)).size !== users.length) {
      return replyEphemeral(interaction, "Each player can only be listed once.");
    }
    if (users.some((user) => user.bot)) {
      return replyEphemeral(interaction, "Bots can't play Survivor.");
    }

    const players = users.map((user) => {
      const info = userInfo(user);
      const player = new Player(info.id, info.displayName);
      player.avatarUrl = info.avatarUrl;
      return player;
    });

    const minutes = interaction.options.getNumber("discussion_minutes");
    // Seats are shuffled for a random turn order
    Game.startGame(players, {
      channel: sendableChannel(interaction.channel),
      discussionMs: minutes ? minutes * 60_000 : undefined,
    });

    await interaction.deferReply();
    const first = Game.currentPlayer();
    await interaction.editReply(
      await buildBoardMessage({
        content:
          `Game started! <@${first?.id}> is going first! ` +
          "Everyone got two random castaways as their lives. Rename them (or add photos) any time with /castaways.",
      }),
    );
  },
};
