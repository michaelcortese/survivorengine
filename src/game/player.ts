import type Card from "./card";
import { Castaway } from "./castaways";
import { GameConfig } from "./config";

class Player {
  public id: string;
  public username: string;
  public hand: Card[];
  public votes: number;
  public campRaid?: Player;
  /** The player's Survivor Character Cards. Each vote-out turns one over. */
  public castaways: Castaway[];
  /** Tribe color shown on the board. */
  public color: string;
  /** Discord avatar URL; downloaded lazily when the board is drawn. */
  public avatarUrl?: string;
  /** Cached avatar bytes: undefined = not fetched yet, null = unavailable. */
  public avatar?: Buffer | null;

  constructor(
    id: string,
    username: string,
    castawayNames: (string | undefined)[] = [],
  ) {
    this.id = id; // The ID of the user
    this.username = username;
    this.hand = []; // The player's hand of cards
    this.votes = 0; // The number of votes the player has at the current Tribal Council
    this.color = "#888888";
    this.castaways = Array.from({ length: GameConfig.livesPerPlayer }, (_, i) => ({
      name: castawayNames[i] ?? `Castaway ${i + 1}`,
      lost: false,
      chosen: castawayNames[i] !== undefined,
    }));
  }

  /** Castaways still in the game. */
  get lives(): number {
    return this.castaways.filter((castaway) => !castaway.lost).length;
  }

  setUsername(username: string): void {
    this.username = username;
  }

  hasCard(cardName: string): boolean {
    return this.hand.some((card) => card.getName() === cardName);
  }

  /** Case-insensitive lookup, for card names typed by players. */
  findCard(cardName: string): Card | undefined {
    const wanted = cardName.trim().toLowerCase();
    return this.hand.find((card) => card.getName().toLowerCase() === wanted);
  }

  /** Removes one copy of the card and returns it, if the player has it. */
  removeCard(cardName: string): Card | undefined {
    const cardIndex = this.hand.findIndex(
      (card) => card.getName() === cardName,
    );
    if (cardIndex === -1) return undefined;
    return this.hand.splice(cardIndex, 1)[0];
  }

  /** Removes a random card and returns it, if the player has any. */
  removeRandomCard(): Card | undefined {
    if (this.hand.length === 0) return undefined;
    const index = Math.floor(Math.random() * this.hand.length);
    return this.hand.splice(index, 1)[0];
  }

  isAlive(): boolean {
    return this.lives > 0;
  }

  /**
   * Turns over the next castaway still in the game (castaway #1 goes first)
   * and returns it.
   */
  loseLife(tribalNumber?: number): Castaway | undefined {
    const castaway = this.castaways.find((c) => !c.lost);
    if (castaway) {
      castaway.lost = true;
      castaway.lostAtTribal = tribalNumber;
    }
    return castaway;
  }
}

export default Player;
