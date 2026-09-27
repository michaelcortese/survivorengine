import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import type Player from "../../game/player";
import { mention, replyEphemeral } from "../../util/discord";

/** The Final Tribal Council leader picks the winner after a tied jury vote. */
async function breakFinalTie(
  interaction: ChatInputCommandInteraction,
  player: Player,
  targets: Player[],
) {
  const council = Game.finalTribalCouncil;
  if (!council || !council.awaitingTieBreak) {
    return replyEphemeral(interaction, "There is no tie to break at Final Tribal Council.");
  }
  if (council.leader !== player) {
    return replyEphemeral(
      interaction,
      `Only the Final Tribal Council Leader (<@${council.leader.id}>) can break the tie.`,
    );
  }
  if (targets.length !== 1) {
    return replyEphemeral(interaction, "Choose exactly one winner with player1.");
  }
  await interaction.reply({ content: `<@${player.id}> is breaking the tie...` });
  const error = await council.breakTie(targets[0]);
  if (error) await replyEphemeral(interaction, error);
}

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
    const result = Game.validateAction(interaction, {
      tribalCouncil: "allowed",
      // The leader may have been voted out earlier in this same council,
      // and the Final Tribal Council leader is always on the jury.
      allowEliminated: true,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;

    // Get target players
    const targets: Player[] = [];
    for (const option of ["player1", "player2"]) {
      const user = interaction.options.getUser(option);
      if (!user) continue;
      const target = Game.getPlayerFromUserId(user.id);
      if (!target) {
        return replyEphemeral(
          interaction,
          `<@${user.id}> is not in the game! Please select one of the tied players.`,
        );
      }
      if (targets.includes(target)) {
        return replyEphemeral(
          interaction,
          "You cannot specify the same player twice! Please select two different players.",
        );
      }
      targets.push(target);
    }

    if (Game.tribalCouncilState === TribalCouncilState.FINAL) {
      return breakFinalTie(interaction, player, targets);
    }

    const tribalCouncil = Game.tribalCouncil;
    if (!tribalCouncil || Game.tribalCouncilState === TribalCouncilState.NotStarted) {
      return replyEphemeral(interaction, "No tribal council is currently active!");
    }
    if (tribalCouncil.leader !== player) {
      return replyEphemeral(interaction, "You are not the leader of the tribal council.");
    }
    const tie = tribalCouncil.pendingTie;
    if (!tie) {
      return replyEphemeral(interaction, "There is no tie to break right now.");
    }

    for (const target of targets) {
      if (!tie.tied.includes(target)) {
        return replyEphemeral(
          interaction,
          `<@${target.id}> is not one of the tied players! You may only select from: ${tie.tied.map(mention).join(", ")}.`,
        );
      }
    }
    if (targets.length !== tie.picks) {
      return replyEphemeral(
        interaction,
        tie.picks === 2
          ? "This is a double elimination tribal council. Select 2 players with player1 and player2."
          : "Select exactly 1 player to vote out with player1.",
      );
    }

    await interaction.reply({ content: `<@${player.id}> has broken the tie.` });
    await tribalCouncil.breakTie(targets);
  },
};
