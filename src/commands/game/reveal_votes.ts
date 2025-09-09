import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";

export default {
  data: new SlashCommandBuilder()
    .setName("reveal_votes")
    .setDescription("Reveal the jury votes for the winner. Only works if all jurors have voted."),
  async execute(interaction: ChatInputCommandInteraction) {
    const ftc = (Game as any).finalTribalCouncil;
    if (!ftc || !ftc.votingStarted) {
      return interaction.reply({
        content: "Final Tribal Council voting is not active.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const { jury, finalists, votes, leader } = ftc;
    if (votes.size < jury.length) {
      return interaction.reply({
        content: `Not all jurors have voted yet. (${votes.size}/${jury.length})`,
        flags: MessageFlags.Ephemeral,
      });
    }
    // Dramatic reveal: shuffle votes
  const voteEntries: [string, string][] = Array.from((votes as Map<string, string>).entries());
    for (let i = voteEntries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [voteEntries[i], voteEntries[j]] = [voteEntries[j], voteEntries[i]];
    }
    // Tally votes
    const tally: Record<string, number> = {};
    for (const finalist of finalists) {
      tally[finalist.id] = 0;
    }
    // Reveal votes one at a time
    for (const [juryId, finalistId] of voteEntries) {
      await interaction.followUp({
        content: `Vote: <@${juryId}> voted for <@${finalistId}>`,
      });
      tally[finalistId]++;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Announce totals
    let resultMsg = `\nFinal Vote Tally:\n`;
    for (const finalist of finalists) {
      resultMsg += `<@${finalist.id}>: ${tally[finalist.id]} vote(s)\n`;
    }
    // Determine winner or tie
  const finalistIds: string[] = finalists.map((f: any) => f.id);
  const maxVotes: number = Math.max(...Object.values(tally));
  const winners: string[] = finalistIds.filter((id: string) => tally[id] === maxVotes);
    if (winners.length === 1) {
      resultMsg += `\n🏆 <@${winners[0]}> is the winner of Survivor! Congratulations!`;
      await interaction.followUp({ content: resultMsg });
      Game.active = false;
      return;
    }
    // Tie: set up for break_tie
  resultMsg += `\nIt's a tie! <@${leader.id}> (Final Tribal Council Leader), please use /break_tie to select the winner from the tied finalists: ${winners.map((id: string) => `<@${id}>`).join(" and ")}.`;
    (Game as any).tribalCouncil = {
      tiedPlayers: finalists.filter((f: any) => winners.includes(f.id)),
      tribalCouncilType: 2, // Custom type for final tribal
      leader,
      breakTie: async (players: any[]) => {
        if (players.length !== 1) return await interaction.followUp({ content: "You must select exactly one winner." });
        await interaction.followUp({ content: `**<@${players[0].id}>** is the winner of Survivor!` });
        Game.active = false;
      }
    };
    await interaction.followUp({ content: resultMsg });
  },
};
