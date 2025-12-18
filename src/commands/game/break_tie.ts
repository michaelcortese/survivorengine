import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
const HAS_TARGET = false;
const REQUIRED_CARD = null;
const INTERRUPTIBLE = false;
const STOPPING_INTERACTION = false;
const CAN_BE_PLAYED_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

export default {
  data: new SlashCommandBuilder()
    .setName("break_tie")
    .setDescription(
      "Break a tie in tribal council, or declare the winner in the final tribal council."
    )
    .addUserOption((option) =>
      option
        .setName("player1")
        .setDescription("The player to eliminate (or the winner if final tribal council)")
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName("player2")
        .setDescription(
          "The second player to eliminate (for double elimination only)"
        )
        .setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERRUPTIBLE,
      STOPPING_INTERACTION,
      CAN_BE_PLAYED_TRIBAL_COUNCIL,
      ONLY_DURING_TRIBAL_COUNCIL,
    );
    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { player } = result;

    if (Game.tribalCouncilState === TribalCouncilState.NotStarted) {
      return interaction.reply({
        content: "Unable to play card. Tribal Council has not started.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (Game.tribalCouncil?.leader !== player) {
      return interaction.reply({
        content: "You are not the leader of the tribal council.",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Get target players
    const player1Id = interaction.options.getUser("player1")?.id;
    const player2Id = interaction.options.getUser("player2")?.id;

    if (!player1Id) {
      return interaction.reply({
        content: "You must specify at least one player to eliminate (or the winner if this is the final tribal council).",
        flags: MessageFlags.Ephemeral,
      });
    }

    const targetPlayer1 = Game.getPlayerFromUserId(player1Id);
    if (!targetPlayer1) {
      return interaction.reply({
        content: "The first specified player is not in the game! Please select a valid player to eliminate or declare as winner.",
        flags: MessageFlags.Ephemeral,
      });
    }

    let targetPlayers = [targetPlayer1];

    if (player2Id) {
      const targetPlayer2 = Game.getPlayerFromUserId(player2Id);
      if (!targetPlayer2) {
        return interaction.reply({
          content: "The second specified player is not in the game! Please select a valid player for double elimination.",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (targetPlayer2 === targetPlayer1) {
        return interaction.reply({
          content: "You cannot specify the same player twice! Please select two different players for double elimination.",
          flags: MessageFlags.Ephemeral,
        });
      }
      targetPlayers.push(targetPlayer2);
    }

    // Validate that the selected players are in the tied players list
    const tribalCouncil = Game.tribalCouncil;
    if (!tribalCouncil) {
      return interaction.reply({
        content: "No tribal council is currently active! This command can also be used to declare the winner in the final tribal council if there is a tie.",
        flags: MessageFlags.Ephemeral,
      });
    }

    for (const targetPlayer of targetPlayers) {
      if (!tribalCouncil.tiedPlayers.includes(targetPlayer)) {
        return interaction.reply({
          content: `<@${targetPlayer.id}> is not one of the tied players! You may only select from the tied players (or finalists if declaring the winner).`,
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Check if we need the right number of eliminations for the tribal council type
    const isDoubleElim = tribalCouncil.tribalCouncilType === 1; // TribalCouncilType.DOUBLE
    if (
      isDoubleElim &&
      targetPlayers.length === 1 &&
      tribalCouncil.tiedPlayers.length > 2
    ) {
      return interaction.reply({
        content:
          "This is a double elimination tribal council. You must select 2 players unless there are special circumstances.",
        flags: MessageFlags.Ephemeral,
      });
    }

    return await tribalCouncil.breakTie(targetPlayers);
  },
};
