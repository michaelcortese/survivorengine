import {
  ActionRowBuilder,
  BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  Message,
} from "discord.js";
import { Game } from "./game";
import type Card from "./card";
import type Player from "./player";
import { CardName } from "./cards";
import { GameConfig, formatDuration } from "./config";
import { forceDiscard } from "./forced_discard";
import {
  Announcer,
  CountdownDisplay,
  createAnnouncer,
  mention,
  replyEphemeral,
  runSorryForYouWindow,
  sendDM,
  sleep,
} from "../util/discord";

export type RewardChallengeCard =
  | typeof CardName.NumbersGame
  | typeof CardName.PowerPair
  | typeof CardName.DoOrDie;

export type Throw = "rock" | "paper" | "scissors";

const BEATS: Record<Throw, Throw> = { rock: "scissors", paper: "rock", scissors: "paper" };

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** "A", "A and B", "A, B and C" */
function joinWithAnd(items: string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** It's a Numbers Game: whoever picked the lowest number nobody else picked, if anyone did. */
export function lowestUniquePick(
  picks: ReadonlyMap<Player, number>,
): { player: Player; pick: number } | null {
  const counts = new Map<number, number>();
  for (const pick of picks.values()) counts.set(pick, (counts.get(pick) ?? 0) + 1);
  let lowest: { player: Player; pick: number } | null = null;
  for (const [player, pick] of picks) {
    if (counts.get(pick) === 1 && (!lowest || pick < lowest.pick)) lowest = { player, pick };
  }
  return lowest;
}

export type PowerPairResult =
  | { kind: "pair"; pair: [Player, Player]; odd: Player }
  | { kind: "all_match" }
  | { kind: "all_different" };

/** Power Pair: a matching pair steals from the odd one out; all three matching discard; all different play again. */
export function powerPairResult(picks: [Player, number][]): PowerPairResult {
  const [[a, pickA], [b, pickB], [c, pickC]] = picks;
  if (pickA === pickB && pickB === pickC) return { kind: "all_match" };
  if (pickA === pickB) return { kind: "pair", pair: [a, b], odd: c };
  if (pickA === pickC) return { kind: "pair", pair: [a, c], odd: b };
  if (pickB === pickC) return { kind: "pair", pair: [b, c], odd: a };
  return { kind: "all_different" };
}

/** Do or Die: who won a game of Rock Paper Scissors, or null on a tie. */
export function rockPaperScissors(
  [first, firstThrow]: [Player, Throw],
  [second, secondThrow]: [Player, Throw],
): { winner: Player; loser: Player } | null {
  if (firstThrow === secondThrow) return null;
  return BEATS[firstThrow] === secondThrow
    ? { winner: first, loser: second }
    : { winner: second, loser: first };
}

/** Moves up to `count` random cards from one hand to another, and returns them. */
export function takeRandomCards(from: Player, to: Player, count: number): Card[] {
  const taken: Card[] = [];
  while (taken.length < count) {
    const card = from.removeRandomCard();
    if (!card) break;
    taken.push(card);
  }
  to.hand.push(...taken);
  return taken;
}

/**
 * Each player gives the other a random card. Returns [a's card, b's card], or
 * null (and swaps nothing) if either of them has no cards.
 */
export function swapRandomCards(a: Player, b: Player): [Card, Card] | null {
  if (a.hand.length === 0 || b.hand.length === 0) return null;
  const fromA = a.removeRandomCard()!;
  const fromB = b.removeRandomCard()!;
  a.hand.push(fromB);
  b.hand.push(fromA);
  return [fromA, fromB];
}

interface Choice<T> {
  value: T;
  label: string;
  emoji?: string;
}

type Picks<T> = Map<Player, Choice<T>>;

/** Posts a message, or returns null if it couldn't be posted. */
type Post = (payload: BaseMessageOptions) => Promise<Message | null>;

const NUMBERS: Choice<number>[] = [1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }));
const ONE_TO_THREE = NUMBERS.slice(0, 3);
const THROWS: Choice<Throw>[] = [
  { value: "rock", label: "Rock", emoji: "🪨" },
  { value: "paper", label: "Paper", emoji: "📄" },
  { value: "scissors", label: "Scissors", emoji: "✂️" },
];

const CALLED_OFF = "🛑 The game ended, so this Reward Challenge was called off.";

function describeChoice(choice: Choice<unknown>): string {
  return `${choice.emoji ? `${choice.emoji} ` : ""}**${choice.label}**`;
}

function cardList(cards: Card[]): string {
  return joinWithAnd(cards.map((card) => `**${card.getName()}**`));
}

function buttonRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

/** Gives everyone who didn't pick in time a random pick, and returns who got one. */
function fillRandomPicks<T>(picks: Picks<T>, players: Player[], choices: Choice<T>[]): Set<Player> {
  const randomized = new Set<Player>();
  for (const player of players) {
    if (picks.has(player)) continue;
    picks.set(player, randomItem(choices));
    randomized.add(player);
  }
  return randomized;
}

/**
 * Keeps a message showing the latest state. Edits go out one at a time and
 * each renders the state as it is when it's sent, so a slow edit can't
 * overwrite a newer one.
 */
function liveMessage(message: Message, render: () => BaseMessageOptions): () => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  let queued = false;
  return () => {
    if (!queued) {
      queued = true;
      queue = queue.then(async () => {
        queued = false;
        try {
          await message.edit(render());
        } catch (error) {
          console.error("Couldn't update a Reward Challenge message:", error);
        }
      });
    }
    return queue;
  };
}

/** Shows a Sorry for You countdown in a new message, so the player being robbed gets pinged. */
function countdownMessage(say: Announcer): CountdownDisplay {
  let message: Message | null = null;
  return {
    get replied() {
      return message !== null;
    },
    deferred: false,
    async reply(options) {
      message = await say(options);
      if (!message) throw new Error("Couldn't post the Sorry for You countdown.");
    },
    async editReply(options) {
      await message?.edit(options).catch((error) => {
        console.error("Couldn't update a Sorry for You countdown:", error);
      });
    },
  };
}

type PickState = "open" | "all_in" | "time" | "called_off";

let nextChallengeId = 1;

/**
 * A Reward Challenge being played out: everyone taking part picks in secret
 * with buttons, then the picks are revealed and the winners steal. Each steal
 * can be blocked with Sorry for You. One runs at a time (see Game.rewardChallenge).
 */
export class RewardChallenge {
  readonly id = nextChallengeId++;
  readonly gameId = Game.id;
  /** Set once the challenge has been announced. From then on, the card has been played. */
  started = false;
  private readonly say: Announcer;
  private readonly collectors = new Set<{ stop(reason?: string): void }>();
  private disposed = false;

  constructor(
    private readonly interaction: ChatInputCommandInteraction,
    readonly card: RewardChallengeCard,
    /** Who played the card. */
    readonly host: Player,
    /** Everyone taking part: the host and their opponents, or the whole tribe for the Numbers Game. */
    readonly players: Player[],
  ) {
    this.say = createAnnouncer(interaction);
  }

  /**
   * Plays the challenge out. Throws only if it couldn't be announced, in which
   * case nothing has happened yet and the card can be handed back.
   */
  async run(): Promise<void> {
    try {
      if (this.card === CardName.NumbersGame) await this.numbersGame();
      else if (this.card === CardName.PowerPair) await this.powerPair();
      else await this.doOrDie();
    } catch (error) {
      if (!this.started) throw error;
      console.error(`Reward Challenge #${this.id} failed:`, error);
      if (!this.isStale()) {
        await this.say(
          "Something went wrong with the Reward Challenge, so it has been called off. Play continues.",
        );
      }
    }
  }

  /** Stops listening for picks; used when the game is reset mid-challenge. */
  dispose() {
    this.disposed = true;
    for (const collector of this.collectors) collector.stop("reset");
  }

  private isStale(): boolean {
    return this.disposed || !Game.isCurrentGame(this.gameId);
  }

  private async numbersGame() {
    const header = [
      `🏆 **Reward Challenge: It's a Numbers Game!** <@${this.host.id}> played it.`,
      "Everyone still in the game picks a number from 1 to 5 in secret. The lowest number nobody else picks wins, and whoever picked it steals 2 random cards from any player they choose. If every number is picked more than once, nobody wins.",
      `The picks are revealed once everyone is in. Anyone who hasn't picked within ${formatDuration(GameConfig.timings.rewardChallengeMs)} sits this one out.`,
    ].join("\n");
    const picks = await this.collectPicks(1, header, NUMBERS, (payload) => this.reply(payload));
    if (this.isStale()) return;

    const pickers = this.players.filter((player) => picks.has(player));
    if (pickers.length === 0) {
      await this.say("🖐️ Nobody picked a number, so nobody wins the Numbers Game.");
      return;
    }
    const lines = [`🖐️ The picks: ${this.describePicks(pickers, picks)}`];
    const satOut = this.players.filter((player) => !picks.has(player));
    if (satOut.length > 0) {
      lines.push(`${joinWithAnd(satOut.map(mention))} didn't pick in time and sat this one out.`);
    }
    const winner = lowestUniquePick(
      new Map(pickers.map((player) => [player, picks.get(player)!.value])),
    );
    if (!winner) {
      lines.push("Every number was picked more than once, so nobody wins.");
      await this.say(lines.join("\n"));
      return;
    }
    lines.push(`🏆 <@${winner.player.id}> wins with the lowest unique number, **${winner.pick}**!`);
    const victim = await this.chooseVictim(winner.player, lines.join("\n"));
    if (victim) await this.steal(winner.player, victim, 2);
  }

  private async powerPair() {
    const [host, first, second] = this.players;
    const howToPick = `Pick 1, 2 or 3 in secret. If you haven't picked within ${formatDuration(GameConfig.timings.rewardChallengeMs)}, you get a random pick.`;
    let header = [
      `🏆 **Reward Challenge: Power Pair!** <@${host.id}> takes on <@${first.id}> and <@${second.id}>.`,
      "If exactly two of you pick the same number, you each steal 1 random card from the third. If all three match, you each discard 1 card. If all three are different, you play again.",
      howToPick,
    ].join("\n");
    let post: Post = (payload) => this.reply(payload);

    for (let round = 1; ; round++) {
      const picks = await this.collectPicks(round, header, ONE_TO_THREE, post);
      if (this.isStale()) return;
      const randomized = fillRandomPicks(picks, this.players, ONE_TO_THREE);
      const shown = `🖐️ ${this.describePicks(this.players, picks, randomized)}`;
      const result = powerPairResult(
        this.players.map((player): [Player, number] => [player, picks.get(player)!.value]),
      );

      if (result.kind === "all_different") {
        header = [
          shown,
          `All three are different, so play again! **Power Pair, round ${round + 1}.**`,
          howToPick,
        ].join("\n");
        post = (payload) => this.say(payload);
        continue;
      }

      if (result.kind === "all_match") {
        await this.say(`${shown}\nAll three match, so each of you discards 1 card.`);
        for (const player of this.players) {
          if (this.isStale()) return;
          await forceDiscard(player, (payload) => this.say(payload));
        }
        return;
      }

      const [a, b] = result.pair;
      await this.say(
        `${shown}\n<@${a.id}> and <@${b.id}> match, so they each steal 1 random card from <@${result.odd.id}>!`,
      );
      // One Sorry for You window per steal, one after the other
      for (const thief of result.pair) await this.steal(thief, result.odd, 1);
      return;
    }
  }

  private async doOrDie() {
    const [host, opponent] = this.players;
    const header = [
      `🏆 **Reward Challenge: Do or Die!** <@${host.id}> challenges <@${opponent.id}> to Rock Paper Scissors.`,
      "The winner steals 2 random cards from the loser. On a tie, you swap 1 random card.",
      `Throw in secret. If you haven't thrown within ${formatDuration(GameConfig.timings.rewardChallengeMs)}, you get a random throw.`,
    ].join("\n");
    const picks = await this.collectPicks(1, header, THROWS, (payload) => this.reply(payload));
    if (this.isStale()) return;
    const randomized = fillRandomPicks(picks, this.players, THROWS);
    const shown = `Rock, paper, scissors, shoot! ${this.describePicks(this.players, picks, randomized)}`;

    const result = rockPaperScissors(
      [host, picks.get(host)!.value],
      [opponent, picks.get(opponent)!.value],
    );
    if (result) {
      await this.say(
        `${shown}\n<@${result.winner.id}> wins and steals 2 random cards from <@${result.loser.id}>!`,
      );
      await this.steal(result.winner, result.loser, 2);
      return;
    }

    const swapped = swapRandomCards(host, opponent);
    if (!swapped) {
      const emptyHanded = this.players.filter((player) => player.hand.length === 0);
      await this.say(
        `${shown}\nIt's a tie, but ${joinWithAnd(emptyHanded.map(mention))} ${emptyHanded.length === 1 ? "has" : "have"} no cards, so there's nothing to swap.`,
      );
      return;
    }
    const [fromHost, fromOpponent] = swapped;
    await this.say(`${shown}\n🔄 It's a tie, so <@${host.id}> and <@${opponent.id}> swapped a random card.`);
    const client = this.interaction.client;
    await sendDM(
      client,
      host.id,
      `Do or Die was a tie: you gave **${fromHost.getName()}** to <@${opponent.id}> and got **${fromOpponent.getName()}** back.`,
    );
    await sendDM(
      client,
      opponent.id,
      `Do or Die was a tie: you gave **${fromOpponent.getName()}** to <@${host.id}> and got **${fromHost.getName()}** back.`,
    );
  }

  /** Posts the challenge as the command's reply. From then on, the card has been played. */
  private async reply(payload: BaseMessageOptions): Promise<Message> {
    const response = await this.interaction.reply({ ...payload, withResponse: true });
    this.started = true;
    return response.resource?.message ?? (await this.interaction.fetchReply());
  }

  /**
   * Collects everyone's secret pick with buttons on a public message, and
   * confirms each pick privately. Resolves once everyone has picked, or with
   * the picks made so far when time runs out.
   */
  private async collectPicks<T>(
    round: number,
    header: string,
    choices: Choice<T>[],
    post: Post,
  ): Promise<Picks<T>> {
    const picks: Picks<T> = new Map();
    let state: PickState = "open";
    const render = (): BaseMessageOptions => ({
      content: `${header}\n${this.pickStatus(picks, state)}`,
      components: state === "open" ? this.pickButtons(round, choices) : [],
    });

    const message = await post(render());
    if (!message) return picks;
    if (this.isStale()) {
      state = "called_off";
      await message.edit(render()).catch(() => undefined);
      return picks;
    }
    const refresh = liveMessage(message, render);

    return new Promise((resolve) => {
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GameConfig.timings.rewardChallengeMs,
      });
      this.collectors.add(collector);

      collector.on("collect", async (click) => {
        const choice = choices.find((c) => this.pickId(round, c.value) === click.customId);
        const player = this.players.find((p) => p.id === click.user.id);
        if (!choice || !player || picks.has(player)) {
          const error = !choice
            ? "That button is out of date."
            : !player
              ? this.notTakingPart()
              : `You already picked ${describeChoice(picks.get(player)!)}. Picks are final.`;
          await replyEphemeral(click, error).catch(() => undefined);
          return;
        }
        picks.set(player, choice);
        // Record the pick before stopping: stop() runs the "end" handler straight away
        if (picks.size === this.players.length) collector.stop("all_in");
        await replyEphemeral(
          click,
          `You picked ${describeChoice(choice)}. 🔒 It stays secret until the reveal.`,
        ).catch(() => undefined);
        if (state === "open") await refresh();
      });

      collector.on("end", (_collected, reason) => {
        this.collectors.delete(collector);
        // Anything but a reset (time running out, the message being deleted) goes ahead with the picks so far
        state = reason === "all_in" ? "all_in" : reason === "reset" ? "called_off" : "time";
        void refresh().then(() => resolve(picks));
      });
    });
  }

  private pickStatus(picks: Picks<unknown>, state: PickState): string {
    if (state === "all_in") return "🔒 Everyone is locked in!";
    if (state === "time") return "⏳ Time's up!";
    if (state === "called_off") return CALLED_OFF;
    const lockedIn = this.players.filter((player) => picks.has(player));
    const waiting = this.players.filter((player) => !picks.has(player));
    return [
      ...(lockedIn.length > 0 ? [`🔒 Locked in: ${lockedIn.map(mention).join(", ")}`] : []),
      `⏳ Waiting on: ${waiting.map(mention).join(", ")}`,
    ].join("\n");
  }

  private pickButtons<T>(round: number, choices: Choice<T>[]): ActionRowBuilder<ButtonBuilder>[] {
    return buttonRows(
      choices.map((choice) => {
        const button = new ButtonBuilder()
          .setCustomId(this.pickId(round, choice.value))
          .setLabel(choice.label)
          .setStyle(ButtonStyle.Primary);
        return choice.emoji ? button.setEmoji(choice.emoji) : button;
      }),
    );
  }

  private pickId(round: number, value: unknown): string {
    return `reward:${this.id}:${round}:${String(value)}`;
  }

  private notTakingPart(): string {
    return this.card === CardName.NumbersGame
      ? "Only players still in the game can pick."
      : `This challenge is between ${joinWithAnd(this.players.map(mention))}.`;
  }

  private describePicks<T>(players: Player[], picks: Picks<T>, randomized = new Set<Player>()): string {
    return players
      .map(
        (player) =>
          `<@${player.id}> ${describeChoice(picks.get(player)!)}${randomized.has(player) ? " (random)" : ""}`,
      )
      .join(" · ");
  }

  /**
   * The Numbers Game winner chooses who to steal from, with buttons. If they
   * don't choose in time, it's picked at random.
   */
  private async chooseVictim(winner: Player, reveal: string): Promise<Player | null> {
    const candidates = Game.getAlivePlayers().filter(
      (player) => player !== winner && player.hand.length > 0,
    );
    if (candidates.length === 0) {
      await this.say(`${reveal}\nNobody else has any cards, so there's nothing to steal.`);
      return null;
    }
    if (candidates.length === 1) {
      const [only] = candidates;
      await this.say(
        `${reveal}\n<@${only.id}> is the only other player with cards, so that's who <@${winner.id}> steals from.`,
      );
      return only;
    }

    const victimId = (player: Player) => `reward:${this.id}:steal:${player.id}`;
    const message = await this.say({
      content: `${reveal}\n<@${winner.id}>, choose who to steal 2 random cards from. If you don't choose within ${formatDuration(GameConfig.timings.rewardChallengeMs)}, it's picked at random.`,
      components: buttonRows(
        candidates.map((player) =>
          new ButtonBuilder()
            .setCustomId(victimId(player))
            .setLabel(`${player.username} (${player.hand.length} card${player.hand.length === 1 ? "" : "s"})`)
            .setStyle(ButtonStyle.Danger),
        ),
      ),
    });
    if (!message) return randomItem(candidates);
    if (this.isStale()) {
      await message.edit({ content: `${reveal}\n${CALLED_OFF}`, components: [] }).catch(() => undefined);
      return null;
    }

    return new Promise((resolve) => {
      let chosen: Player | null = null;
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: GameConfig.timings.rewardChallengeMs,
      });
      this.collectors.add(collector);

      collector.on("collect", async (click) => {
        const victim = candidates.find((player) => victimId(player) === click.customId);
        if (click.user.id !== winner.id || !victim || victim.hand.length === 0) {
          const error =
            click.user.id !== winner.id
              ? `Only <@${winner.id}> gets to choose.`
              : !victim
                ? "That button is out of date."
                : `<@${victim.id}> has no cards left. Choose someone else.`;
          await replyEphemeral(click, error).catch(() => undefined);
          return;
        }
        // Record the choice before stopping: stop() runs the "end" handler straight away
        chosen = victim;
        collector.stop("chosen");
        await click
          .update({ content: `${reveal}\n<@${winner.id}> is stealing from <@${victim.id}>.`, components: [] })
          .catch(() => undefined);
      });

      collector.on("end", (_collected, reason) => {
        this.collectors.delete(collector);
        if (chosen) {
          resolve(chosen);
          return;
        }
        const holding = candidates.filter((player) => player.hand.length > 0);
        const victim = reason !== "reset" && holding.length > 0 ? randomItem(holding) : null;
        const outcome =
          reason === "reset"
            ? CALLED_OFF
            : victim
              ? `⏳ <@${winner.id}> didn't choose in time, so <@${victim.id}> was picked at random.`
              : "⏳ Time's up, and nobody has any cards left to steal.";
        void message
          .edit({ content: `${reveal}\n${outcome}`, components: [] })
          .catch(() => undefined)
          .then(() => resolve(victim));
      });
    });
  }

  /**
   * `thief` steals up to `count` random cards from `victim`, who can block it
   * with Sorry for You. Returns the cards stolen.
   */
  private async steal(thief: Player, victim: Player, count: number): Promise<Card[]> {
    if (this.isStale()) return [];
    if (victim.hand.length === 0) {
      await this.say(`<@${victim.id}> has no cards left for <@${thief.id}> to steal.`);
      return [];
    }
    const what = count === 1 ? "a random card" : `${count} random cards`;
    const describe = (seconds: number) =>
      `<@${thief.id}> is trying to steal ${what} from <@${victim.id}>... (<@${victim.id}> has ~${seconds} seconds to play "Sorry For You")`;
    const countdown = countdownMessage(this.say);

    let window = await runSorryForYouWindow(countdown, thief, victim, describe);
    while (!window) {
      // Another steal's Sorry for You window is open: wait for it to close
      await sleep(250);
      if (this.isStale()) return [];
      window = await runSorryForYouWindow(countdown, thief, victim, describe);
    }
    // A reset also closes the window, so check for that before anything else
    if (this.isStale()) {
      await countdown.editReply({ content: CALLED_OFF });
      return [];
    }
    if (window.outcome === "stopped") {
      await countdown.editReply({
        content: `🛑 <@${thief.id}>'s steal from <@${victim.id}> was blocked with ${window.secondsLeft} seconds remaining!`,
      });
      return [];
    }

    const stolen = takeRandomCards(victim, thief, count);
    if (stolen.length === 0) {
      await countdown.editReply({
        content: `<@${thief.id}> tried to steal from <@${victim.id}>, but there was nothing left to take.`,
      });
      return [];
    }
    await countdown.editReply({
      content: `💰 <@${thief.id}> stole ${stolen.length === 1 ? "a card" : `${stolen.length} cards`} from <@${victim.id}>!`,
    });
    const client = this.interaction.client;
    await sendDM(client, thief.id, `You stole ${cardList(stolen)} from <@${victim.id}> in a Reward Challenge!`);
    await sendDM(client, victim.id, `<@${thief.id}> stole ${cardList(stolen)} from you in a Reward Challenge!`);
    return stolen;
  }
}
