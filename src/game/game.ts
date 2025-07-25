import Deck from "./deck";
import Player from "./player";
import Card from "./card";

import { ChatInputCommandInteraction, InteractionResponse } from "discord.js";

const CARDS_PER_PLAYER = 3;
// When changing, also change in steal_random.ts
// TODO: Make this a config variable
const INTERRUPT_WAIT_TIME = 1000 * 15; // 15 seconds

/**
 * Interface for any kind of interaction that can be interupted with a "Sorry for You" card
 * TODO: see if we can make this work with idol nullifier
 */
interface Interruption {
  active: boolean;
  target: Player | null;
  sender: Player | null;
  stopped: boolean; // Indicates if the interruption was stopped
}

enum TribalCouncilState {
  NotStarted,
  Discussion,
  Voting,
  Immunity,
  Nullify,
  Reading,
}

interface GameState {
  active: boolean;
  interruption: Interruption;
  players: Player[];
  currentPlayerIndex: number;
  deck: Deck;
  interruptionTimeoutId: NodeJS.Timeout | null;
  tribalCouncilState: TribalCouncilState;
  tribalCouncilLeader: Player | null;
  startGame: (players: Player[]) => void;
  updatePlayerHand: (playerId: string, card: Card) => void;
  getPlayer: (username: string) => Player | undefined;
  getPlayerFromUserId: (userId: string) => Player | undefined;
  nextPlayer: () => Player | undefined;
  startCooldown: (sender: Player, target: Player) => void;
  stopInterruption: () => void;
  checkForError: (
    interaction: ChatInputCommandInteraction,
    hasTarget: boolean,
    requiredCard: string | null,
    interruptable: boolean,
    stoppingInteraction?: boolean,
    canPlayDuringTribalCouncil?: boolean,
  ) =>
    | { error: { content: string; ephemeral: boolean } }
    | { player: Player; targetPlayer?: Player };
}

const Game: GameState = {
  active: false,
  interruption: {
    active: false,
    target: null,
    sender: null,
    stopped: false,
  },
  players: [],
  currentPlayerIndex: 0,
  deck: new Deck(),
  interruptionTimeoutId: null,
  tribalCouncilState: TribalCouncilState.NotStarted,
  tribalCouncilLeader: null,

  startGame(players: Player[]): void {
    this.active = true;
    this.currentPlayerIndex = 0;
    this.deck.addInheritanceCards(players);
    this.deck.shuffle();
    this.players = players;

    // Deal initial hands to players
    for (const player of this.players) {
      player.hand = [];
      for (let i = 0; i < CARDS_PER_PLAYER; i++) {
        const card = this.deck.drawCard();
        if (card) {
          player.hand.push(card);
        } else {
          console.error("Not enough cards in the deck!");
        }
      }
    }

    console.log("Game started!");
  },

  updatePlayerHand(playerId: string, card: Card): void {
    const player = this.getPlayerFromUserId(playerId);
    if (player) {
      player.hand.push(card);
    } else {
      console.error(`Player with ID ${playerId} not found.`);
    }
  },

  getPlayer(username: string): Player | undefined {
    return this.players.find((player) => player.username === username);
  },

  getPlayerFromUserId(userId: string): Player | undefined {
    return this.players.find((player) => player.id === userId);
  },

  nextPlayer(): Player | undefined {
    if (!this.active) {
      console.error("Game is not active!");
      return undefined;
    }
    this.currentPlayerIndex =
      (this.currentPlayerIndex + 1) % this.players.length;
    return this.players[this.currentPlayerIndex];
  },

  startCooldown: (sender: Player, target: Player) => {
    Game.interruption.active = true;
    Game.interruption.sender = sender;
    Game.interruption.target = target;
    Game.interruption.stopped = false;

    Game.interruptionTimeoutId = setTimeout(() => {
      Game.interruption.active = false;
      Game.interruption.sender = null;
      Game.interruption.target = null;
      Game.interruption.stopped = false;
      Game.interruptionTimeoutId = null;
    }, INTERRUPT_WAIT_TIME);
  },

  stopInterruption: () => {
    if (Game.interruptionTimeoutId) {
      clearTimeout(Game.interruptionTimeoutId);
      Game.interruptionTimeoutId = null;
    }
    Game.interruption.active = false;
    Game.interruption.sender = null;
    Game.interruption.target = null;
    Game.interruption.stopped = true;
  },

  /**
   * This is why card games should not be implemented in code.
   * @param interaction
   * @param hasTarget
   * @param requiredCard
   * @param interruptable
   * @param stoppingInteraction
   * @param canPlayDuringTribalCouncil
   * @returns
   */
  checkForError(
    interaction,
    hasTarget,
    requiredCard,
    interruptable,
    stoppingInteraction = false,
    canPlayDuringTribalCouncil = false,
  ) {
    if (!Game.active) {
      return {
        error: {
          content: "No game is currently in progress!",
          ephemeral: true,
        },
      };
    }

    const player = Game.getPlayerFromUserId(interaction.user.id);
    if (!player) {
      return {
        error: {
          content: "You are not a player in the current game!",
          ephemeral: true,
        },
      };
    }

    let targetPlayer: Player | undefined;
    if (hasTarget) {
      const targetUserId =
        interaction.options.getUser("player")?.id ||
        interaction.options.getUser("target")?.id;
      if (!targetUserId) {
        return {
          error: {
            content: "You must specify a target player!",
            ephemeral: true,
          },
        };
      }
      targetPlayer = Game.getPlayerFromUserId(targetUserId);
      if (!targetPlayer) {
        return {
          error: {
            content: "The specified player is not in the game!",
            ephemeral: true,
          },
        };
      }
    }
    // TODO: i fucking cant with these booleans
    if (
      !canPlayDuringTribalCouncil &&
      Game.tribalCouncilState !== TribalCouncilState.NotStarted
    ) {
      return {
        error: {
          content: "This action cannot be played during the tribal council!",
          ephemeral: true,
        },
      };
    }

    if (interruptable && Game.interruption.active) {
      return {
        error: {
          content:
            "This action cannot be played at this time. Wait a moment and try again.",
          ephemeral: true,
        },
      };
    }

    if (stoppingInteraction && !Game.interruption.active) {
      return {
        error: { content: "There is no interaction to stop!", ephemeral: true },
      };
    }

    // Remove card if they have it and error if not

    if (requiredCard && !player.hasCard(requiredCard)) {
      return {
        error: {
          content: `You must have the ${requiredCard} card to play this action!`,
          ephemeral: true,
        },
      };
    } else if (requiredCard && player.hasCard(requiredCard)) {
      player.removeCard(requiredCard);
    }

    // Success case - return player references
    return hasTarget ? { player, targetPlayer: targetPlayer! } : { player };
  },
};

export { Game, TribalCouncilState };
