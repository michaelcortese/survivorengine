import Card from "./card";
import { cards } from "./cardlist.json";
import Player from "./player";

interface DeckConfig {
  doubleTribalsRatio: number; // 0.0 to 1.0 (e.g., 0.5 = 50% double, 50% single)
}

class Deck {
  private cards: Card[];
  private highValueCardNames = [
    "Immunity Idol",
    "Idol Nullifier",
    "Extra Vote",
    "Tribal Advantage: Control the Vote",
    "Tribal Advantage: Goodwill Gamble",
    "Tribal Advantage: I'm the Leader Now",
  ];
  private config: DeckConfig;

  constructor(config: DeckConfig = { doubleTribalsRatio: 0.5 }) {
    this.cards = [];
    this.config = config;
    for (const cardData of cards) {
      const card = new Card(
        cardData.name,
        cardData.description,
        cardData.compactDescription,
        cardData.imageUrl,
      );
      for (let i = 0; i < cardData.quantity; i++) {
        this.cards.push(card);
      }
    }
  }

  // TODO: Add card description and functionality for Inheritance
  addInheritanceCards(players: Player[]) {
    const description = null; // TODO add Inheritance description
    // Not a tribal related card
    const tribalVotes = undefined;
    for (const player of players) {
      const card = new Card(
        `Inheritance: ${player.username}`,
        description,
        null,
        "https://i.imgur.com/DG0IZxh.png",
        tribalVotes,
        player,
      );
      this.cards.push(card);
    }
  }

  addAndDisperseTribalCouncilCards(playerCount: number) {
    const deckSize = this.cards.length;
    
    // Determine how many double vs single tribals to add
    const totalTribalCards = playerCount - 1; // One less than player count to ensure final 3
    const doubleTribalsCount = Math.round(totalTribalCards * this.config.doubleTribalsRatio);
    const singleTribalsCount = totalTribalCards - doubleTribalsCount;
    
    const tribalCards: Array<{ name: string; type: "single" | "double" }> = [];
    for (let i = 0; i < doubleTribalsCount; i++) {
      tribalCards.push({ name: "Tribal Council", type: "double" });
    }
    for (let i = 0; i < singleTribalsCount; i++) {
      tribalCards.push({ name: "Tribal Council", type: "single" });
    }
    
    const segmentSize = Math.floor(deckSize / tribalCards.length);
    const randomRange = Math.min(5, Math.floor(segmentSize / 3));
    const description = "";
    
    for (let i = 0; i < tribalCards.length; i++) {
      const card = new Card(
        `Tribal Council`,
        description,
        null,
        "https://i.imgur.com/DG0IZxh.png",
        1,
        undefined,
      );

      // Calculate the ideal position for even distribution
      const idealPosition = (i + 0.5) * segmentSize;

      // Add randomness within a limited range
      const randomOffset =
        Math.floor(Math.random() * (randomRange * 2 + 1)) - randomRange;
      const actualPosition = Math.max(
        0,
        Math.min(deckSize - 1 + i, Math.floor(idealPosition + randomOffset)),
      );

      this.cards.splice(actualPosition, 0, card);
    }
  }

  addCard(card: Card) {
    this.cards.push(card);
  }

  shuffle() {
    // Separate high-value and regular cards
    const highValueCards: Card[] = [];
    const regularCards: Card[] = [];

    for (const card of this.cards) {
      if (this.highValueCardNames.includes(card.getName())) {
        highValueCards.push(card);
      } else {
        regularCards.push(card);
      }
    }

    // Shuffle regular cards
    for (let i = regularCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [regularCards[i], regularCards[j]] = [regularCards[j], regularCards[i]];
    }

    // Distribute high-value cards evenly throughout the deck
    // This prevents clustering of multiple idols in early/late game
    const segmentSize = Math.ceil(regularCards.length / (highValueCards.length + 1));
    this.cards = [];

    for (let i = 0; i < highValueCards.length; i++) {
      // Add a segment of regular cards
      const startIdx = i * segmentSize;
      const endIdx = Math.min((i + 1) * segmentSize, regularCards.length);
      this.cards.push(...regularCards.slice(startIdx, endIdx));

      // Add a high-value card
      this.cards.push(highValueCards[i]);
    }

    // Add any remaining regular cards at the end
    if (this.cards.length < regularCards.length + highValueCards.length) {
      const remaining = regularCards.length - this.cards.filter(c => 
        !this.highValueCardNames.includes(c.getName())
      ).length;
      if (remaining > 0) {
        const startIdx = highValueCards.length * segmentSize;
        this.cards.push(...regularCards.slice(startIdx));
      }
    }
  }

  drawCard(): Card | undefined {
    let cardDrawn = this.cards.pop();
    // if (!cardDrawn) return undefined;
    return cardDrawn;
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

  getDrawsUntilNextTribalCouncil(): number[] {
    // Since drawCard() uses pop(), we need to search from the end of the array
    const drawsUntilNextTribalCouncil = [];
    for (let i = this.cards.length - 1; i >= 0; i--) {
      if (this.cards[i].getName() === "Tribal Council") {
        // Distance from the end (since we pop from the end)
        drawsUntilNextTribalCouncil.push(this.cards.length - i);
      }
    }
    // No tribal council found
    return drawsUntilNextTribalCouncil;
  }
}

export default Deck;
