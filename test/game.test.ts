import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Game, TribalCouncilState } from "../src/game/game";
import Player from "../src/game/player";
import Card from "../src/game/card";
import { CardName, inheritanceCardName } from "../src/game/cards";
import { GameConfig } from "../src/game/config";
import { Lobby } from "../src/game/lobby";
import { useFastTimings } from "./helpers/discord_fakes";
import { startTestGame, takeLife } from "./helpers/game_setup";

useFastTimings();

function card(name: string, inheritancePlayer?: Player) {
  return new Card(name, null, null, null, undefined, inheritancePlayer);
}

describe("starting a game", () => {
  beforeEach(() => Game.reset());

  it("deals three cards each and builds a fresh deck", () => {
    const { players } = startTestGame(4);
    for (const player of players) assert.equal(player.hand.length, GameConfig.cardsPerPlayer);
    assert.equal(Game.deck.getTribalCouncilCount(), 3);
    assert.ok(Game.active);
    assert.equal(Game.currentPlayer(), players[0]);
  });

  it("keeps chosen castaways and fills the rest with unique legends", () => {
    const picked = new Player("1", "Ann", ["Parvati Shallow", undefined]);
    const random = new Player("2", "Bob");
    const third = new Player("3", "Cat", ["Kim Spradlin", "Tony Vlachos"]);
    Game.startGame([picked, random, third], { shuffleSeats: false });
    assert.equal(picked.castaways[0].name, "Parvati Shallow");
    assert.notEqual(picked.castaways[1].name, "Castaway 2");
    const names = Game.players.flatMap((p) => p.castaways.map((c) => c.name));
    assert.equal(new Set(names).size, names.length);
    assert.ok(Game.players.every((p) => p.castaways.every((c) => c.chosen)));
    assert.equal(new Set(Game.players.map((p) => p.color)).size, 3);
  });

  it("a second game gets a brand-new deck and clean state", () => {
    startTestGame(3);
    Game.deck.drawCard();
    Game.tribalCouncilCount = 4;
    const { players } = startTestGame(3);
    assert.equal(Game.tribalCouncilCount, 0);
    assert.equal(Game.winner, null);
    // 47 action cards + 3 inheritance - 9 dealt + 2 tribal councils
    assert.equal(Game.deck.getCardCount(), 47 + 3 - 9 + 2);
    assert.ok(players.every((p) => p.lives === 2));
  });

  it("reset closes an open lobby", () => {
    const lobby = new Lobby("1");
    let reason = "";
    lobby.setDisposer((why) => (reason = why));
    Game.lobby = lobby;
    Game.reset("Cancelled for a test.");
    assert.ok(lobby.closed);
    assert.equal(reason, "Cancelled for a test.");
    assert.equal(Game.lobby, null);
  });
});

describe("turns", () => {
  beforeEach(() => Game.reset());

  it("passes the turn to the next player still in the game", () => {
    const { players } = startTestGame(4);
    takeLife(players[1]);
    takeLife(players[1]);
    assert.equal(Game.advanceTurn(players[0]), players[2]);
    assert.equal(Game.advanceTurn(), players[3]);
    assert.equal(Game.advanceTurn(), players[0]);
  });

  it("setTurn skips to the next player if the chosen one is out", () => {
    const { players } = startTestGame(3);
    takeLife(players[2]);
    takeLife(players[2]);
    assert.equal(Game.setTurn(players[2]), players[0]);
  });
});

describe("validateAction", () => {
  beforeEach(() => Game.reset());

  it("blocks eliminated players unless the action allows the jury", () => {
    const game = startTestGame(3);
    takeLife(game.players[0]);
    takeLife(game.players[0]);
    const interaction = game.as(game.players[0]).asCommand();
    assert.ok("error" in Game.validateAction(interaction));
    assert.ok("player" in Game.validateAction(interaction, { allowEliminated: true }));
  });

  it("rejects targeting yourself or an eliminated player", () => {
    const game = startTestGame(3);
    const self = game.as(game.players[0], { player: game.userOf(game.players[0]) });
    assert.match(
      (Game.validateAction(self.asCommand(), { target: true }) as { error: string }).error,
      /yourself/,
    );
    takeLife(game.players[1]);
    takeLife(game.players[1]);
    const out = game.as(game.players[0], { player: game.userOf(game.players[1]) });
    assert.match(
      (Game.validateAction(out.asCommand(), { target: true }) as { error: string }).error,
      /voted out/,
    );
  });

  it("checks the Tribal Council phase", () => {
    const game = startTestGame(3);
    const interaction = game.as(game.players[0]).asCommand();
    const onlyVoting = { tribalCouncil: [TribalCouncilState.Voting] };
    assert.match((Game.validateAction(interaction, onlyVoting) as { error: string }).error, /outside/);
    Game.tribalCouncilState = TribalCouncilState.Voting;
    assert.ok("player" in Game.validateAction(interaction, onlyVoting));
    assert.ok("error" in Game.validateAction(interaction)); // default: not during Tribal Council
    Game.tribalCouncilState = TribalCouncilState.Reading;
    assert.ok("error" in Game.validateAction(interaction, onlyVoting));
  });

  it("checks for the required card without using it up", () => {
    const game = startTestGame(3);
    const player = game.players[0];
    player.hand = [card(CardName.CampRaid)];
    const interaction = game.as(player).asCommand();
    assert.ok("player" in Game.validateAction(interaction, { requiredCard: CardName.CampRaid }));
    assert.equal(player.hand.length, 1);
    assert.ok("error" in Game.validateAction(interaction, { requiredCard: CardName.SpyShack }));
  });

  it("explains that the game is over after a winner", () => {
    const game = startTestGame(3);
    Game.winner = game.players[1];
    Game.active = false;
    const result = Game.validateAction(game.as(game.players[0]).asCommand());
    assert.match((result as { error: string }).error, /game is over/);
  });
});

describe("vote-outs and inheritance", () => {
  beforeEach(() => Game.reset());

  /** A game where nobody holds any cards yet, so hands are fully controlled. */
  function emptyHandedGame(count: number) {
    const game = startTestGame(count);
    for (const player of game.players) player.hand = [];
    return game;
  }

  it("grays out castaway #1 first and eliminates on the second vote-out", () => {
    const { players } = emptyHandedGame(4);
    Game.tribalCouncilCount = 1;
    const [first] = Game.applyVoteOuts([players[0]]);
    assert.equal(first.castaway?.name, "P1 First");
    assert.equal(first.eliminated, false);
    Game.tribalCouncilCount = 2;
    const [second] = Game.applyVoteOuts([players[0]]);
    assert.equal(second.castaway?.name, "P1 Second");
    assert.equal(second.castaway?.lostAtTribal, 2);
    assert.ok(second.eliminated);
    assert.equal(Game.totalVoteOuts(), 2);
  });

  it("gives the eliminated player's hand to whoever holds their Inheritance card", () => {
    const { players } = emptyHandedGame(4);
    const [heir, outgoing] = [players[1], players[2]];
    takeLife(outgoing);
    outgoing.hand = [card(CardName.ExtraVote), card(CardName.ImmunityIdol)];
    heir.hand = [card(inheritanceCardName(outgoing.username), outgoing), card(CardName.CampRaid)];

    const [outcome] = Game.applyVoteOuts([outgoing]);
    assert.ok(outcome.eliminated);
    assert.equal(outcome.heir, heir);
    assert.deepEqual(outcome.inheritedCards.map((c) => c.getName()), [CardName.ExtraVote, CardName.ImmunityIdol]);
    // The Inheritance card is played; the rest of the heir's hand stays
    assert.deepEqual(heir.hand.map((c) => c.getName()), [CardName.CampRaid, CardName.ExtraVote, CardName.ImmunityIdol]);
    assert.deepEqual(outgoing.hand, []);
  });

  it("discards the hand when nobody holds the Inheritance card", () => {
    const { players } = emptyHandedGame(4);
    takeLife(players[3]);
    players[3].hand = [card(CardName.ExtraVote)];
    const [outcome] = Game.applyVoteOuts([players[3]]);
    assert.equal(outcome.heir, undefined);
    assert.equal(outcome.discardedCount, 1);
    assert.deepEqual(players[3].hand, []);
  });

  it("someone going home in the same double elimination can't inherit", () => {
    const { players } = emptyHandedGame(5);
    const [a, b] = [players[0], players[1]];
    takeLife(a);
    takeLife(b);
    a.hand = [card(inheritanceCardName(b.username), b)];
    b.hand = [card(CardName.ExtraVote)];
    const outcomes = Game.applyVoteOuts([a, b]);
    assert.ok(outcomes.every((o) => o.eliminated && !o.heir));
  });

  it("names the last player out as Final Tribal Council leader when two remain", () => {
    const { players } = emptyHandedGame(3);
    takeLife(players[2]);
    Game.applyVoteOuts([players[2]]);
    assert.equal(Game.finalTribalLeader, players[2]);
  });

  it("cancels camp raids by or on an eliminated player", () => {
    const { players } = emptyHandedGame(4);
    players[0].campRaid = players[1];
    players[1].campRaid = players[2];
    takeLife(players[1]);
    Game.applyVoteOuts([players[1]]);
    assert.equal(players[0].campRaid, undefined);
    assert.equal(players[1].campRaid, undefined);
  });
});

describe("Sorry for You windows", () => {
  beforeEach(() => Game.reset());

  it("expires on its own, and only one can be open at a time", async () => {
    const { players } = startTestGame(3);
    const window = Game.openInterruptWindow(players[0], players[1], 10);
    assert.ok(window);
    assert.equal(Game.openInterruptWindow(players[2], players[1], 10), null);
    assert.equal(await window, "expired");
    assert.equal(Game.interruption, null);
  });

  it("can be blocked by the target", async () => {
    const { players } = startTestGame(3);
    const window = Game.openInterruptWindow(players[0], players[1], 10_000)!;
    assert.equal(Game.blockInterruption(), players[0]);
    assert.equal(await window, "stopped");
    assert.equal(Game.blockInterruption(), null);
  });

  it("a reset settles any open window", async () => {
    const { players } = startTestGame(3);
    const window = Game.openInterruptWindow(players[0], players[1], 10_000)!;
    Game.reset();
    assert.equal(await window, "stopped");
  });
});
