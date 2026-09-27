import {
  ChatInputCommandInteraction,
  Message,
  MessageCreateOptions,
  PermissionFlagsBits,
  SendableChannels,
} from "discord.js";
import Deck from "./deck";
import Player from "./player";
import type Card from "./card";
import type { Castaway } from "./castaways";
import { pickRandomCastaways, TRIBE_COLORS } from "./castaways";
import { GameConfig } from "./config";
import type { TribalCouncil } from "./tribal_council";
import type { FinalTribalCouncil } from "./final_tribal_council";
import type { Lobby } from "./lobby";

enum TribalCouncilState {
  NotStarted,
  Discussion,
  Voting,
  Immunity,
  Nullify,
  Reading,
  FINAL,
}

type InterruptionOutcome = "stopped" | "expired";

/**
 * A pending attempt to take cards from someone. The target can block it with
 * Sorry for You until the window closes.
 */
interface Interruption {
  attacker: Player;
  target: Player;
  settle: (outcome: InterruptionOutcome) => void;
}

/** When an action may be taken relative to Tribal Council. */
type TribalTiming = "forbidden" | "allowed" | TribalCouncilState[];

interface ActionRules {
  /** Card the action requires. Only checked here: commands remove it once the play is valid. */
  requiredCard?: string | null;
  /** Whether the command names another player in its `player` option. */
  target?: boolean | "optional";
  /** Blocked while someone's Sorry for You window is open. */
  interruptible?: boolean;
  /** Defaults to "forbidden". A list of states means "only during these phases". */
  tribalCouncil?: TribalTiming;
  /** Error shown when the Tribal Council phase doesn't match the list. */
  phaseError?: string;
  /** Lets voted-out players (the jury) use it. */
  allowEliminated?: boolean;
  allowSelfTarget?: boolean;
  allowEliminatedTarget?: boolean;
}

type ActionCheck =
  | { error: string }
  | { player: Player; targetPlayer?: Player };

interface VoteOutOutcome {
  player: Player;
  /** The castaway that was turned over. */
  castaway: Castaway | undefined;
  /** True when that was the player's last castaway. */
  eliminated: boolean;
}

/** What happened to an eliminated player's hand. */
interface HandSettlement {
  player: Player;
  /** Who played this player's Inheritance card and took their hand. */
  heir?: Player;
  inheritedCards: Card[];
  /** Cards discarded because nobody still in the game held the Inheritance card. */
  discardedCount: number;
}

interface StartOptions {
  /** Channel for public announcements (tribe board, turns, Final Tribal). */
  channel?: SendableChannels | null;
  discussionMs?: number;
  /** Randomize the seating / turn order (default true). */
  shuffleSeats?: boolean;
}

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

class GameManager {
  /** Bumped on every new game or reset, so long-running flows can tell they're stale. */
  id = 0;
  active = false;
  players: Player[] = [];
  currentPlayerIndex = 0;
  deck = new Deck();
  channel: SendableChannels | null = null;
  interruption: Interruption | null = null;
  tribalCouncilState = TribalCouncilState.NotStarted;
  tribalCouncil: TribalCouncil | null = null;
  /** Number of Tribal Councils held so far this game. */
  tribalCouncilCount = 0;
  finalTribalLeader: Player | null = null;
  finalTribalCouncil: FinalTribalCouncil | null = null;
  winner: Player | null = null;
  lobby: Lobby | null = null;
  discussionMs = GameConfig.timings.discussionMs;

  /** Ends any game or lobby in progress and clears all state. */
  reset(lobbyCloseReason?: string): void {
    this.id++;
    this.active = false;
    this.tribalCouncil?.dispose();
    this.finalTribalCouncil?.dispose();
    this.lobby?.dispose(lobbyCloseReason);
    this.interruption?.settle("stopped");
    this.interruption = null;
    this.players = [];
    this.currentPlayerIndex = 0;
    this.deck = new Deck();
    this.channel = null;
    this.tribalCouncilState = TribalCouncilState.NotStarted;
    this.tribalCouncil = null;
    this.tribalCouncilCount = 0;
    this.finalTribalLeader = null;
    this.finalTribalCouncil = null;
    this.winner = null;
    this.lobby = null;
    this.discussionMs = GameConfig.timings.discussionMs;
  }

  startGame(players: Player[], options: StartOptions = {}): void {
    this.reset("A game was started with /start instead.");
    this.players =
      options.shuffleSeats === false ? [...players] : shuffleInPlace([...players]);
    this.channel = options.channel ?? null;
    if (options.discussionMs !== undefined) {
      this.discussionMs = options.discussionMs;
    }

    // Tribe colors by seat, and random legends for anyone who didn't pick castaways.
    const chosenNames = this.players.flatMap((player) =>
      player.castaways.filter((c) => c.chosen).map((c) => c.name),
    );
    this.players.forEach((player, seat) => {
      player.color = TRIBE_COLORS[seat % TRIBE_COLORS.length];
      const missing = player.castaways.filter((c) => !c.chosen);
      const picks = pickRandomCastaways(missing.length, chosenNames);
      missing.forEach((castaway, i) => {
        castaway.name = picks[i];
        castaway.chosen = true;
        chosenNames.push(picks[i]);
      });
    });

    this.deck = new Deck();
    this.deck.addInheritanceCards(this.players);
    this.deck.shuffle();

    // Deal initial hands to players
    for (const player of this.players) {
      player.hand = [];
      for (let i = 0; i < GameConfig.cardsPerPlayer; i++) {
        const card = this.deck.drawCard();
        if (card) {
          player.hand.push(card);
        } else {
          console.error("Not enough cards in the deck!");
        }
      }
    }

    this.deck.shuffle();
    this.deck.addAndDisperseTribalCouncilCards(this.players.length);
    this.active = true;
    this.currentPlayerIndex = 0;
    console.log("Game started!");
  }

  isCurrentGame(gameId: number): boolean {
    return this.id === gameId;
  }

  getPlayer(username: string): Player | undefined {
    return this.players.find((player) => player.username === username);
  }

  getPlayerFromUserId(userId: string): Player | undefined {
    return this.players.find((player) => player.id === userId);
  }

  getAlivePlayers(): Player[] {
    return this.players.filter((player) => player.isAlive());
  }

  setTribalCouncil(tribalCouncil: TribalCouncil | null) {
    this.tribalCouncil = tribalCouncil;
  }

  /** The player whose turn it is. */
  currentPlayer(): Player | undefined {
    return this.players[this.currentPlayerIndex];
  }

  /** Passes the turn to the next player still in the game after `from`. */
  advanceTurn(from: Player | undefined = this.currentPlayer()): Player | undefined {
    if (this.players.length === 0) return undefined;
    const start = from ? this.players.indexOf(from) : this.currentPlayerIndex;
    for (let step = 1; step <= this.players.length; step++) {
      const index = (start + step + this.players.length) % this.players.length;
      if (this.players[index].isAlive()) {
        this.currentPlayerIndex = index;
        return this.players[index];
      }
    }
    return undefined;
  }

  /** Makes it `player`'s turn, or the next player's if they're out of the game. */
  setTurn(player: Player): Player | undefined {
    if (!player.isAlive()) return this.advanceTurn(player);
    this.currentPlayerIndex = this.players.indexOf(player);
    return player;
  }

  /**
   * Opens the Sorry for You window: `target` can block `attacker` until it
   * closes. Returns null if another window is already open.
   */
  openInterruptWindow(
    attacker: Player,
    target: Player,
    durationMs = GameConfig.timings.sorryForYouWindowMs,
  ): Promise<InterruptionOutcome> | null {
    if (this.interruption) return null;
    return new Promise((resolve) => {
      let settled = false;
      const interruption: Interruption = {
        attacker,
        target,
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.interruption === interruption) this.interruption = null;
          resolve(outcome);
        },
      };
      const timer = setTimeout(() => interruption.settle("expired"), durationMs);
      this.interruption = interruption;
    });
  }

  /** Blocks the open window (Sorry for You) and returns whoever was blocked. */
  blockInterruption(): Player | null {
    const interruption = this.interruption;
    if (!interruption) return null;
    interruption.settle("stopped");
    return interruption.attacker;
  }

  /**
   * Shared validation for commands. Checks the game is running, the caller is
   * an active player, the target is valid, the timing is right, and that they
   * hold the required card (without removing it).
   */
  validateAction(
    interaction: ChatInputCommandInteraction,
    rules: ActionRules = {},
  ): ActionCheck {
    if (!this.active) {
      return {
        error: this.winner
          ? `This game is over — <@${this.winner.id}> won! Start a new one with /setup or /start.`
          : "No game is currently in progress!",
      };
    }

    const player = this.getPlayerFromUserId(interaction.user.id);
    if (!player) {
      return { error: "You are not a player in the current game!" };
    }
    if (!rules.allowEliminated && !player.isAlive()) {
      return {
        error: "You've been voted out of the game, so you can't do that. You're on the jury now!",
      };
    }

    let targetPlayer: Player | undefined;
    if (rules.target) {
      const targetUser =
        interaction.options.getUser("player") ??
        interaction.options.getUser("target");
      if (!targetUser && rules.target !== "optional") {
        return { error: "You must specify a target player!" };
      }
      if (targetUser) {
        targetPlayer = this.getPlayerFromUserId(targetUser.id);
        if (!targetPlayer) {
          return { error: "The specified player is not in the game!" };
        }
        if (!rules.allowSelfTarget && targetPlayer === player) {
          return { error: "You can't target yourself with that!" };
        }
        if (!rules.allowEliminatedTarget && !targetPlayer.isAlive()) {
          return {
            error: `<@${targetPlayer.id}> has already been voted out of the game.`,
          };
        }
      }
    }

    const timing = rules.tribalCouncil ?? "forbidden";
    const state = this.tribalCouncilState;
    if (timing === "forbidden" && state !== TribalCouncilState.NotStarted) {
      return {
        error:
          state === TribalCouncilState.FINAL
            ? "The game is at Final Tribal Council — only the jury's votes matter now."
            : "This action cannot be played during the tribal council!",
      };
    }
    if (Array.isArray(timing) && !timing.includes(state)) {
      return {
        error:
          state === TribalCouncilState.NotStarted
            ? "This action cannot be played outside of tribal council!"
            : (rules.phaseError ??
              "You can't do that at this point in Tribal Council."),
      };
    }

    if (rules.interruptible && this.interruption) {
      return {
        error:
          "This action cannot be played at this time. Wait a moment and try again.",
      };
    }

    if (rules.requiredCard && !player.hasCard(rules.requiredCard)) {
      return {
        error: `You must have the ${rules.requiredCard} card to play this action!`,
      };
    }

    return { player, targetPlayer };
  }

  /** Castaways voted out so far across all players. */
  totalVoteOuts(): number {
    return this.players.reduce(
      (total, player) => total + player.castaways.filter((c) => c.lost).length,
      0,
    );
  }

  /**
   * Turns over one castaway for each player voted out. Players who lose their
   * last castaway are eliminated; their hands are settled at the end of the
   * council with settleEliminatedHands().
   */
  applyVoteOuts(votedOut: Player[]): VoteOutOutcome[] {
    const outcomes: VoteOutOutcome[] = votedOut.map((player) => {
      const castaway = player.loseLife(this.tribalCouncilCount);
      const eliminated = !player.isAlive();
      if (eliminated) {
        player.votes = 0;
        // Camp Raids by or on an eliminated player no longer do anything.
        player.campRaid = undefined;
        for (const other of this.players) {
          if (other.campRaid === player) other.campRaid = undefined;
        }
      }
      return { player, castaway, eliminated };
    });

    if (this.getAlivePlayers().length === 2) {
      // The last player voted out leads the Final Tribal Council.
      const lastOut = [...outcomes].reverse().find((o) => o.eliminated);
      if (lastOut) this.finalTribalLeader = lastOut.player;
    }
    return outcomes;
  }

  /**
   * Per the official rules, an eliminated player's hand goes to whoever holds
   * their Inheritance card, otherwise it is discarded. Called once all of a
   * council's vote-outs have landed: heirs are decided before any hands move,
   * and nobody eliminated at the same council can inherit.
   */
  settleEliminatedHands(eliminated: Player[]): HandSettlement[] {
    const heirs = eliminated.map((player) =>
      this.players.find(
        (p) =>
          p.isAlive() &&
          p.hand.some((card) => card.inheritancePlayer === player),
      ),
    );
    return eliminated.map((player, i) => {
      const cards = player.hand;
      player.hand = [];
      const heir = heirs[i];
      if (!heir) {
        return { player, inheritedCards: [], discardedCount: cards.length };
      }
      const inheritanceIndex = heir.hand.findIndex(
        (card) => card.inheritancePlayer === player,
      );
      if (inheritanceIndex !== -1) heir.hand.splice(inheritanceIndex, 1); // played
      heir.hand.push(...cards);
      return { player, heir, inheritedCards: cards, discardedCount: 0 };
    });
  }

  /** Posts a public message in the game's channel. */
  async announce(payload: string | MessageCreateOptions): Promise<Message | null> {
    if (!this.channel) return null;
    try {
      return await this.channel.send(payload);
    } catch (error) {
      console.error("Failed to post game announcement:", error);
      return null;
    }
  }

  /** Players in the game, the lobby host, and server managers can end or reset it. */
  canManage(interaction: ChatInputCommandInteraction): boolean {
    return (
      this.players.some((player) => player.id === interaction.user.id) ||
      this.lobby?.hostId === interaction.user.id ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true
    );
  }
}

const Game = new GameManager();

export { Game, GameManager, TribalCouncilState };
export type {
  ActionRules,
  ActionCheck,
  VoteOutOutcome,
  HandSettlement,
  InterruptionOutcome,
};
