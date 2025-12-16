import { Game, TribalCouncilState } from "./game";
import Player from "./player";
import { ChatInputCommandInteraction } from "discord.js";
// import { cards } from "./cardlist.json";

enum TribalCouncilType {
  SINGLE,
  DOUBLE,
  FINAL,
}

let singleImage = "https://imgur.com/MPRxVdV";
let doubleImage = "https://i.imgur.com/jdv8TpI.png";

class TribalCouncil {
  interaction: ChatInputCommandInteraction;
  tribalCouncilType: TribalCouncilType;
  votesArray: Player[];
  tiedPlayers: Player[];
  leader: Player | undefined;
  idolProtections: { protectedPlayer: Player; playedBy: Player }[];
  idolNullifications: {
    nullifiedBy: Player;
    targetPlayer: Player;
    originalIdolPlayer: Player;
    originalProtectedPlayer: Player;
  }[];

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
    this.idolProtections = [];
    this.idolNullifications = [];
  }

  async init() {
    for (const player of Game.players) {
      //ONE VOTE PER PLAYER (excluding extras)
      if (player.isAlive()) player.votes += 1;
    }
    await this.interaction.deferReply();
    await this.interaction.editReply({
      content: `<@${this.leader?.id}> has drawn the Tribal Council card! Tribal council will begin with <@${this.leader?.id}> as the leader unless otherwise changed. ${this.tribalCouncilType === TribalCouncilType.SINGLE ? singleImage : doubleImage}`,
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

    // Wait for potential idol plays before reading votes
    await this.waitForIdol();

    const result = await this.readVotes();
    if (!result.tie) {
      if (result.players && result.players.length > 0) {
        // Handle elimination(s)
        for (const player of result.players) {
          player.lives--;
          await this.interaction.followUp({
            content: `<@${player.id}> has been voted out, they have ${player.lives} lives left.`,
          });
          if (!player.isAlive()) {
            await this.interaction.followUp({
              content: `<@${player.id}> has been ELIMINATED and their torch has been snuffed. https://tenor.com/bExpm.gif`,
            });
            // Check if only 2 players remain alive
            const alivePlayers = Game.getAlivePlayers();
            if (alivePlayers.length === 2) {
              Game.finalTribalLeader = player;
              await this.interaction.followUp({
                content: `STOP PLAYING AND RUN THIS! <@${player.id}> is the Final Tribal Council Leader. Please run /final_tribal_council to begin the final vote.`,
              });
            }
          }
        }
        this.cleanup();
      }
      // Note: if players is empty (all votes cancelled), cleanup was already called in readVotes
    } else {
      // Handle tie case - store tied players for leader decision
      this.tiedPlayers = result.players || [];
      let tieMessage = "";

      if (this.tribalCouncilType === TribalCouncilType.SINGLE) {
        tieMessage =
          `The vote was a tie between ${this.tiedPlayers.map((p) => `<@${p.id}>`).join(", ")}!\n` +
          `As the tribal council leader, <@${this.leader?.id}> must break the tie.\n` +
          `<@${this.leader?.id}>, use "/break_tie @player" to select the player to eliminate.`;
      } else if (this.tribalCouncilType === TribalCouncilType.DOUBLE) {
        if (this.tiedPlayers.length >= 3) {
          tieMessage =
            `The vote was a tie between ${this.tiedPlayers.map((p) => `<@${p.id}>`).join(", ")}!\n` +
            `As the tribal council leader, <@${this.leader?.id}> must break the tie.\n` +
            `<@${this.leader?.id}>, use "/break_tie @player @player2" to select the 2 players to eliminate.`;
        } else {
          // This shouldn't happen in double elim readVotes, but handle gracefully
          tieMessage = `Unexpected tie scenario in double elimination. Leader must decide.`;
        }
      }

      await this.interaction.followUp({ content: tieMessage });
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
    // First, handle idol protection by filtering out votes
    let effectiveVotes = [...this.votesArray];

    // Get active idol protections (those not nullified)
    const activeProtections = this.idolProtections.filter((protection) => {
      return !this.idolNullifications.some(
        (nullification) =>
          nullification.originalIdolPlayer === protection.playedBy &&
          nullification.originalProtectedPlayer === protection.protectedPlayer,
      );
    });

    // Remove votes for all actively protected players
    for (const protection of activeProtections) {
      const protectedPlayer = protection.protectedPlayer;
      const removedVotes = effectiveVotes.filter(
        (vote) => vote === protectedPlayer,
      );
      effectiveVotes = effectiveVotes.filter(
        (vote) => vote !== protectedPlayer,
      );

      if (removedVotes.length > 0) {
        await this.interaction.followUp({
          content: `${removedVotes.length} vote${removedVotes.length === 1 ? "" : "s"} for <@${protectedPlayer.id}> ${removedVotes.length === 1 ? "does" : "do"} not count due to the immunity idol played by <@${protection.playedBy.id}>.`,
        });
        await new Promise((resolve) => setTimeout(resolve, 2 * 1000));
      }
    }

    // Announce any nullified idols
    for (const nullification of this.idolNullifications) {
      await this.interaction.followUp({
        content: `<@${nullification.originalIdolPlayer.id}>'s immunity idol was nullified by <@${nullification.nullifiedBy.id}>. Votes for <@${nullification.originalProtectedPlayer.id}> will count.`,
      });
      await new Promise((resolve) => setTimeout(resolve, 2 * 1000));
    }

    // Count votes for each player using effective votes
    const voteMap = new Map<Player, number>();
    effectiveVotes.forEach((player) => {
      voteMap.set(player, (voteMap.get(player) || 0) + 1);
    });

    // Handle case where all votes were cancelled by idols
    if (effectiveVotes.length === 0) {
      await this.interaction.followUp({
        content:
          "🛡️ **UNPRECEDENTED!** All votes have been cancelled by immunity idols! This counts as a tie between all players!",
      });
      await new Promise((resolve) => setTimeout(resolve, 3 * 1000));

      // Determine which players are immune (protected by active, non-nullified idols)
      const activeProtections = this.idolProtections.filter((protection) => {
        return !this.idolNullifications.some(
          (nullification) =>
            nullification.originalIdolPlayer === protection.playedBy &&
            nullification.originalProtectedPlayer ===
            protection.protectedPlayer,
        );
      });
      const immunePlayers = activeProtections.map(
        (p) => p.protectedPlayer,
      );
      const allAlivePlayers = Game.getAlivePlayers();
      const nonImmuneAlivePlayers = allAlivePlayers.filter(
        (p) => !immunePlayers.includes(p),
      );

      // If there is at least one non-immune player, only they are eligible for the tie.
      // If EVERY remaining player is immune, the immunity exclusion does not apply.
      const eligiblePlayers =
        nonImmuneAlivePlayers.length > 0
          ? nonImmuneAlivePlayers
          : allAlivePlayers;

      this.tiedPlayers = eligiblePlayers;

      let tieMessage = "";
      const basePrefix =
        nonImmuneAlivePlayers.length > 0
          ? `All votes targeted immune players. Only non-immune players are eligible: ${eligiblePlayers
            .map((p) => `<@${p.id}>`)
            .join(", ")}\n`
          : `All players are immune this round; immunity exclusion is lifted. Eligible players: ${eligiblePlayers
            .map((p) => `<@${p.id}>`)
            .join(", ")}\n`;

      if (this.tribalCouncilType === TribalCouncilType.SINGLE) {
        tieMessage =
          basePrefix +
          `As the tribal council leader, <@${this.leader?.id}> must break the tie.\n` +
          `<@${this.leader?.id}>, use "/break_tie player1:@player" to select the player to eliminate.`;
      } else if (this.tribalCouncilType === TribalCouncilType.DOUBLE) {
        // Check if eliminating 2 would leave only 1 player
        if (eligiblePlayers.length <= 3) {
          tieMessage =
            basePrefix +
            `Eliminating 2 players would end the game. As the tribal council leader, <@${this.leader?.id}> must choose 1 player to eliminate.\n` +
            `<@${this.leader?.id}>, use "/break_tie player1:@player" to select the player to eliminate.`;
        } else {
          tieMessage =
            basePrefix +
            `As the tribal council leader, <@${this.leader?.id}> must break the tie.\n` +
            `<@${this.leader?.id}>, use "/break_tie player1:@player player2:@player" to select the 2 players to eliminate.`;
        }
      }

      await this.interaction.followUp({ content: tieMessage });
      return { tie: true, players: eligiblePlayers };
    }

    // Get sorted vote counts (highest to lowest)
    const sortedVotes = Array.from(voteMap.entries()).sort(
      ([, a], [, b]) => b - a,
    );

    // Perform dramatic vote reading
    await this.performVoteReading(effectiveVotes, voteMap);

    // Determine elimination logic based on tribal council type
    if (this.tribalCouncilType === TribalCouncilType.SINGLE) {
      return this.handleSingleElimination(sortedVotes);
    } else if (this.tribalCouncilType === TribalCouncilType.DOUBLE) {
      return this.handleDoubleElimination(sortedVotes);
    }

    // Fallback (shouldn't reach here)
    return { tie: false, players: [] };
  }

  private async performVoteReading(
    effectiveVotes: Player[],
    voteMap: Map<Player, number>,
  ) {
    // Create vote reading order - shuffle for suspense
    let allVotes = [...effectiveVotes];

    // Shuffle the votes for suspense (Fisher-Yates shuffle)
    for (let i = allVotes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allVotes[i], allVotes[j]] = [allVotes[j], allVotes[i]];
    }

    // Keep track of running vote counts for dramatic effect
    const runningCounts = new Map<Player, number>();

    // Read votes one by one
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
  }

  private async handleSingleElimination(sortedVotes: [Player, number][]) {
    if (sortedVotes.length === 0) return { tie: false, players: [] };

    const maxVotes = sortedVotes[0][1];
    const playersWithMostVotes = sortedVotes
      .filter(([, votes]) => votes === maxVotes)
      .map(([player]) => player);

    const totalLivesLost = Game.players.reduce(
      (total, player) => total + (2 - player.lives),
      0,
    );
    const eliminationNumber = totalLivesLost + 1;

    if (playersWithMostVotes.length === 1) {
      const eliminatedPlayer = playersWithMostVotes[0];

      await this.interaction.followUp({
        content: `${this.getOrdinal(eliminationNumber)} person voted out of Survivor with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"}...`,
      });

      await new Promise((resolve) => setTimeout(resolve, 5 * 1000));

      await this.interaction.followUp({
        content: `<@${eliminatedPlayer.id}>`,
      });

      return { tie: false, players: [eliminatedPlayer] };
    } else {
      await this.interaction.followUp({
        content: `WE HAVE A TIE! ${playersWithMostVotes.map((p) => `<@${p.id}>`).join(" and ")} are tied with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"} each.`,
      });
      return { tie: true, players: playersWithMostVotes };
    }
  }

  private async handleDoubleElimination(sortedVotes: [Player, number][]) {
    if (sortedVotes.length === 0) return { tie: false, players: [] };

    const maxVotes = sortedVotes[0][1];
    const secondMaxVotes = sortedVotes.length > 1 ? sortedVotes[1][1] : 0;

    const playersWithMostVotes = sortedVotes
      .filter(([, votes]) => votes === maxVotes)
      .map(([player]) => player);

    const playersWithSecondMostVotes = sortedVotes
      .filter(([, votes]) => votes === secondMaxVotes && votes < maxVotes)
      .map(([player]) => player);

    const totalLivesLost = Game.players.reduce(
      (total, player) => total + (2 - player.lives),
      0,
    );
    const eliminationNumber = totalLivesLost + 1;

    // Check if eliminating 2 players would leave only 1 player (game over scenario)
    const aliveCount = Game.getAlivePlayers().length;
    if (aliveCount <= 3) {
      // Special case: prevent ending with 1 player
      if (playersWithMostVotes.length >= 2) {
        await this.interaction.followUp({
          content: `Multiple players are tied for elimination, but eliminating 2 would end the game. The tribal council leader must choose 1 player to eliminate.`,
        });
        return { tie: true, players: playersWithMostVotes };
      }
    }

    if (
      playersWithMostVotes.length === 1 &&
      playersWithSecondMostVotes.length === 1
    ) {
      // Clear case: 1st place and 2nd place, both eliminated
      const eliminated = [
        playersWithMostVotes[0],
        playersWithSecondMostVotes[0],
      ];

      await this.interaction.followUp({
        content: `${this.getOrdinal(eliminationNumber)} and ${this.getOrdinal(eliminationNumber + 1)} people voted out of Survivor...`,
      });

      await new Promise((resolve) => setTimeout(resolve, 5 * 1000));

      await this.interaction.followUp({
        content: `<@${eliminated[0].id}> with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"} and <@${eliminated[1].id}> with ${this.numberToWords(secondMaxVotes).toUpperCase()} ${secondMaxVotes === 1 ? "VOTE" : "VOTES"}`,
      });

      return { tie: false, players: eliminated };
    } else if (
      playersWithMostVotes.length === 2 &&
      playersWithSecondMostVotes.length === 0
    ) {
      // Two players tied for first, both eliminated
      const eliminated = playersWithMostVotes;

      await this.interaction.followUp({
        content: `${this.getOrdinal(eliminationNumber)} and ${this.getOrdinal(eliminationNumber + 1)} people voted out of Survivor, tied with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"} each...`,
      });

      await new Promise((resolve) => setTimeout(resolve, 5 * 1000));

      await this.interaction.followUp({
        content: `<@${eliminated[0].id}> and <@${eliminated[1].id}>`,
      });

      return { tie: false, players: eliminated };
    } else if (
      playersWithMostVotes.length === 1 &&
      playersWithSecondMostVotes.length >= 2
    ) {
      // 1 clear winner, multiple tied for second - eliminate first, then leader decides second
      const firstEliminated = playersWithMostVotes[0];

      await this.interaction.followUp({
        content: `${this.getOrdinal(eliminationNumber)} person voted out of Survivor with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"}...`,
      });

      await new Promise((resolve) => setTimeout(resolve, 3 * 1000));

      await this.interaction.followUp({
        content: `<@${firstEliminated.id}>`,
      });

      // Eliminate the first player immediately
      firstEliminated.lives--;
      await this.interaction.followUp({
        content: `<@${firstEliminated.id}> has been voted out, they have ${firstEliminated.lives} lives left.`,
      });

      if (!firstEliminated.isAlive()) {
        await this.interaction.followUp({
          content: `<@${firstEliminated.id}> has been ELIMINATED and their torch has been snuffed. https://tenor.com/bExpm.gif`,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 2 * 1000));

      await this.interaction.followUp({
        content: `Multiple players are tied for second place with ${this.numberToWords(secondMaxVotes).toUpperCase()} ${secondMaxVotes === 1 ? "VOTE" : "VOTES"} each. The tribal council leader must choose who else to eliminate.`,
      });

      // Set up tie for second elimination
      this.tiedPlayers = playersWithSecondMostVotes;
      return {
        tie: true,
        players: playersWithSecondMostVotes,
      };
    } else {
      // 3+ players tied for most votes - leader chooses 2
      await this.interaction.followUp({
        content: `WE HAVE A TIE! ${playersWithMostVotes.map((p) => `<@${p.id}>`).join(", ")} are tied with ${this.numberToWords(maxVotes).toUpperCase()} ${maxVotes === 1 ? "VOTE" : "VOTES"} each.`,
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

  async breakTie(players: Player[]) {
    const totalLivesLost = Game.players.reduce(
      (total, player) => total + (2 - player.lives),
      0,
    );

    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      const eliminationNumber = totalLivesLost + i + 1;
      player.lives--;

      await this.interaction.followUp({
        content: `${this.getOrdinal(eliminationNumber)} person voted out of Survivor: <@${player.id}>. They have ${player.lives} lives left.`,
      });

      if (!player.isAlive()) {
        await this.interaction.followUp({
          content: `<@${player.id}> has been ELIMINATED and their torch has been snuffed. https://tenor.com/bExpm.gif`,
        });
      }
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

  async waitForIdol() {
    // Set up idol interruption window
    Game.tribalCouncilState = TribalCouncilState.Immunity;

    await this.interaction.followUp({
      content:
        "If anyone has an Immunity Idol and would like to play it, now would be the time to do so. You have 60 seconds.",
    });

    // Set up interruption for idol plays
    Game.interruption.active = true;
    Game.interruption.sender = null;
    Game.interruption.target = null;
    Game.interruption.stopped = false;

    // Wait 60 seconds for idol plays
    const idolPromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        Game.interruption.active = false;
        resolve(this.idolProtections.length > 0); // Check if any idols were played
      }, 60 * 1000);

      // Store timeout reference so commands can access it
      (Game as any).idolTimeout = timeout;
    });

    const idolPlayed = await idolPromise;

    if (idolPlayed) {
      // An idol was played, now wait for potential nullifier
      Game.tribalCouncilState = TribalCouncilState.Nullify;

      await this.interaction.followUp({
        content:
          "If anyone has an Idol Nullifier and would like to play it, now would be the time to do so. You have 30 seconds.",
      });

      // Set up interruption for nullifier plays
      Game.interruption.active = true;
      Game.interruption.sender = null;
      Game.interruption.target = null;
      Game.interruption.stopped = false;

      // Wait 30 seconds for nullifier plays
      const nullifierPromise = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          Game.interruption.active = false;
          resolve(this.idolNullifications.length > 0); // Check if any nullifiers were played
        }, 30 * 1000);

        // Store timeout reference so commands can access it
        (Game as any).nullifierTimeout = timeout;
      });

      await nullifierPromise;
    }

    // Reset interruption state and move to reading votes
    Game.interruption.active = false;
    Game.interruption.sender = null;
    Game.interruption.target = null;
    Game.interruption.stopped = false;
    Game.tribalCouncilState = TribalCouncilState.Reading;
  }
}

export { TribalCouncil, TribalCouncilType };
