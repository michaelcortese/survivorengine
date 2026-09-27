import Card from "./card";
import { cards } from "./cardlist.json";
import type Player from "./player";
import { CardName, HIGH_VALUE_CARDS, inheritanceCardName } from "./cards";
import { GameConfig } from "./config";

interface DeckConfig {
  doubleTribalsRatio: number; // 0.0 to 1.0 (e.g., 0.5 = 50% double, 50% single)
}

const TRIBAL_COUNCIL_IMAGE = "https://i.imgur.com/DG0IZxh.png";
const INHERITANCE_IMAGE = "https://i.imgur.com/DG0IZxh.png";

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Orders cards so the copies of each card are spread evenly across the
 * sequence (e.g. the four idols land about a quarter apart). Each card type
 * gets its own random starting point, so the order is different every game.
 */
function spreadCopiesApart(cardsToSpread: Card[]): Card[] {
  const byName = new Map<string, Card[]>();
  for (const card of cardsToSpread) {
    const copies = byName.get(card.getName()) ?? [];
    copies.push(card);
    byName.set(card.getName(), copies);
  }
  const keyed: { card: Card; key: number }[] = [];
  for (const copies of byName.values()) {
    const offset = Math.random();
    copies.forEach((card, i) => {
      const jitter = (Math.random() - 0.5) * 0.2;
      keyed.push({ card, key: (i + offset + jitter) / copies.length });
    });
  }
  return keyed.sort((a, b) => a.key - b.key).map(({ card }) => card);
}

/**
 * Splits cards into `count` piles of roughly equal size (like splitting a real
 * deck by eye), so Tribal Councils aren't perfectly evenly spaced.
 */
function splitIntoPiles(cardsToSplit: Card[], count: number): Card[][] {
  const pileSize = cardsToSplit.length / count;
  const jitter = Math.floor(pileSize * 0.2);
  const cuts = [0];
  for (let i = 1; i < count; i++) {
    const offset = Math.floor(Math.random() * (jitter * 2 + 1)) - jitter;
    const cut = Math.round(i * pileSize) + offset;
    cuts.push(Math.min(cardsToSplit.length, Math.max(cuts[i - 1], cut)));
  }
  cuts.push(cardsToSplit.length);
  return Array.from({ length: count }, (_, i) =>
    cardsToSplit.slice(cuts[i], cuts[i + 1]),
  );
}

class Deck {
  /** Index 0 is the bottom of the draw pile; drawCard() takes from the end. */
  private cards: Card[];
  private config: DeckConfig;

  constructor(
    config: DeckConfig = { doubleTribalsRatio: GameConfig.doubleTribalRatio },
  ) {
    this.cards = [];
    this.config = config;
    for (const cardData of cards) {
      for (let i = 0; i < cardData.quantity; i++) {
        // Every copy gets its own object so per-card state never leaks between copies.
        this.cards.push(
          new Card(
            cardData.name,
            cardData.description,
            cardData.compactDescription,
            cardData.imageUrl,
          ),
        );
      }
    }
  }

  /** One Inheritance card per player: whoever holds it gets that player's hand when they're eliminated. */
  addInheritanceCards(players: Player[]) {
    for (const player of players) {
      const card = new Card(
        inheritanceCardName(player.username),
        `If ${player.username} is eliminated, you inherit every card in their hand instead of it being discarded. This is played automatically.`,
        `If ${player.username} is eliminated, you get their whole hand (automatic).`,
        INHERITANCE_IMAGE,
        undefined,
        player,
      );
      this.cards.push(card);
    }
  }

  /** How many single and double Tribal Council cards a game of this size uses. */
  static tribalCouncilPlan(
    playerCount: number,
    doubleRatio: number,
  ): { singles: number; doubles: number } {
    const total = Math.max(1, playerCount - 1);
    const ratio = Math.min(1, Math.max(0, doubleRatio));
    let doubles = Math.round(total * ratio);
    // Getting down to the final two takes at least two vote-outs for every
    // player who goes home, so make sure the deck can deliver that many.
    const minimumVoteOuts = GameConfig.livesPerPlayer * Math.max(0, playerCount - 2);
    while (total + doubles < minimumVoteOuts && doubles < total) {
      doubles++;
    }
    return { singles: total - doubles, doubles };
  }

  /**
   * Official setup: split the action cards into one pile per Tribal Council
   * card, then stack Tribal Council, pile, Tribal Council, pile, ... so the last
   * card in the draw pile is always a Tribal Council.
   */
  addAndDisperseTribalCouncilCards(playerCount: number) {
    const { singles, doubles } = Deck.tribalCouncilPlan(
      playerCount,
      this.config.doubleTribalsRatio,
    );
    const tribalCards = shuffleInPlace([
      ...Array.from({ length: doubles }, () => this.createTribalCouncilCard(2)),
      ...Array.from({ length: singles }, () => this.createTribalCouncilCard(1)),
    ]);

    const piles = splitIntoPiles(this.cards, tribalCards.length);
    this.cards = [];
    tribalCards.forEach((tribalCard, i) => {
      this.cards.push(tribalCard, ...piles[i]);
    });
  }

  private createTribalCouncilCard(tribalValue: 1 | 2): Card {
    return new Card(
      CardName.TribalCouncil,
      tribalValue === 2
        ? "Double Tribal Council: the two players with the most votes are voted out."
        : "Tribal Council: the player with the most votes is voted out.",
      null,
      TRIBAL_COUNCIL_IMAGE,
      tribalValue,
      undefined,
    );
  }

  addCard(card: Card) {
    this.cards.push(card);
  }

  /**
   * Shuffles the deck, then spreads the high-value cards (idols, extra votes,
   * tribal advantages) evenly through it: one per equal slice of the deck, at a
   * random spot inside the slice. This prevents clusters of idols early or
   * late without making the order predictable.
   */
  shuffle() {
    const highValueCards = spreadCopiesApart(
      this.cards.filter((card) => HIGH_VALUE_CARDS.includes(card.getName())),
    );
    const regularCards = shuffleInPlace(
      this.cards.filter((card) => !HIGH_VALUE_CARDS.includes(card.getName())),
    );

    const total = this.cards.length;
    const highValueSlots = new Set<number>();
    for (let i = 0; i < highValueCards.length; i++) {
      const start = Math.floor((i * total) / highValueCards.length);
      const end = Math.floor(((i + 1) * total) / highValueCards.length);
      highValueSlots.add(start + Math.floor(Math.random() * (end - start)));
    }

    let nextHighValue = 0;
    let nextRegular = 0;
    this.cards = Array.from({ length: total }, (_, position) =>
      highValueSlots.has(position)
        ? highValueCards[nextHighValue++]
        : regularCards[nextRegular++],
    );
  }

  drawCard(): Card | undefined {
    return this.cards.pop();
  }

  getCardCount() {
    return this.cards.length;
  }

  setConfig(config: Partial<DeckConfig>) {
    this.config = { ...this.config, ...config };
  }

  getConfig(): DeckConfig {
    return this.config;
  }

  /** Number of draws until each remaining Tribal Council, soonest first. */
  getDrawsUntilNextTribalCouncil(): number[] {
    // Since drawCard() uses pop(), we need to search from the end of the array
    const drawsUntilNextTribalCouncil = [];
    for (let i = this.cards.length - 1; i >= 0; i--) {
      if (this.cards[i].getName() === CardName.TribalCouncil) {
        // Distance from the end (since we pop from the end)
        drawsUntilNextTribalCouncil.push(this.cards.length - i);
      }
    }
    return drawsUntilNextTribalCouncil;
  }

  getTribalCouncilCount(): number {
    return this.cards.filter((card) => card.getName() === CardName.TribalCouncil)
      .length;
  }

  /** Read-only view of the draw pile, top card last. For tests and debugging. */
  peekAll(): readonly Card[] {
    return this.cards;
  }
}

export default Deck;
