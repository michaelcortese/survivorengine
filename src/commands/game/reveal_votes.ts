import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("reveal_votes")
    .setDescription("Read the jury's votes (happens on its own once all jurors vote; the leader can force it)"),
  async execute(interaction: ChatInputCommandInteraction) {
    const council = Game.finalTribalCouncil;
    if (!council || !council.votingOpen) {
      return replyEphemeral(interaction, "Final Tribal Council voting is not active.");
    }
    if (!council.allVoted && council.leader.id !== interaction.user.id) {
      return replyEphemeral(
        interaction,
        `Not all jurors have voted yet (${council.votes.size}/${council.jury.length}). Only the Final Tribal Council Leader (<@${council.leader.id}>) can read the votes early.`,
      );
    }
    await interaction.reply({
      content: council.allVoted
        ? "All the votes are in."
        : `<@${interaction.user.id}> is reading the votes early (${council.votes.size}/${council.jury.length} cast).`,
    });
    await council.reveal();
  },
};
