import Card from './card';
import { cards } from './cardlist.json';
import Player from './player';


class Deck {
    private cards: Card[];
    constructor() {
        this.cards = [];
        for (const cardData of cards) {
            const card = new Card(cardData.name, cardData.description, cardData.imageUrl);
            for (let i = 0; i < cardData.quantity; i++) {
                this.cards.push(card);
            }
        }
    }

    addInheritanceCards(players: Player[]) {
        for (const player of players) {
            const card = new Card(`Inheritance: ${player.username}`, null, "https://i.imgur.com/DG0IZxh.png");
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

    drawCard(): Card | undefined {
        return this.cards.pop();
    }

    getCardCount() {
        return this.cards.length;
    }
}

export default Deck;