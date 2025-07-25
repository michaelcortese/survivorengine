import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import Player from "../../game/player";

export default {
  data: new SlashCommandBuilder()
    .setName("start")
    .setDescription("Starts a new game")
    .addUserOption((option) =>
      option.setName("player").setDescription("player one").setRequired(true),
    )
    .addUserOption((option) =>
      option.setName("player2").setDescription("player two").setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (Game.active) {
      return interaction.reply("A game is already in progress!");
    }

    const players: Player[] = [];
    const player1 = interaction.options.getUser("player");
    const player2 = interaction.options.getUser("player2");

    if (!player1) {
      return interaction.reply("Error: Could not find player 1");
    }

    players.push(new Player(player1.id, player1.username));
    if (player2) {
      players.push(new Player(player2.id, player2.username));
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
