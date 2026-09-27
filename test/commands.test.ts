import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Game, TribalCouncilState } from "../src/game/game";
import Card from "../src/game/card";
import { CardName } from "../src/game/cards";
import castaways from "../src/commands/game/castaways";
import controlTheVote from "../src/commands/game/control_the_vote";
import draw from "../src/commands/game/draw";
import endGame from "../src/commands/game/end_game";
import immunityIdol from "../src/commands/game/immunity_idol";
import knowledgeIsPower from "../src/commands/game/knowledge_is_power";
import setup from "../src/commands/game/setup";
import skipTurn from "../src/commands/game/skip_turn";
import sorryForYou from "../src/commands/game/sorry_for_you";
import spyShack from "../src/commands/game/spy_shack";
import start from "../src/commands/game/start";
import stealRandom from "../src/commands/game/steal_random";
import {
  FakeChannel,
  FakeInteraction,
  FakeMessage,
  fakeModalSubmit,
  fakeUser,
  sentDMs,
  useFastTimings,
  waitFor,
} from "./helpers/discord_fakes";
import { startTestGame, takeLife } from "./helpers/game_setup";

useFastTimings();

const COMMANDS_DIR = path.join(__dirname, "..", "src", "commands");

describe("command definitions", () => {
  it("every command builds valid slash command JSON with a unique name", async () => {
    const names = new Set<string>();
    for (const folder of fs.readdirSync(COMMANDS_DIR)) {
      for (const file of fs.readdirSync(path.join(COMMANDS_DIR, folder))) {
        if (!file.endsWith(".ts")) continue;
        const mod = (await import(path.join(COMMANDS_DIR, folder, file))).default;
        assert.ok(mod.data && mod.execute, `${file} exports data and execute`);
        const json = mod.data.toJSON();
        assert.ok(!names.has(json.name), `duplicate command ${json.name}`);
        names.add(json.name);
        assert.ok(json.description.length <= 100, `${json.name} description is too long`);
      }
    }
    assert.ok(names.size <= 100, "Discord allows at most 100 commands");
    for (const name of ["setup", "castaways", "board", "end_game", "skip_turn"]) {
      assert.ok(names.has(name), `/${name} is registered`);
    }
  });
});

describe("/start", () => {
  beforeEach(() => Game.reset());

  it("rejects the same player twice", async () => {
    const channel = new FakeChannel();
    const [a, b] = [fakeUser("1"), fakeUser("2")];
    const interaction = new FakeInteraction(a, channel, { player1: a, player2: b, player3: a });
    await start.execute(interaction.asCommand());
    assert.match(interaction.lastText, /only be listed once/);
    assert.equal(Game.active, false);
  });

  it("starts with random castaways and posts the board", async () => {
    const channel = new FakeChannel();
    const users = [fakeUser("1"), fakeUser("2"), fakeUser("3")];
    const interaction = new FakeInteraction(users[0], channel, {
      player1: users[0],
      player2: users[1],
      player3: users[2],
      discussion_minutes: 1.5,
    });
    await start.execute(interaction.asCommand());
    assert.ok(Game.active);
    assert.equal(Game.discussionMs, 90_000);
    const last = interaction.log[interaction.log.length - 1].payload;
    assert.match(last.content ?? "", /Game started!/);
    assert.equal((last.files ?? []).length, 1);
    assert.ok(Game.players.every((p) => p.castaways.every((c) => c.chosen && !c.name.startsWith("Castaway "))));
  });
});

describe("/setup lobby", () => {
  beforeEach(() => Game.reset());

  it("players join, pick castaways, and the host starts the game", async () => {
    const channel = new FakeChannel();
    const [host, bob, cat] = [fakeUser("1", "Host"), fakeUser("2", "Bob"), fakeUser("3", "Cat")];
    await setup.execute(new FakeInteraction(host, channel).asCommand());
    const lobby = Game.lobby!;
    assert.ok(lobby);
    assert.deepEqual(lobby.entries.map((e) => e.userId), ["1"], "the host joins automatically");
    const buttons = (lobby.message as unknown as FakeMessage).collectors[0];
    const press = async (user: typeof host, action: string) => {
      const click = new FakeInteraction(user, channel);
      click.customId = lobby.customId(action as "join");
      await buttons.click(click.asButton());
      return click;
    };

    // Bob joins with the button, then picks castaways in the modal
    await press(bob, "join");
    const pick = new FakeInteraction(bob, channel);
    pick.customId = lobby.customId("pick");
    pick.modalSubmit = fakeModalSubmit({ first: "Parvati **Shallow**", second: "" }, pick);
    await buttons.click(pick.asButton());
    assert.deepEqual(lobby.find("2")!.picks.map((p) => p?.name), ["Parvati Shallow", undefined]);

    // Cat joins by picking castaways with the slash command
    const slash = new FakeInteraction(cat, channel, { first: "Sandra Diaz-Twine", second: "Tony Vlachos" });
    await castaways.execute(slash.asCommand());
    assert.equal(lobby.entries.length, 3);

    // Only the host can start
    const notHost = await press(bob, "start");
    assert.match(notHost.lastText, /Only the host/);
    await press(host, "start");

    assert.ok(Game.active);
    assert.equal(Game.lobby, null);
    const catPlayer = Game.getPlayerFromUserId("3")!;
    assert.deepEqual(catPlayer.castaways.map((c) => c.name), ["Sandra Diaz-Twine", "Tony Vlachos"]);
    const bobPlayer = Game.getPlayerFromUserId("2")!;
    assert.equal(bobPlayer.castaways[0].name, "Parvati Shallow");
    assert.notEqual(bobPlayer.castaways[1].name, "Castaway 2", "an empty pick gets a random legend");
  });

  it("autocomplete suggests legends and keeps what you typed", async () => {
    const responses: { name: string }[][] = [];
    const interaction = {
      options: { getFocused: () => "Grandma Sue" },
      respond: async (choices: { name: string }[]) => {
        responses.push(choices);
      },
    };
    await castaways.autocomplete(interaction as never);
    assert.equal(responses[0][0].name, "Grandma Sue");
    assert.ok(responses[0].length <= 25);
  });
});

describe("turns", () => {
  beforeEach(() => Game.reset());

  it("only the current player can draw, and drawing passes the turn", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    // Make sure the next card isn't a Tribal Council
    Game.deck.addCard(new Card(CardName.ExtraVote));

    const outOfTurn = game.as(p2);
    await draw.execute(outOfTurn.asCommand());
    assert.match(outOfTurn.lastText, /not your turn/);

    const onTurn = game.as(p1);
    await draw.execute(onTurn.asCommand());
    assert.match(onTurn.texts[0], /You drew a Extra Vote/);
    assert.match(onTurn.lastText, /It's <@2>'s turn/);
    assert.equal(Game.currentPlayer(), p2);
  });

  it("anyone can skip an absent player's turn, but not their own", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    const own = game.as(p1);
    await skipTurn.execute(own.asCommand());
    assert.match(own.lastText, /can't skip your own turn/);

    const other = game.as(p2);
    await skipTurn.execute(other.asCommand());
    assert.match(other.lastText, /skipped <@1>'s turn/);
    assert.equal(Game.currentPlayer(), p2);
  });

  it("an empty draw pile sends the tribe straight to Tribal Council", async () => {
    const game = startTestGame(3);
    while (Game.deck.drawCard()) {
      // empty the deck
    }
    const interaction = game.as(game.players[0]);
    await draw.execute(interaction.asCommand());
    assert.ok(Game.tribalCouncil, "a Tribal Council is in progress");
    assert.ok(Game.tribalCouncil?.pendingTie, "nobody voted, so the leader has a tie to break");
  });

  it("eliminated players can't draw", async () => {
    const game = startTestGame(3);
    takeLife(game.players[0]);
    takeLife(game.players[0]);
    const interaction = game.as(game.players[0]);
    await draw.execute(interaction.asCommand());
    assert.match(interaction.lastText, /voted out/);
  });
});

describe("stealing and Sorry for You", () => {
  beforeEach(() => {
    Game.reset();
    useFastTimings();
  });

  it("a steal goes through when the window expires", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p2.hand = [new Card(CardName.ImmunityIdol)];
    const before = p1.hand.length;
    const interaction = game.as(p1, { player: game.userOf(p2) });
    await stealRandom.execute(interaction.asCommand());
    assert.equal(p2.hand.length, 0);
    assert.equal(p1.hand.length, before + 1);
    assert.ok(sentDMs.some((dm) => dm.userId === p2.id && dm.content.includes("Immunity Idol")));
  });

  it("Sorry for You blocks the steal and the thief must discard", async () => {
    useFastTimings({ sorryForYouWindowMs: 5_000, menuMs: 20 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [new Card(CardName.CampRaid), new Card(CardName.SpyShack)];
    p2.hand = [new Card(CardName.SorryForYou), new Card(CardName.ImmunityIdol)];

    const steal = stealRandom.execute(game.as(p1, { player: game.userOf(p2) }).asCommand());
    await waitFor(() => Game.interruption !== null);

    const wrongPlayer = game.as(p3);
    p3.hand.push(new Card(CardName.SorryForYou));
    await sorryForYou.execute(wrongPlayer.asCommand());
    assert.match(wrongPlayer.lastText, /Only the targeted player/);

    const block = game.as(p2);
    await sorryForYou.execute(block.asCommand());
    await steal;

    assert.deepEqual(p2.hand.map((c) => c.getName()), [CardName.ImmunityIdol], "Sorry for You is used up; nothing stolen");
    assert.match(block.texts[0], /stopped <@1>'s action/);
    // Nobody opens the discard menu, so a random card is discarded when it times out
    await waitFor(() => p1.hand.length === 1);
  });

  it("Knowledge is Power: a typo doesn't waste the card", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.KnowledgeIsPower)];
    const typo = game.as(p1, { player: game.userOf(p2), card_name: "Imunity Idle" });
    await knowledgeIsPower.execute(typo.asCommand());
    assert.match(typo.lastText, /no card called/);
    assert.equal(p1.hand.length, 1);
  });

  it("Knowledge is Power: asking for a card they don't have uses it up", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.KnowledgeIsPower)];
    p2.hand = [];
    const ask = game.as(p1, { player: game.userOf(p2), card_name: "immunity idol" });
    await knowledgeIsPower.execute(ask.asCommand());
    assert.match(ask.lastText, /don't have it/);
    assert.equal(p1.hand.length, 0);
  });

  it("Knowledge is Power: takes the card (case-insensitive name)", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.KnowledgeIsPower)];
    p2.hand = [new Card(CardName.ImmunityIdol)];
    const ask = game.as(p1, { player: game.userOf(p2), card_name: "immunity idol" });
    await knowledgeIsPower.execute(ask.asCommand());
    assert.deepEqual(p1.hand.map((c) => c.getName()), [CardName.ImmunityIdol]);
    assert.equal(p2.hand.length, 0);
  });

  it("The Spy Shack isn't used up when the target has no cards", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.SpyShack)];
    p2.hand = [];
    const spy = game.as(p1, { player: game.userOf(p2) });
    await spyShack.execute(spy.asCommand());
    assert.match(spy.lastText, /no cards to spy on/);
    assert.equal(p1.hand.length, 1);
  });
});

describe("tribal advantages", () => {
  beforeEach(() => Game.reset());

  it("Control the Vote replies (it used to crash) and moves the vote", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    Game.tribalCouncilState = TribalCouncilState.Discussion;
    p1.hand = [new Card(CardName.ControlTheVote)];
    p1.votes = 1;
    p2.votes = 1;
    const play = game.as(p1, { player: game.userOf(p2) });
    await controlTheVote.execute(play.asCommand());
    assert.equal(play.log[0].kind, "reply");
    assert.equal(p1.votes, 2);
    assert.equal(p2.votes, 0);
    assert.equal(p1.hand.length, 0);
  });

  it("Control the Vote keeps the card when the target has no vote to steal", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    Game.tribalCouncilState = TribalCouncilState.Voting;
    p1.hand = [new Card(CardName.ControlTheVote)];
    p2.votes = 0;
    await controlTheVote.execute(game.as(p1, { player: game.userOf(p2) }).asCommand());
    assert.equal(p1.hand.length, 1);
  });

  it("an Immunity Idol can protect another player (the option name was wrong)", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    const { TribalCouncil, TribalCouncilType } = await import("../src/game/tribal_council");
    const council = new TribalCouncil(game.as(p3).asCommand(), TribalCouncilType.SINGLE, p3);
    Game.setTribalCouncil(council);
    Game.tribalCouncilState = TribalCouncilState.Immunity;
    p1.hand = [new Card(CardName.ImmunityIdol)];
    await immunityIdol.execute(game.as(p1, { player: game.userOf(p2) }).asCommand());
    assert.deepEqual(council.idolProtections, [{ protectedPlayer: p2, playedBy: p1 }]);
  });
});

describe("/end_game", () => {
  beforeEach(() => Game.reset());

  it("ends the game after confirmation", async () => {
    const game = startTestGame(3);
    const interaction = game.as(game.players[1]);
    await endGame.execute(interaction.asCommand());
    const confirm = interaction.replyMessage!.collectors[0];
    const click = game.as(game.players[1]);
    click.customId = "end_game_confirm";
    await confirm.click(click.asButton());
    assert.equal(Game.active, false);
    assert.equal(Game.players.length, 0);
    assert.match(interaction.lastText, /ended the current game/);
  });

  it("outsiders can't end someone else's game", async () => {
    startTestGame(3);
    const outsider = new FakeInteraction(fakeUser("99"), new FakeChannel());
    await endGame.execute(outsider.asCommand());
    assert.match(outsider.lastText, /Only players in the game/);
    assert.ok(Game.active);
  });
});
