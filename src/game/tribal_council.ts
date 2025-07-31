import { Game, GameState, TribalCouncilState } from "./game";
import Player from "./player";
import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { cards } from "./cardlist.json";

enum TribalCouncilType {
  SINGLE,
  DOUBLE,
  FINAL,
}

class TribalCouncil {
  interaction: ChatInputCommandInteraction;
  tribalCouncilType: TribalCouncilType;
  votesArray: Player[];
  tiedPlayers: Player[];
  leader: Player | undefined;

  constructor(
    interaction: ChatInputCommandInteraction,
    tribalCouncilType: TribalCouncilType,
  ) {
    this.interaction = interaction;
    this.tribalCouncilType = tribalCouncilType;
    this.votesArray = [];
    this.tiedPlayers = [];
    this.leader =
      Game.tribalCouncilLeader || Game.getPlayerFromUserId(interaction.user.id);
  }

  async init() {
    for (const player of Game.players) {
      //ONE VOTE PER PLAYER (excluding extras)
      if (player.isAlive()) player.votes += 1;
    }
    await this.interaction.deferReply();
    await this.interaction.editReply({
      content: `<@${this.leader?.id}> has drawn the Tribal Council card! Tribal council will begin with <@${this.leader?.id}> as the leader unless otherwise changed. https://i.imgur.com/DG0IZxh.png https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExYWY2cjZ6MXVmbTM4cWthaHhjcXZkMGE1djRpamhoNncxcnZ5aXJ3OCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3ohs85atuPLr4K5rcQ/giphy.gif`,
    });
    await this.interaction.followUp({
      content: `Welcome to Tribal Council. Tonight, one of you will be voted out of the tribe. <@${this.leader?.id}> is your tribal council leader for tonight's vote. You have 8 minutes (30 seconds for testing) to discuss your vote before we get to the voting.`,
    });
    // wait for 30 seconds
    await new Promise((resolve) => setTimeout(resolve, 30 * 1000));
    Game.tribalCouncilState = TribalCouncilState.Voting;
    await this.interaction.followUp({
      content: "It is time to vote. You have 60 seconds to cast your vote.",
    });
    await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
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
          // check if final tribal should be started
          // if (Game.getAlivePlayers.length == 2) {
          //   // set new tribal leader and start final
          //   // TODO maybe make this a separate command?
          //   this.leader = player;
          // }
        }
        this.cleanup();
      }
    } else {
      // Handle tie case
      console.log("Tie");
      await this.interaction.followUp({
        content: `
          The vote was a tie between ${result.players?.map((player) => `<@${player.id}>`).join(", ")}!\n
          As the tribal council leader, <@${this.leader?.id}> must break the tie.\n
          <@${this.leader?.id}>, use "/break_tie @player" to select the player to eliminate.
        `,
      });
    }
  }

  async initFinal() {
    await this.interaction.followUp({
      content: `
        The final tribal council has begun! The leader is <@${this.leader?.id}>.\n
        Jury members, use "/final_vote @player" to cast your vote.
      `,
    });
    this.tribalCouncilType = TribalCouncilType.FINAL;
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
      this.tiedPlayers = playersWithMostVotes;
      await new Promise((resolve) => setTimeout(resolve, 1 * 1000));
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

  async breakTie(player: Player) {
    const totalLivesLost = Game.players.reduce(
      (total, player) => total + (2 - player.lives),
      0,
    );
    const eliminationNumber = totalLivesLost + 1;
    player.lives--;
    await this.interaction.followUp({
      content: `
        ${this.getOrdinal(eliminationNumber)} person voted out of Survivor,\n
        <@${player.id}>.\n
        They have ${player.lives} lives left.
      `,
    });
    if (!player.isAlive()) {
      await this.interaction.followUp({
        content: `<@${player.id}> has been ELIMINATED and their torch has been snuffed. https://tenor.com/bExpm.gif`,
      });
    }
    this.cleanup();
  }

  async cleanup() {
    // TODO check to start final tribal council
    Game.tribalCouncilState = TribalCouncilState.NotStarted;
    Game.tribalCouncil = null;
    for (const player of Game.players) {
      player.votes = 0;
    }
    return await this.interaction.followUp({
      content: `
        The tribal council has ended.
      `,
    });
  }
}

export { TribalCouncil, TribalCouncilType };
