import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ComponentType,
  InteractionCollector,
  Message,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "./game";
import type Player from "./player";
import { GameConfig, formatDuration } from "./config";
import { buildBoardMessage } from "./board";
import { Announcer, mention, sleep } from "../util/discord";

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The endgame: the two remaining players plead their case and the jury (every
 * eliminated player) votes for who should win. The Final Tribal Council Leader
 * (the last player eliminated) breaks a tie.
 */
class FinalTribalCouncil {
  readonly gameId = Game.id;
  /** Juror id -> the finalist they voted for. */
  readonly votes = new Map<string, Player>();
  /** Finalists tied after the reveal, waiting on the leader. */
  tiedFinalists: Player[] = [];
  private message: Message | null = null;
  private collector: InteractionCollector<ButtonInteraction> | null = null;
  private voteTimer: NodeJS.Timeout | null = null;
  private tieTimer: NodeJS.Timeout | null = null;
  private revealing = false;
  private finished = false;
  private disposed = false;

  constructor(
    readonly finalists: Player[],
    readonly jury: Player[],
    readonly leader: Player,
    private readonly say: Announcer,
  ) {}

  get allVoted(): boolean {
    return this.jury.every((juror) => this.votes.has(juror.id));
  }

  get votingOpen(): boolean {
    return !this.revealing && !this.finished && !this.disposed;
  }

  get awaitingTieBreak(): boolean {
    return this.tiedFinalists.length > 0 && !this.finished;
  }

  private buttonId(finalist: Player): string {
    return `ftc:${this.gameId}:vote:${finalist.id}`;
  }

  private introText(): string {
    return [
      "🔥 **FINAL TRIBAL COUNCIL** 🔥",
      `The final two: ${this.finalists.map(mention).join(" and ")}.`,
      `The jury: ${this.jury.map(mention).join(", ")}. <@${this.leader.id}> is the Final Tribal Council Leader and breaks any tie.`,
      "",
      "Finalists, make your case to the jury! Jurors, when you've heard enough, vote for the player you want to **win** with the buttons below (or `/cast_vote`). Votes are secret and final.",
      `The votes are read once every juror has voted, or after ${formatDuration(GameConfig.timings.finalVoteMs)}.`,
      `🗳️ Votes cast: ${this.votes.size}/${this.jury.length}`,
    ].join("\n");
  }

  private voteButtons() {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        this.finalists.map((finalist) =>
          new ButtonBuilder()
            .setCustomId(this.buttonId(finalist))
            .setLabel(truncate(`Vote for ${finalist.username}`, 80))
            .setEmoji("🗳️")
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    ];
  }

  async open() {
    // A juror who never votes can't hold up the end of the game forever.
    this.voteTimer = setTimeout(() => {
      void this.closeVoting();
    }, GameConfig.timings.finalVoteMs);
    this.message = await this.say({
      content: this.introText(),
      components: this.voteButtons(),
    });
    if (!this.message) return;

    this.collector = this.message.createMessageComponentCollector({
      componentType: ComponentType.Button,
    });
    this.collector.on("collect", async (click) => {
      const finalist = this.finalists.find((f) => this.buttonId(f) === click.customId);
      const juror = Game.getPlayerFromUserId(click.user.id);
      const error = !finalist
        ? "That vote button is out of date."
        : !juror
          ? "Only the jury (players who were voted out) can vote."
          : this.recordVote(juror, finalist);
      if (error || !finalist) {
        await click
          .reply({ content: error ?? "Something went wrong.", flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
        return;
      }
      await click
        .reply({
          content: `Your vote for <@${finalist.id}> is locked in. 🔒`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      await this.afterVote();
    });
  }

  /** Records a jury vote. Returns an error message, or null on success. */
  recordVote(juror: Player, finalist: Player): string | null {
    if (!this.votingOpen) return "Voting at Final Tribal Council is closed.";
    if (!this.jury.includes(juror)) {
      return "Only the jury (players who were voted out) can vote.";
    }
    if (!this.finalists.includes(finalist)) {
      return `You can only vote for a finalist: ${this.finalists.map(mention).join(" or ")}.`;
    }
    if (this.votes.has(juror.id)) return "You've already cast your vote.";
    this.votes.set(juror.id, finalist);
    return null;
  }

  /** Updates the vote count and reads the votes once the whole jury has voted. */
  async afterVote() {
    await this.message
      ?.edit({ content: this.introText(), components: this.voteButtons() })
      .catch(() => undefined);
    if (this.allVoted) await this.reveal();
  }

  private async closeVoting() {
    if (!this.votingOpen || this.isStale()) return;
    await this.say(
      `⏳ Time's up at Final Tribal Council! Reading the ${this.votes.size} vote${this.votes.size === 1 ? "" : "s"} that are in.`,
    );
    await this.reveal();
  }

  /** Reads the votes. Stops early once a finalist has clinched a majority. */
  async reveal() {
    if (!this.votingOpen) return;
    this.revealing = true;
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.collector?.stop("reveal");
    await this.message
      ?.edit({ content: `${this.introText()}\n**Voting is closed.**`, components: [] })
      .catch(() => undefined);

    const ballots = shuffled([...this.votes.values()]);
    const tally = new Map<Player, number>(this.finalists.map((f) => [f, 0]));
    const majority = Math.floor(ballots.length / 2) + 1;
    await this.say("The jury has spoken. I'll read the votes.");
    await sleep(GameConfig.timings.voteReadMs);

    for (let i = 0; i < ballots.length; i++) {
      if (this.isStale()) return;
      const finalist = ballots[i];
      const count = (tally.get(finalist) ?? 0) + 1;
      tally.set(finalist, count);
      await this.say(`${(ORDINALS[i] ?? `Vote ${i + 1}`).toUpperCase()} VOTE: <@${finalist.id}>`);
      await sleep(GameConfig.timings.voteReadMs);
      if (count >= majority && i < ballots.length - 1) {
        await this.say(
          `That's ${NUMBER_WORDS[count] ?? count} votes for <@${finalist.id}>, enough to win.`,
        );
        break;
      }
    }
    if (this.isStale()) return;

    const top = Math.max(...tally.values());
    const leaders = this.finalists.filter((f) => tally.get(f) === top);
    if (leaders.length === 1) {
      await this.crown(leaders[0]);
      return;
    }

    this.tiedFinalists = leaders;
    await this.say(
      `It's a tie! <@${this.leader.id}>, as Final Tribal Council Leader you choose the winner: use "/break_tie player1:@player" with ${leaders.map(mention).join(" or ")}. ` +
        `If there's no decision within ${formatDuration(GameConfig.timings.tieBreakMs)}, the winner will be decided by drawing rocks.`,
    );
    this.tieTimer = setTimeout(() => {
      void this.settleTieByRocks();
    }, GameConfig.timings.tieBreakMs);
  }

  /** Claims the tie so only one decision (the leader's or the rocks') counts. */
  private claimTie() {
    this.tiedFinalists = [];
    if (this.tieTimer) clearTimeout(this.tieTimer);
  }

  private async settleTieByRocks() {
    if (!this.awaitingTieBreak || this.isStale()) return;
    const winner = shuffled(this.tiedFinalists)[0];
    this.claimTie();
    await this.say(
      `⏳ <@${this.leader.id}> didn't decide in time, so it comes down to the rocks...`,
    );
    await this.crown(winner);
  }

  /**
   * The leader picks the winner after a tie. Returns an error message, or a
   * promise for the announcement. The tie is claimed straight away.
   */
  breakTie(winner: Player): string | Promise<void> {
    if (!this.awaitingTieBreak) return "There is no tie to break at Final Tribal Council.";
    if (!this.tiedFinalists.includes(winner)) {
      return `Pick one of the tied finalists: ${this.tiedFinalists.map(mention).join(" or ")}.`;
    }
    this.claimTie();
    return (async () => {
      await this.say(`<@${this.leader.id}> has cast the deciding vote for <@${winner.id}>.`);
      await this.crown(winner);
    })();
  }

  private async crown(winner: Player) {
    if (this.finished || this.isStale()) return;
    this.finished = true;
    this.tiedFinalists = [];
    if (this.tieTimer) clearTimeout(this.tieTimer);
    Game.winner = winner;
    Game.active = false;
    await this.say(
      await buildBoardMessage({
        title: "Sole Survivor",
        subtitle: `${winner.username} wins Survivor!`,
        content: `🏆 The winner of Survivor is... <@${winner.id}>! Congratulations!`,
      }),
    );
    await this.say("Thanks for playing! Start a new game any time with /setup or /start.");
  }

  private isStale(): boolean {
    return this.disposed || !Game.isCurrentGame(this.gameId);
  }

  dispose() {
    this.disposed = true;
    this.collector?.stop("reset");
    if (this.voteTimer) clearTimeout(this.voteTimer);
    if (this.tieTimer) clearTimeout(this.tieTimer);
  }
}

/** The juror whose last castaway went most recently. */
function mostRecentlyEliminated(jury: Player[]): Player | undefined {
  const lastLoss = (player: Player) =>
    Math.max(...player.castaways.map((c) => c.lostAtTribal ?? 0));
  return [...jury].sort((a, b) => lastLoss(b) - lastLoss(a))[0];
}

/**
 * Starts the Final Tribal Council once two players remain. Returns the council,
 * or an error message explaining why it can't start.
 */
async function startFinalTribalCouncil(
  say: Announcer,
): Promise<FinalTribalCouncil | string> {
  if (!Game.active) return "No game is currently in progress!";
  if (Game.finalTribalCouncil) return "Final Tribal Council has already started.";
  const finalists = Game.getAlivePlayers();
  if (finalists.length !== 2) {
    return "Final Tribal Council can only be started when exactly 2 players remain.";
  }
  const jury = Game.players.filter((player) => !player.isAlive());
  const leader =
    Game.finalTribalLeader && jury.includes(Game.finalTribalLeader)
      ? Game.finalTribalLeader
      : mostRecentlyEliminated(jury);
  if (!leader) return "There is no jury to vote at Final Tribal Council.";

  Game.finalTribalLeader = leader;
  Game.tribalCouncilState = TribalCouncilState.FINAL;
  const council = new FinalTribalCouncil(finalists, jury, leader, say);
  Game.finalTribalCouncil = council;
  await council.open();
  return council;
}

export { FinalTribalCouncil, startFinalTribalCouncil };
