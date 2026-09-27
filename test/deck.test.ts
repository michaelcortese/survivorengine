import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Deck from "../src/game/deck";
import Player from "../src/game/player";
import { CardName, HIGH_VALUE_CARDS } from "../src/game/cards";
import { cards } from "../src/game/cardlist.json";

const ACTION_CARD_TOTAL = cards.reduce((total, card) => total + card.quantity, 0);

function buildGameDeck(playerCount: number): Deck {
  const players = Array.from({ length: playerCount }, (_, i) => new Player(String(i), `P${i}`));
  const deck = new Deck();
  deck.addInheritanceCards(players);
  deck.shuffle();
  for (let i = 0; i < playerCount * 3; i++) deck.drawCard();
  deck.shuffle();
  deck.addAndDisperseTribalCouncilCards(playerCount);
  return deck;
}

describe("Deck", () => {
  it("builds one object per card copy", () => {
    const deck = new Deck();
    const all = deck.peekAll();
    assert.equal(all.length, ACTION_CARD_TOTAL);
    assert.equal(new Set(all).size, all.length);
  });

  it("every card name in cardlist.json has a CardName constant", () => {
    const known = new Set<string>(Object.values(CardName));
    for (const card of cards) assert.ok(known.has(card.name), `${card.name} is missing`);
  });

  it("adds one Inheritance card per player, tied to that player", () => {
    const players = [new Player("1", "Ann"), new Player("2", "Bob")];
    const deck = new Deck();
    deck.addInheritanceCards(players);
    const inheritance = deck.peekAll().filter((card) => card.inheritancePlayer);
    assert.deepEqual(
      inheritance.map((card) => [card.getName(), card.inheritancePlayer]),
      [
        ["Inheritance: Ann", players[0]],
        ["Inheritance: Bob", players[1]],
      ],
    );
    assert.ok(inheritance.every((card) => card.compactDescription && card.compactDescription.length <= 100));
  });

  for (const playerCount of [3, 4, 5, 6]) {
    it(`deals enough vote-outs to reach the final two with ${playerCount} players`, () => {
      const plan = Deck.tribalCouncilPlan(playerCount, 0.5);
      assert.equal(plan.singles + plan.doubles, playerCount - 1);
      assert.ok(plan.singles + 2 * plan.doubles >= 2 * (playerCount - 2));
    });

    it(`places ${playerCount - 1} Tribal Councils with a mix of doubles, one at the bottom (${playerCount} players)`, () => {
      const deck = buildGameDeck(playerCount);
      const tribals = deck.peekAll().filter((card) => card.getName() === CardName.TribalCouncil);
      const plan = Deck.tribalCouncilPlan(playerCount, 0.5);
      assert.equal(tribals.length, playerCount - 1);
      assert.equal(tribals.filter((card) => card.tribalValue === 2).length, plan.doubles);
      assert.equal(tribals.filter((card) => card.tribalValue === 1).length, plan.singles);
      // The last card drawn is always a Tribal Council (official setup)
      assert.equal(deck.peekAll()[0].getName(), CardName.TribalCouncil);
      assert.equal(deck.getTribalCouncilCount(), playerCount - 1);
    });
  }

  it("still upgrades singles to doubles when the ratio is too low to finish", () => {
    const plan = Deck.tribalCouncilPlan(6, 0);
    assert.ok(plan.singles + 2 * plan.doubles >= 8);
  });

  it("reports draws until each Tribal Council, soonest first", () => {
    const deck = buildGameDeck(4);
    const draws = deck.getDrawsUntilNextTribalCouncil();
    assert.equal(draws.length, 3);
    for (const distance of draws) {
      const card = deck.peekAll()[deck.getCardCount() - distance];
      assert.equal(card.getName(), CardName.TribalCouncil);
    }
    assert.deepEqual([...draws].sort((a, b) => a - b), draws);
  });

  it("shuffling keeps every card", () => {
    const deck = new Deck();
    const before = deck.peekAll().map((card) => card.getName()).sort();
    deck.shuffle();
    assert.deepEqual(deck.peekAll().map((card) => card.getName()).sort(), before);
  });

  it("spreads high-value cards through the deck without a fixed order", () => {
    const firstDrawn = new Set<string>();
    for (let round = 0; round < 60; round++) {
      const deck = new Deck();
      deck.shuffle();
      const topDown = [...deck.peekAll()].reverse();
      const positions = topDown
        .map((card, index) => (HIGH_VALUE_CARDS.includes(card.getName()) ? index : -1))
        .filter((index) => index >= 0);
      firstDrawn.add(topDown[positions[0]].getName());

      // One high-value card per equal slice: gaps can't exceed two slices.
      const slice = Math.ceil(topDown.length / positions.length);
      for (let i = 1; i < positions.length; i++) {
        assert.ok(positions[i] - positions[i - 1] <= slice * 2);
      }
    }
    // It used to be "I'm the Leader Now" every single game.
    assert.ok(firstDrawn.size >= 3, `only saw ${[...firstDrawn].join(", ")}`);
  });

  it("keeps copies of the same card apart", () => {
    let worstGap = Infinity;
    for (let round = 0; round < 30; round++) {
      const deck = new Deck();
      deck.shuffle();
      const idols = deck
        .peekAll()
        .map((card, index) => (card.getName() === CardName.ImmunityIdol ? index : -1))
        .filter((index) => index >= 0);
      for (let i = 1; i < idols.length; i++) worstGap = Math.min(worstGap, idols[i] - idols[i - 1]);
    }
    // Four idols in a ~47 card deck should essentially never be adjacent
    assert.ok(worstGap >= 2, `idols ended up ${worstGap} apart`);
  });
});
