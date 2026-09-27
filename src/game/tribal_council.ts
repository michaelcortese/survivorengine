import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "./game";
import type Player from "./player";
import { GameConfig, formatDuration } from "./config";
import { buildBoardMessage } from "./board";
import { startFinalTribalCouncil } from "./final_tribal_council";
import { Announcer, createAnnouncer, mention, sendDM } from "../util/discord";

enum TribalCouncilType {
  SINGLE,
  DOUBLE,
}

const singleImage = "https://imgur.com/MPRxVdV";
const doubleImage = "https://i.imgur.com/jdv8TpI.png";
const snuffedGif = "https://tenor.com/bExpm.gif";

interface IdolProtection {
  protectedPlayer: Player;
  playedBy: Player;
}

interface IdolNullification {
  nullifiedBy: Player;
  targetPlayer: Player;
  originalIdolPlayer: Player;
  originalProtectedPlayer: Player;
}

/** What the vote decided. */
type VoteResult =
  | { kind: "out"; players: Player[] }
  | {
      kind: "tie";
      tied: Player[];
      /** How many of the tied players the leader must vote out. */
      picks: number;
      /** Already voted out before the tie (double elimination, tie for 2nd). */
      alreadyOut?: Player[];
      intro?: string;
    };

interface PendingTie {
  tied: Player[];
  picks: number;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class TribalCouncil {
  interaction: ChatInputCommandInteraction;
  tribalCouncilType: TribalCouncilType;
  /** Which Tribal Council of the game this is (1-based). */
  readonly number: number;
  readonly gameId: number;
  /** The player who drew the card. Play continues after them. */
  readonly drawer: Player | undefined;
  leader: Player | undefined;
  /** Set by I'm the Leader Now: the new leader takes the next turn. */
  leaderChangedByCard = false;
  votesArray: Player[] = [];
  tiedPlayers: Player[] = [];
  pendingTie: PendingTie | null = null;
  idolProtections: IdolProtection[] = [];
  idolNullifications: IdolNullification[] = [];
  private readonly drawnType: TribalCouncilType;
  private readonly say: Announcer;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Players eliminated at this council; their hands are settled at the end. */
  private readonly eliminated: Player[] = [];
  private finished = false;
  private disposed = false;

  constructor(
    interaction: ChatInputCommandInteraction,
    tribalCouncilType: TribalCouncilType,
    drawer?: Player,
  ) {
    this.interaction = interaction;
    this.gameId = Game.id;
    this.number = ++Game.tribalCouncilCount;
    this.drawer = drawer ?? Game.getPlayerFromUserId(interaction.user.id);
    this.leader = this.drawer;
    this.drawnType = tribalCouncilType;
    // Voting out two when only three remain could leave a single survivor.
    this.tribalCouncilType =
      tribalCouncilType === TribalCouncilType.DOUBLE &&
      Game.getAlivePlayers().length <= 3
        ? TribalCouncilType.SINGLE
        : tribalCouncilType;
    this.say = createAnnouncer(interaction);
  }

  async init() {
    try {
      await this.run();
    } catch (error) {
      console.error(`Tribal Council #${this.number} failed:`, error);
      if (this.isStale()) return;
      this.pendingTie = null;
      await this.say(
        "Something went wrong at Tribal Council, so it has been called off. Play continues.",
      );
      await this.finish(false);
    }
  }

  private async run() {
    for (const player of Game.getAlivePlayers()) {
      // ONE VOTE PER PLAYER (excluding extras)
      player.votes += 1;
    }
    Game.tribalCouncilState = TribalCouncilState.Discussion;
    const isDouble = this.drawnType === TribalCouncilType.DOUBLE;
    await this.interaction.deferReply();
    await this.interaction.editReply({
      content: `<@${this.leader?.id}> has drawn the ${isDouble ? "**Double** " : ""}Tribal Council card! Tribal council will begin with <@${this.leader?.id}> as the leader unless otherwise changed. ${isDouble ? doubleImage : singleImage}`,
    });
    if (this.tribalCouncilType !== this.drawnType) {
      await this.say(
        "Only three players remain, so this double Tribal Council will vote out just one castaway.",
      );
    }

    await this.discuss();
    if (this.isStale()) return;

    Game.tribalCouncilState = TribalCouncilState.Voting;
    await this.say(
      `It is time to vote. You have ${formatDuration(GameConfig.timings.votingMs)} to cast your vote with /cast_vote.`,
    );
    await this.sleep(GameConfig.timings.votingMs);
    if (this.isStale()) return;

    // Wait for potential idol plays before reading votes
    await this.waitForIdol();
    if (this.isStale()) return;

    const result = await this.readVotes();
    if (this.isStale()) return;
    await this.resolve(result);
  }

  /** Discussion phase. The leader can press a button to start the vote early. */
  private async discuss() {
    const durationMs = Game.discussionMs;
    const tonight =
      this.tribalCouncilType === TribalCouncilType.DOUBLE ? "two of you" : "one of you";
    const intro = `Welcome to Tribal Council. Tonight, ${tonight} will be voted out of the tribe. <@${this.leader?.id}> is your tribal council leader for tonight's vote. You have ${formatDuration(durationMs)} to discuss your vote before we get to the voting.`;
    if (durationMs <= 0) {
      await this.say(intro);
      return;
    }

    const button = new ButtonBuilder()
      .setCustomId(`tribal:${this.gameId}:${this.number}:start_vote`)
      .setLabel("Start the vote")
      .setEmoji("🗳️")
      .setStyle(ButtonStyle.Primary);
    const message = await this.say({
      content: `${intro} The leader can start the vote early.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
    });
    if (!message) {
      await this.sleep(durationMs);
      return;
    }

    await new Promise<void>((resolve) => {
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: durationMs,
      });
      collector.on("collect", async (click) => {
        if (click.user.id !== this.leader?.id) {
          await click
            .reply({
              content: "Only the Tribal Council leader can start the vote.",
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => undefined);
          return;
        }
        collector.stop("leader");
        await click.update({ components: [] }).catch(() => undefined);
      });
      collector.on("end", (_collected, reason) => {
        if (reason !== "leader") {
          message.edit({ components: [] }).catch(() => undefined);
        }
        resolve();
      });
    });
  }

  castVote(player: Player) {
    this.votesArray.push(player);
  }

  private activeProtections(): IdolProtection[] {
    return this.idolProtections.filter(
      (protection) =>
        !this.idolNullifications.some(
          (nullification) =>
            nullification.originalIdolPlayer === protection.playedBy &&
            nullification.originalProtectedPlayer === protection.protectedPlayer,
        ),
    );
  }

  async readVotes(): Promise<VoteResult> {
    // First, handle idol protection by filtering out votes
    let effectiveVotes = [...this.votesArray];
    const activeProtections = this.activeProtections();

    // Remove votes for all actively protected players
    for (const protection of activeProtections) {
      const protectedPlayer = protection.protectedPlayer;
      const removedVotes = effectiveVotes.filter((vote) => vote === protectedPlayer);
      effectiveVotes = effectiveVotes.filter((vote) => vote !== protectedPlayer);

      if (removedVotes.length > 0) {
        await this.say(
          `${removedVotes.length} vote${removedVotes.length === 1 ? "" : "s"} for <@${protectedPlayer.id}> ${removedVotes.length === 1 ? "does" : "do"} not count due to the immunity idol played by <@${protection.playedBy.id}>.`,
        );
        await this.sleep(GameConfig.timings.voteReadMs);
      }
    }

    // Announce any nullified idols
    for (const nullification of this.idolNullifications) {
      await this.say(
        `<@${nullification.originalIdolPlayer.id}>'s immunity idol was nullified by <@${nullification.nullifiedBy.id}>. Votes for <@${nullification.originalProtectedPlayer.id}> will count.`,
      );
      await this.sleep(GameConfig.timings.voteReadMs);
    }

    const immunePlayers = new Set(activeProtections.map((p) => p.protectedPlayer));
    const picks = this.tribalCouncilType === TribalCouncilType.DOUBLE ? 2 : 1;

    // No votes left: everyone eligible is tied
    if (effectiveVotes.length === 0) {
      await this.say(
        this.votesArray.length === 0
          ? "🗳️ **Nobody voted!** With no votes cast, this counts as a tie between all players!"
          : "🛡️ **UNPRECEDENTED!** All votes have been cancelled by immunity idols! This counts as a tie between all players!",
      );
      await this.sleep(GameConfig.timings.voteReadMs);

      const allAlivePlayers = Game.getAlivePlayers();
      const nonImmuneAlivePlayers = allAlivePlayers.filter((p) => !immunePlayers.has(p));
      // If there is at least one non-immune player, only they are eligible for the tie.
      // If EVERY remaining player is immune, the immunity exclusion does not apply.
      const eligiblePlayers =
        nonImmuneAlivePlayers.length > 0 ? nonImmuneAlivePlayers : allAlivePlayers;
      const list = eligiblePlayers.map(mention).join(", ");
      const intro =
        immunePlayers.size === 0
          ? `Eligible players: ${list}`
          : nonImmuneAlivePlayers.length > 0
            ? `Immune players are safe. Only non-immune players are eligible: ${list}`
            : `All players are immune this round; immunity exclusion is lifted. Eligible players: ${list}`;

      if (eligiblePlayers.length <= picks) {
        await this.say(`${intro}\nThat decides it.`);
        return { kind: "out", players: eligiblePlayers };
      }
      return { kind: "tie", tied: eligiblePlayers, picks, intro };
    }

    // Count votes for each player using effective votes
    const voteMap = new Map<Player, number>();
    effectiveVotes.forEach((player) => {
      voteMap.set(player, (voteMap.get(player) || 0) + 1);
    });

    // Perform dramatic vote reading
    await this.performVoteReading(effectiveVotes);

    // Get sorted vote counts (highest to lowest)
    const sortedVotes = Array.from(voteMap.entries()).sort(([, a], [, b]) => b - a);
    return this.tribalCouncilType === TribalCouncilType.DOUBLE
      ? this.handleDoubleElimination(sortedVotes, immunePlayers)
      : this.handleSingleElimination(sortedVotes);
  }

  private async performVoteReading(effectiveVotes: Player[]) {
    // Shuffle the votes for suspense
    const allVotes = shuffled(effectiveVotes);

    // Keep track of running vote counts for dramatic effect
    const runningCounts = new Map<Player, number>();

    // Read votes one by one
    for (const votedPlayer of allVotes) {
      const currentCount = (runningCounts.get(votedPlayer) || 0) + 1;
      runningCounts.set(votedPlayer, currentCount);

      const countText =
        currentCount === 1
          ? "ONE VOTE"
          : `${this.numberToWords(currentCount).toUpperCase()} VOTES`;

      await this.say(`${countText}: <@${votedPlayer.id}>`);

      // Add suspenseful delay between vote reads
      await this.sleep(GameConfig.timings.voteReadMs);
    }
  }

  private votesText(count: number): string {
    return `${this.numberToWords(count).toUpperCase()} ${count === 1 ? "VOTE" : "VOTES"}`;
  }

  private async handleSingleElimination(
    sortedVotes: [Player, number][],
  ): Promise<VoteResult> {
    const maxVotes = sortedVotes[0][1];
    const playersWithMostVotes = sortedVotes
      .filter(([, votes]) => votes === maxVotes)
      .map(([player]) => player);
    const eliminationNumber = Game.totalVoteOuts() + 1;

    if (playersWithMostVotes.length === 1) {
      const eliminatedPlayer = playersWithMostVotes[0];
      await this.say(
        `${this.getOrdinal(eliminationNumber)} person voted out of Survivor with ${this.votesText(maxVotes)}...`,
      );
      await this.sleep(GameConfig.timings.suspenseMs);
      await this.say(`<@${eliminatedPlayer.id}>`);
      return { kind: "out", players: [eliminatedPlayer] };
    }

    await this.say(
      `WE HAVE A TIE! ${playersWithMostVotes.map(mention).join(" and ")} are tied with ${this.votesText(maxVotes)} each.`,
    );
    return { kind: "tie", tied: playersWithMostVotes, picks: 1 };
  }

  private async handleDoubleElimination(
    sortedVotes: [Player, number][],
    immunePlayers: Set<Player>,
  ): Promise<VoteResult> {
    // Everyone who can still go home, including players nobody voted for
    // (they are tied at zero if second place comes down to them).
    const counts = new Map(sortedVotes);
    const ranked: [Player, number][] = Game.getAlivePlayers()
      .filter((player) => !immunePlayers.has(player))
      .map((player): [Player, number] => [player, counts.get(player) ?? 0])
      .sort(([, a], [, b]) => b - a);

    const maxVotes = ranked[0][1];
    const playersWithMostVotes = ranked
      .filter(([, votes]) => votes === maxVotes)
      .map(([player]) => player);
    const eliminationNumber = Game.totalVoteOuts() + 1;

    if (playersWithMostVotes.length >= 3) {
      // 3+ players tied for most votes - leader chooses 2
      await this.say(
        `WE HAVE A TIE! ${playersWithMostVotes.map(mention).join(", ")} are tied with ${this.votesText(maxVotes)} each.`,
      );
      return { kind: "tie", tied: playersWithMostVotes, picks: 2 };
    }

    if (playersWithMostVotes.length === 2) {
      // Two players tied for first, both voted out
      const eliminated = playersWithMostVotes;
      await this.say(
        `${this.getOrdinal(eliminationNumber)} and ${this.getOrdinal(eliminationNumber + 1)} people voted out of Survivor, tied with ${this.votesText(maxVotes)} each...`,
      );
      await this.sleep(GameConfig.timings.suspenseMs);
      await this.say(`<@${eliminated[0].id}> and <@${eliminated[1].id}>`);
      return { kind: "out", players: eliminated };
    }

    const first = playersWithMostVotes[0];
    const rest = ranked.filter(([player]) => player !== first);
    if (rest.length === 0) {
      // Nobody else can go home (everyone else is immune)
      await this.say(
        `${this.getOrdinal(eliminationNumber)} person voted out of Survivor with ${this.votesText(maxVotes)}...`,
      );
      await this.sleep(GameConfig.timings.suspenseMs);
      await this.say(`<@${first.id}>`);
      return { kind: "out", players: [first] };
    }

    const secondMaxVotes = rest[0][1];
    const playersWithSecondMostVotes = rest
      .filter(([, votes]) => votes === secondMaxVotes)
      .map(([player]) => player);

    if (playersWithSecondMostVotes.length === 1) {
      // Clear case: 1st place and 2nd place, both voted out
      const second = playersWithSecondMostVotes[0];
      await this.say(
        `${this.getOrdinal(eliminationNumber)} and ${this.getOrdinal(eliminationNumber + 1)} people voted out of Survivor...`,
      );
      await this.sleep(GameConfig.timings.suspenseMs);
      await this.say(
        `<@${first.id}> with ${this.votesText(maxVotes)} and <@${second.id}> with ${this.votesText(secondMaxVotes)}`,
      );
      return { kind: "out", players: [first, second] };
    }

    // 1 clear first place, several tied for second: first goes now, leader picks the second
    await this.say(
      `${this.getOrdinal(eliminationNumber)} person voted out of Survivor with ${this.votesText(maxVotes)}...`,
    );
    await this.sleep(GameConfig.timings.suspenseMs);
    await this.say(`<@${first.id}>`);
    return {
      kind: "tie",
      tied: playersWithSecondMostVotes,
      picks: 1,
      alreadyOut: [first],
      intro: `Multiple players are tied for second place with ${this.votesText(secondMaxVotes)} each: ${playersWithSecondMostVotes.map(mention).join(", ")}. The tribal council leader must choose who else to vote out.`,
    };
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

  private async resolve(result: VoteResult) {
    if (result.kind === "out") {
      await this.voteOut(result.players);
      await this.finish();
      return;
    }

    if (result.alreadyOut?.length) {
      await this.voteOut(result.alreadyOut);
      if (this.isStale()) return;
      if (Game.getAlivePlayers().length <= 2) {
        await this.finish();
        return;
      }
    }

    const tied = result.tied.filter((player) => player.isAlive());
    if (tied.length <= result.picks) {
      await this.voteOut(tied);
      await this.finish();
      return;
    }
    await this.setupTie(tied, result.picks, result.intro);
  }

  private async setupTie(tied: Player[], picks: number, intro?: string) {
    this.tiedPlayers = tied;
    this.pendingTie = { tied, picks };
    const usage =
      picks === 2
        ? `"/break_tie player1:@player player2:@player" to select the 2 players to vote out`
        : `"/break_tie player1:@player" to select the player to vote out`;
    await this.say(
      `${intro ?? `The vote was a tie between ${tied.map(mention).join(", ")}!`}\n` +
        `As the tribal council leader, <@${this.leader?.id}> must break the tie.\n` +
        `<@${this.leader?.id}>, use ${usage}. If there's no decision within ${formatDuration(GameConfig.timings.tieBreakMs)}, the tie will be settled by drawing rocks.`,
    );
    this.schedule(() => void this.drawRocks(), GameConfig.timings.tieBreakMs);
  }

  /**
   * Claims the pending tie so only one decision (the leader's or the rocks')
   * can settle it. Returns null if it was already settled.
   */
  takeTie(): PendingTie | null {
    const tie = this.pendingTie;
    if (!tie || this.finished) return null;
    this.pendingTie = null;
    this.clearTimers();
    return tie;
  }

  /** The leader took too long: the tied players draw rocks (a random pick). */
  private async drawRocks() {
    if (this.isStale()) return;
    const tie = this.takeTie();
    if (!tie) return;
    const losers = shuffled(tie.tied).slice(0, tie.picks);
    await this.say(
      `⏳ <@${this.leader?.id}> didn't break the tie in time, so it's time to draw rocks... ${losers.map(mention).join(" and ")} drew the purple rock${losers.length === 1 ? "" : "s"}.`,
    );
    await this.breakTie(losers);
  }

  /**
   * Votes out the players the leader picked (or who drew the purple rock).
   * Claim the tie with takeTie() first.
   */
  async breakTie(players: Player[]) {
    if (this.finished) return;
    let eliminationNumber = Game.totalVoteOuts() + 1;
    for (const player of players) {
      await this.say(
        `${this.getOrdinal(eliminationNumber++)} person voted out of Survivor: <@${player.id}>.`,
      );
    }
    await this.voteOut(players);
    await this.finish();
  }

  /** Turns over a castaway for each player and announces any eliminations. */
  private async voteOut(players: Player[]) {
    if (this.isGameStale()) return;
    const outcomes = Game.applyVoteOuts(players);
    for (const outcome of outcomes) {
      if (outcome.eliminated) this.eliminated.push(outcome.player);
    }
    for (const outcome of outcomes) {
      const { player, castaway } = outcome;
      const lives = player.lives;
      const livesLeft =
        lives === 0
          ? "That was their last castaway."
          : `They have ${lives} ${lives === 1 ? "life" : "lives"} left.`;
      await this.say(
        `<@${player.id}> has been voted out${castaway ? `, and their castaway **${castaway.name}** is grayed out` : ""}. ${livesLeft}`,
      );
      if (outcome.eliminated) {
        await this.say(
          `<@${player.id}> has been ELIMINATED and their torch has been snuffed. They join the jury. ${snuffedGif}`,
        );
      }
    }
  }

  /** Hands the eliminated players' cards to their heirs (or the discard pile). */
  private async settleHands() {
    for (const settlement of Game.settleEliminatedHands(this.eliminated)) {
      const { player, heir, inheritedCards, discardedCount } = settlement;
      if (heir) {
        const count = inheritedCards.length;
        await this.say(
          `📜 <@${heir.id}> played **Inheritance: ${player.username}** and inherits ${count} card${count === 1 ? "" : "s"} from <@${player.id}>.`,
        );
        if (count > 0) {
          await sendDM(
            this.interaction.client,
            heir.id,
            `You inherited ${inheritedCards.map((card) => `**${card.getName()}**`).join(", ")} from ${player.username} in the Survivor game!`,
          );
        }
      } else if (discardedCount > 0) {
        await this.say(
          `<@${player.id}>'s ${discardedCount} card${discardedCount === 1 ? "" : "s"} go to the discard pile.`,
        );
      }
    }
  }

  /** Ends the council: board, then the next turn or the Final Tribal Council. */
  async finish(showBoard = true) {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    if (Game.tribalCouncil === this) Game.tribalCouncil = null;
    // A council from a game that has since ended must not touch the new one.
    if (this.isGameStale()) return;

    const alive = Game.getAlivePlayers().length;
    const finalTwo = alive <= 2;
    // Lock in the Final Tribal Council now, before any awaits, so nobody can
    // draw (and start another council) while the messages below are posted.
    Game.tribalCouncilState = finalTwo
      ? TribalCouncilState.FINAL
      : TribalCouncilState.NotStarted;
    for (const player of Game.players) {
      player.votes = 0;
    }
    const next = finalTwo
      ? undefined
      : this.leaderChangedByCard && this.leader
        ? Game.setTurn(this.leader)
        : Game.advanceTurn(this.drawer);

    await this.settleHands();
    if (showBoard && !this.isGameStale()) {
      await this.say(
        await buildBoardMessage({
          title: `Tribal Council #${this.number}`,
          subtitle: finalTwo
            ? "The tribe has spoken. Only two remain!"
            : `The tribe has spoken. ${alive} players remain.`,
          highlightTribal: this.number,
        }),
      );
    }
    if (this.isGameStale()) return;
    await this.say(
      `The tribal council has ended.${next ? ` It's <@${next.id}>'s turn.` : ""}`,
    );
    if (finalTwo && !this.isGameStale()) {
      const started = await startFinalTribalCouncil(this.say);
      if (typeof started === "string") {
        console.warn(`Final Tribal Council didn't start: ${started}`);
      }
    }
  }

  async waitForIdol() {
    // Set up idol window
    Game.tribalCouncilState = TribalCouncilState.Immunity;
    await this.say(
      `If anyone has an Immunity Idol and would like to play it, now would be the time to do so. You have ${formatDuration(GameConfig.timings.idolWindowMs)}.`,
    );
    await this.sleep(GameConfig.timings.idolWindowMs);
    if (this.isStale()) return;

    if (this.idolProtections.length > 0) {
      // An idol was played, now wait for potential nullifier
      Game.tribalCouncilState = TribalCouncilState.Nullify;
      await this.say(
        `If anyone has an Idol Nullifier and would like to play it, now would be the time to do so. You have ${formatDuration(GameConfig.timings.nullifierWindowMs)}.`,
      );
      await this.sleep(GameConfig.timings.nullifierWindowMs);
      if (this.isStale()) return;
    }

    Game.tribalCouncilState = TribalCouncilState.Reading;
  }

  /** Stops all timers; used when the game is reset mid-council. */
  dispose() {
    this.disposed = true;
    this.clearTimers();
  }

  /** The game was reset or ended since this council started. */
  private isGameStale(): boolean {
    return this.disposed || !Game.isCurrentGame(this.gameId);
  }

  private isStale(): boolean {
    return this.isGameStale() || Game.tribalCouncil !== this;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.schedule(resolve, ms));
  }

  private schedule(callback: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
  }

  private clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export { TribalCouncil, TribalCouncilType };
