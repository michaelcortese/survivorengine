class Card {
    public name: string;
    public description: string | null;
    public imageUrl: string | null;

    constructor(name: string, description: string | null = null, imageUrl: string | null = null) {
        this.name = name;
        this.description = description;
        this.imageUrl = imageUrl;
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