import Player from "./player";
class Card {
  public name: string;
  public description: string | null;
  public compactDescription: string | null;
  public imageUrl: string | null;
  public tribalValue?: number;
  public inheritancePlayer?: Player;

  constructor(
    name: string,
    description: string | null = null,
    compactDescription: string | null = null,
    imageUrl: string | null = null,
    tribalValue?: number,
    inheritancePlayer?: Player,
  ) {
    this.name = name;
    this.description = description;
    this.compactDescription = compactDescription;
    this.imageUrl = imageUrl;
    this.tribalValue = tribalValue;
    this.inheritancePlayer = inheritancePlayer;
  }

  hasImage(): boolean {
    return !!this.imageUrl;
  }

  getImage(): string | null {
    return this.imageUrl;
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string | null {
    return this.description;
  }
}

export default Card;
