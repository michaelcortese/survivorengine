import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

/** Jury vote at the Final Tribal Council. */
async function castJuryVote(interaction: ChatInputCommandInteraction) {
  const council = Game.finalTribalCouncil;
  const juror = Game.getPlayerFromUserId(interaction.user.id);
  const finalist = Game.getPlayerFromUserId(interaction.options.getUser("player", true).id);
  if (!council || !juror) {
    return replyEphemeral(interaction, "You are not on the jury.");
  }
  if (!finalist) {
    return replyEphemeral(interaction, "The specified player is not in the game!");
  }
  const error = council.recordVote(juror, finalist);
  if (error) {
    return replyEphemeral(interaction, error);
  }
  await interaction.reply({
    content: `Your vote for <@${finalist.id}> is locked in. 🔒`,
    flags: MessageFlags.Ephemeral,
  });
  await council.afterVote();
}

export default {
  data: new SlashCommandBuilder()
    .setName("cast_vote")
    .setDescription("TRIBAL COUNCIL ONLY: vote a player out (or, on the jury, vote for the winner)")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to vote for")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (Game.active && Game.tribalCouncilState === TribalCouncilState.FINAL) {
      return castJuryVote(interaction);
    }

    const result = Game.validateAction(interaction, {
      target: true,
      tribalCouncil: [TribalCouncilState.Voting],
      phaseError: "Unable to place vote. Tribal Council is not in voting state.",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "Unable to place vote. Target player not found.");
    }
    if (player.votes === 0) {
      return replyEphemeral(interaction, "Unable to place vote. You have no votes remaining.");
    }
    player.votes -= 1;
    Game.tribalCouncil?.castVote(targetPlayer);
    await interaction.reply({
      content: `You have cast a vote for <@${targetPlayer.id}>. You have ${player.votes} vote(s) remaining.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
