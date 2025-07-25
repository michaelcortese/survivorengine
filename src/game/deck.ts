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
        cardData.imageUrl,
      );
      for (let i = 0; i < cardData.quantity; i++) {
        this.cards.push(card);
      }
    }
  }

  // TODO: Add card description and functionality for Inheritance
  addInheritanceCards(players: Player[]) {
    for (const player of players) {
      const card = new Card(
        `Inheritance: ${player.username}`,
        null,
        "https://i.imgur.com/DG0IZxh.png",
      );
      this.cards.push(card);
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

  disperseTribalCouncilCards(numberOfPlayers: number) {
    // TODO implement
  }

  drawCard(): Card | undefined {
    let cardDrawn = this.cards.pop();
    // if (!cardDrawn) return undefined;
    return cardDrawn;
  }

  getCardCount() {
    return this.cards.length;
  }
}

export default Deck;
