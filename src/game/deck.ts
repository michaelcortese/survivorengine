import Card from "./card";
import { cards } from "./cardlist.json";
import Player from "./player";

class Deck {
  private cards: Card[];
  constructor() {
    this.cards = [];
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
    const description = null;
    // Not a tribal related card
    const tribalVotes = undefined;
    for (const player of players) {
      const card = new Card(
        `Inheritance: ${player.username}`,
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
    const segmentSize = Math.floor(deckSize / playerCount);
    const randomRange = Math.min(5, Math.floor(segmentSize / 3)); // Max 5 cards or 1/3 of segment size

    for (let i = 0; i < playerCount; i++) {
      const card = new Card(
        `Tribal Council`,
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
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
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
