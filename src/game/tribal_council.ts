import { Game, GameState, TribalCouncilState } from "./game";
import Player from "./player";
import { ChatInputCommandInteraction, MessageFlags } from "discord.js";

class TribalCouncil {
  interaction: ChatInputCommandInteraction;
  isDouble: boolean;
  votesArray: Player[];
  tiedPlayers: Player[];
  leader: Player | undefined;

  constructor(interaction: ChatInputCommandInteraction, isDouble: boolean) {
    this.interaction = interaction;
    this.isDouble = isDouble;
    this.votesArray = [];
    this.tiedPlayers = [];
    this.leader =
      Game.tribalCouncilLeader || Game.getPlayerFromUserId(interaction.user.id);
  }

  async init() {
    for (const player of Game.players) {
      if (player.isAlive()) player.votes += player.lives;
    }
    await this.interaction.deferReply();
    await this.interaction.editReply({ content: "TRIBAL COUNCIL STARTED" });
    await this.interaction.followUp({
      content:
        "You have 8 minutes (30 seconds for testing lololol) to discuss.",
    });
    // wait for 30 seconds
    await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
    Game.tribalCouncilState = TribalCouncilState.Voting;
    await this.interaction.followUp({
      content: "Voting begins now, you have 30 seconds to vote.",
    });
    await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
    const result = await this.readVotes();
    if (!result.tie) {
      const player = result.player;
      if (player) {
        player.lives--;
        await this.interaction.followUp({
          content: `
            <@${player.id}> has been voted out, they have ${player.lives} lives left.
          `,
        });
        if (!player.isAlive()) {
          await this.interaction.followUp({
            content: `<@${player.id}> has been ELIMINATED and their torch has been snuffed. https://tenor.com/bExpm.gif`,
          });
        }
      } else {
      }
    }
  }

  castVote(player: Player) {
    this.votesArray.push(player);
  }

  async readVotes() {
    // Count votes for each player
    const voteMap = new Map<Player, number>();
    this.votesArray.forEach((player) => {
      voteMap.set(player, (voteMap.get(player) || 0) + 1);
    });

    // Calculate elimination number based on total lives lost
    const totalLivesLost = Game.players.reduce(
      (total, player) => total + (2 - player.lives),
      0,
    );
    const eliminationNumber = totalLivesLost + 1;

    // Determine who will be eliminated (if no tie)
    const maxVotes = Math.max(...voteMap.values());
    const playersWithMostVotes = Array.from(voteMap.entries())
      .filter(([_, v]) => v === maxVotes)
      .map(([player]) => player);

    // Create vote reading order - save one vote for the eliminated player for last
    let allVotes = [...this.votesArray];
    let finalVote: Player | null = null;

    if (playersWithMostVotes.length === 1) {
      // Find and remove one vote for the eliminated player to save for last
      const eliminatedPlayer = playersWithMostVotes[0];
      const eliminatedVoteIndex = allVotes.findIndex(
        (vote) => vote === eliminatedPlayer,
      );
      if (eliminatedVoteIndex !== -1) {
        finalVote = allVotes.splice(eliminatedVoteIndex, 1)[0];
      }
    }

    // Shuffle the remaining votes for suspense (Fisher-Yates shuffle)
    for (let i = allVotes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allVotes[i], allVotes[j]] = [allVotes[j], allVotes[i]];
    }

    // Keep track of running vote counts for dramatic effect
    const runningCounts = new Map<Player, number>();

    // Read votes one by one (excluding the final elimination vote)
    for (let i = 0; i < allVotes.length; i++) {
      const votedPlayer = allVotes[i];
      const currentCount = (runningCounts.get(votedPlayer) || 0) + 1;
      runningCounts.set(votedPlayer, currentCount);

      const countText =
        currentCount === 1
          ? "ONE VOTE"
          : `${this.numberToWords(currentCount).toUpperCase()} VOTES`;

      await this.interaction.followUp({
        content: `${countText}: <@${votedPlayer.id}>`,
      });

      // Add suspenseful delay between vote reads
      await new Promise((resolve) => setTimeout(resolve, 3 * 1000));
    }

    // Read the final elimination vote if there's no tie
    if (finalVote) {
      const currentCount = (runningCounts.get(finalVote) || 0) + 1;
      runningCounts.set(finalVote, currentCount);

      const countText =
        currentCount === 1
          ? "ONE VOTE"
          : `${this.numberToWords(currentCount).toUpperCase()} VOTES`;

      await this.interaction.followUp({
        content: `${countText}: <@${finalVote.id}>`,
      });

      // Add suspenseful delay before elimination announcement
      await new Promise((resolve) => setTimeout(resolve, 3 * 1000));
    }

    if (playersWithMostVotes.length === 1) {
      const eliminatedPlayer = playersWithMostVotes[0];

      // Elimination announcement
      await this.interaction.followUp({
        content: `${this.getOrdinal(eliminationNumber)} person voted out of Survivor with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"}...`,
      });

      // 5 second suspenseful delay
      await new Promise((resolve) => setTimeout(resolve, 5 * 1000));

      // Final dramatic reveal
      await this.interaction.followUp({
        content: `<@${eliminatedPlayer.id}>`,
      });

      return { tie: false, player: eliminatedPlayer };
    } else {
      await new Promise((resolve) => setTimeout(resolve, 2 * 1000));
      await this.interaction.followUp({
        content: `WE HAVE A TIE! ${playersWithMostVotes.map((p) => `<@${p.id}>`).join(" and ")} are tied with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"} each.`,
      });
      return { tie: true, players: playersWithMostVotes };
    }
  }

  private numberToWords(num: number): string {
    const words = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ];
    return words[num] || num.toString();
  }

  private getOrdinal(num: number): string {
    const suffix = ["th", "st", "nd", "rd"];
    const value = num % 100;
    return num + (suffix[(value - 20) % 10] || suffix[value] || suffix[0]);
  }
}

export default TribalCouncil;
