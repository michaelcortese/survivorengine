import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Player from "../src/game/player";
import {
  LEGENDARY_CASTAWAYS,
  pickRandomCastaways,
  sanitizeCastawayName,
  searchLegendaryCastaways,
} from "../src/game/castaways";

describe("castaway names", () => {
  it("strips markdown, mentions and pings", () => {
    assert.equal(sanitizeCastawayName("**Boston** @everyone <@123> `Rob`"), "Boston everyone 123 Rob");
    assert.equal(sanitizeCastawayName("  Sandra   Diaz-Twine "), "Sandra Diaz-Twine");
  });

  it("keeps accents and normal punctuation", () => {
    assert.equal(sanitizeCastawayName("Ricard Foyé"), "Ricard Foyé");
    assert.equal(sanitizeCastawayName("J.T. Thomas"), "J.T. Thomas");
    assert.equal(sanitizeCastawayName("Kelly O'Brien"), "Kelly O'Brien");
  });

  it("limits names to 40 characters", () => {
    assert.equal(sanitizeCastawayName("x".repeat(80)).length, 40);
  });

  it("returns an empty name when nothing usable is left", () => {
    assert.equal(sanitizeCastawayName("**__~~``"), "");
  });

  it("has no duplicate legends", () => {
    const lower = LEGENDARY_CASTAWAYS.map((name) => name.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
    for (const name of LEGENDARY_CASTAWAYS) assert.equal(sanitizeCastawayName(name), name);
  });

  it("picks unique random legends and avoids names already taken", () => {
    const taken = ["Parvati Shallow", "boston rob mariano"];
    const picks = pickRandomCastaways(20, taken);
    assert.equal(picks.length, 20);
    assert.equal(new Set(picks).size, 20);
    assert.ok(!picks.includes("Parvati Shallow"));
    assert.ok(!picks.includes("Boston Rob Mariano"));
  });

  it("suggests legends by any part of the name", () => {
    assert.equal(searchLegendaryCastaways("parv")[0], "Parvati Shallow");
    assert.ok(searchLegendaryCastaways("rob").includes("Boston Rob Mariano"));
    assert.ok(searchLegendaryCastaways("").length <= 25);
  });
});

describe("Player lives", () => {
  it("starts with two castaways, and #1 is voted out first", () => {
    const player = new Player("1", "Ann", ["Parvati Shallow", "Sandra Diaz-Twine"]);
    assert.equal(player.lives, 2);
    assert.ok(player.isAlive());

    const first = player.loseLife(1);
    assert.equal(first?.name, "Parvati Shallow");
    assert.equal(first?.lostAtTribal, 1);
    assert.equal(player.lives, 1);
    assert.ok(player.isAlive());

    const second = player.loseLife(3);
    assert.equal(second?.name, "Sandra Diaz-Twine");
    assert.equal(player.lives, 0);
    assert.ok(!player.isAlive());
    assert.equal(player.loseLife(4), undefined);
  });

  it("marks castaways the player didn't pick", () => {
    const player = new Player("1", "Ann", [undefined, "Cirie Fields"]);
    assert.deepEqual(
      player.castaways.map((c) => [c.name, c.chosen]),
      [
        ["Castaway 1", false],
        ["Cirie Fields", true],
      ],
    );
  });

  it("finds and removes cards by name", () => {
    const player = new Player("1", "Ann");
    assert.equal(player.removeCard("Extra Vote"), undefined);
  });
});
