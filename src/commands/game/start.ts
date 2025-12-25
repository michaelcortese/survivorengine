import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import Player from "../../game/player";

export default {
  data: new SlashCommandBuilder()
    .setName("start")
    .setDescription("Starts a new game")
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
    }),
  async execute(interaction: ChatInputCommandInteraction) {
    if (Game.active) {
      return interaction.reply("A game is already in progress!");
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

    const players: Player[] = [];
    for (const user of users) {
      players.push(new Player(user.id, user.displayName));
    }

    // Shuffle the players array for random turn order
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }

    Game.startGame(players);
    await interaction.reply("Game started! " + "<@" + Game.players[Game.currentPlayerIndex].id + "> is going first!");
    // await interaction.followUp(
    //   Game.players
    //     .map(
    //       (player) =>
    //         `${String(player.username)}: ${player.hand.map((card) => card.getName()).join(", ")}`,
    //     )
    //     .join("\n"),
    // );
  },
};
