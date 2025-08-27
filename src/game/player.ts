import Card from "./card";

class Player {
  public id: string;
  public username: string;
  public hand: Card[];
  public lives: number;
  public votes: number;
  public isActive: boolean;
  public campRaid?: Player;

  constructor(id: string, username: string) {
    this.id = id; // The ID of the user
    this.username = username; // The username of the player, can be set later
    //this.gameId = gameId; // The ID of the game this player is in
    this.hand = []; // The player's hand of cards
    this.lives = 2;
    this.votes = 0; // The number of votes the player has
    this.isActive = true; // Whether the player is currently active in the game
  }

  // Method to set the username of the player
  setUsername(username: string): void {
    this.username = username;
  }

  hasCard(cardName: string): boolean {
    return this.hand.some((card) => card.getName() === cardName);
  }

  removeCard(cardName: string): void {
    const cardIndex = this.hand.findIndex(
      (card) => card.getName() === cardName,
    );
    if (cardIndex !== -1) {
      this.hand.splice(cardIndex, 1);
    }
  }

  isAlive(): boolean {
    return this.lives > 0;
  }
}

export default Player;
