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

    const players: Player[] = [];
    for (const user of users) {
      players.push(new Player(user.id, user.displayName));
    }

    Game.startGame(players);
    await interaction.reply("Game started!");
    await interaction.followUp(
      Game.players
        .map(
          (player) =>
            `${String(player.username)}: ${player.hand.map((card) => card.getName()).join(", ")}`,
        )
        .join("\n"),
    );
  },
};
