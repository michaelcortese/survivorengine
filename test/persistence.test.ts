import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Client, Interaction } from "discord.js";
import { Game, TribalCouncilState } from "../src/game/game";
import Card from "../src/game/card";
import type Player from "../src/game/player";
import { CardName, inheritanceCardName } from "../src/game/cards";
import { Lobby } from "../src/game/lobby";
import { TribalCouncilType } from "../src/game/tribal_council";
import {
  disableAutosave,
  enableAutosave,
  flushSave,
  restoreGame,
  resumeSavedGame,
  SavedGame,
  serializeGame,
} from "../src/game/persistence";
import interactionCreate from "../src/events/interactionCreate";
import breakTie from "../src/commands/game/break_tie";
import castVote from "../src/commands/game/cast_vote";
import draw from "../src/commands/game/draw";
import endGame from "../src/commands/game/end_game";
import extraVote from "../src/commands/game/extra_vote";
import give from "../src/commands/game/give";
import imTheLeader from "../src/commands/game/im_the_leader";
import { fakeClient, sentDMs, useFastTimings, waitFor } from "./helpers/discord_fakes";
import { runTribalCouncil, startTestGame, takeLife } from "./helpers/game_setup";

useFastTimings();

const client = fakeClient as unknown as Client;
let dir: string;
let file: string;

/** The game as it would be written to disk. */
function snapshot(): SavedGame {
  return JSON.parse(JSON.stringify(serializeGame()));
}

function readSave(): SavedGame {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Saves the game, then "restarts the bot": restores the game from the file the
 * way the ready event does. Tests change the game directly, so it's saved the
 * way it would be after a command.
 */
async function restart() {
  Game.changed();
  await flushSave();
  disableAutosave();
  await resumeSavedGame(client, file);
}

/** The restored copy of a player. */
function restored(player: Player): Player {
  return Game.getPlayerFromUserId(player.id)!;
}

beforeEach(() => {
  Game.reset();
  useFastTimings();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "survivor-save-"));
  file = path.join(dir, "game.json");
  enableAutosave(file);
});

afterEach(async () => {
  await flushSave();
  disableAutosave();
  Game.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saving and restoring a game", () => {
  it("brings back every part of the game exactly", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    const photo = Buffer.from("a castaway portrait");
    Game.discussionMs = 90_000;
    Game.tribalCouncilCount = 2;
    p3.loseLife(1);
    p1.castaways[1].image = photo;
    p2.hand.push(new Card(inheritanceCardName(p4.username), "text", "short", null, undefined, p4));
    p4.campRaid = p1;
    Game.advanceTurn();
    const saved = snapshot();
    assert.equal(saved.channelId, game.channel.id);
    assert.equal(saved.players[0].castaways[1].image, photo.toString("base64"));
    assert.equal(saved.players[1].hand.at(-1)?.inheritancePlayer, p4.id);
    assert.equal(saved.players[3].campRaid, p1.id);

    await restart();
    assert.deepEqual(snapshot(), saved);
    const [r1, r2, r3, r4] = Game.players;
    assert.notEqual(r1, p1, "the players are rebuilt");
    assert.equal(r2.hand.at(-1)?.inheritancePlayer, r4);
    assert.equal(r4.campRaid, r1);
    assert.deepEqual(r1.castaways[1].image, photo);
    assert.equal(r3.lives, 1);
    assert.equal(r3.castaways[0].lostAtTribal, 1);
    const inheritanceCards = [...Game.deck.peekAll(), ...Game.players.flatMap((p) => p.hand)].filter(
      (card) => card.inheritancePlayer,
    );
    assert.equal(inheritanceCards.length, 5);
    assert.ok(inheritanceCards.every((card) => Game.players.includes(card.inheritancePlayer!)));
    assert.equal(Game.channel, game.channel);
    assert.equal(Game.currentPlayer(), r2);
    assert.match(game.channel.texts.at(-1)!, /The bot restarted, but the game was saved.*It's <@2>'s turn/);
  });

  it("carries on after the restart: a camp raid still steals the next draw", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.campRaid = p2;
    Game.deck.addCard(new Card(CardName.ExtraVote));
    await restart();

    const handSize = restored(p2).hand.length;
    const drawing = game.as(p1);
    await draw.execute(drawing.asCommand());
    assert.equal(restored(p2).hand.length, handSize + 1);
    assert.equal(restored(p2).hand.at(-1)?.getName(), CardName.ExtraVote);
    assert.equal(restored(p1).campRaid, undefined);
    assert.equal(Game.currentPlayer(), restored(p2));
    assert.match(drawing.lastText, /stolen by <@2>\. It's <@2>'s turn/);
  });

  it("finds a bad save before touching the game in progress", () => {
    const game = startTestGame(3);
    const saved = snapshot();
    assert.throws(() => restoreGame({ ...saved, version: 2 }), /unsupported version 2/);
    saved.players[0].campRaid = "99";
    assert.throws(() => restoreGame(saved), /no player with id 99/);
    assert.equal(Game.players[0], game.players[0]);
    assert.ok(Game.active);
  });

  it("moves a save it can't read out of the way and starts without a game", async () => {
    disableAutosave();
    fs.writeFileSync(file, "{ this isn't JSON");
    await resumeSavedGame(client, file);
    assert.equal(Game.players.length, 0);
    assert.equal(fs.readFileSync(`${file}.broken`, "utf8"), "{ this isn't JSON");

    startTestGame(3);
    await flushSave();
    assert.equal(readSave().players.length, 3, "new games are still saved");
  });
});

describe("when the save file is written", () => {
  it("/end_game deletes it, and the next game replaces it", async () => {
    const game = startTestGame(3);
    await flushSave();
    assert.ok(fs.existsSync(file));

    const interaction = game.as(game.players[0]);
    await endGame.execute(interaction.asCommand());
    const confirm = game.as(game.players[0]);
    confirm.customId = "end_game_confirm";
    await interaction.replyMessage!.collectors[0].click(confirm.asButton());
    await flushSave();
    assert.equal(fs.existsSync(file), false);

    startTestGame(4);
    await flushSave();
    assert.equal(readSave().players.length, 4);
  });

  it("a /setup lobby isn't saved", async () => {
    Game.lobby = new Lobby("1");
    Game.changed();
    await flushSave();
    assert.equal(fs.existsSync(file), false);
  });

  it("after a command runs", async () => {
    const game = startTestGame(3);
    await flushSave();
    Game.deck.addCard(new Card(CardName.SpyShack));
    fakeClient.commands.set("draw", draw);
    const interaction = game.as(game.players[0]);
    interaction.commandName = "draw";
    await interactionCreate.execute(interaction as unknown as Interaction);
    await flushSave();
    const saved = readSave();
    assert.equal(saved.players[0].hand.at(-1)?.name, CardName.SpyShack);
    assert.equal(saved.currentPlayerIndex, 1);
  });

  it("after a button click that a command's collector handles", async () => {
    useFastTimings({ menuMs: 5_000 });
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.CampRaid)];
    const command = game.as(p1, { player: game.userOf(p2) });
    await give.execute(command.asCommand());
    await flushSave();

    const [select, buttons] = command.replyMessage!.collectors;
    const pick = game.as(p1);
    pick.customId = "give_select";
    pick.values = [CardName.CampRaid];
    await select.click(pick.asButton());
    const confirm = game.as(p1);
    confirm.customId = "give_confirm";
    // Discord hands the click to interactionCreate and to the collector
    await interactionCreate.execute(confirm as unknown as Interaction);
    await buttons.click(confirm.asButton());
    await flushSave();
    const saved = readSave();
    assert.deepEqual(saved.players[0].hand, []);
    assert.equal(saved.players[1].hand.at(-1)?.name, CardName.CampRaid);
  });

  it("not while a Sorry for You window is open, because the raided draw belongs to nobody yet", async () => {
    useFastTimings({ sorryForYouWindowMs: 200 });
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.campRaid = p2;
    Game.deck.addCard(new Card(CardName.ExtraVote));
    Game.changed();
    await flushSave();
    const deckSize = readSave().deck.length;

    const drawing = draw.execute(game.as(p1).asCommand());
    await waitFor(() => Game.interruption !== null);
    Game.changed();
    await flushSave();
    assert.equal(readSave().deck.length, deckSize, "a restart now would go back to before the draw");

    await drawing;
    Game.changed();
    await flushSave();
    const saved = readSave();
    assert.equal(saved.deck.length, deckSize - 1);
    assert.equal(saved.players[1].hand.at(-1)?.name, CardName.ExtraVote);
  });
});

describe("a restart during Tribal Council", () => {
  it("calls the council off, resets the votes, and play goes on after the drawer", async () => {
    useFastTimings({ votingMs: 60_000 });
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    const deckSize = Game.deck.getCardCount();
    Game.deck.addCard(new Card(CardName.TribalCouncil, null, null, null, 1));
    p3.hand = [new Card(CardName.ExtraVote)];
    void draw.execute(game.as(p1).asCommand()); // runs until the restart cuts it off
    await waitFor(() => Game.tribalCouncilState === TribalCouncilState.Voting);
    await extraVote.execute(game.as(p3).asCommand());
    await castVote.execute(game.as(p2, { player: game.userOf(p3) }).asCommand());
    assert.equal(p3.votes, 2);

    await restart();
    assert.equal(Game.tribalCouncil, null);
    assert.equal(Game.tribalCouncilState, TribalCouncilState.NotStarted);
    assert.ok(Game.players.every((p) => p.votes === 0 && p.lives === 2));
    assert.equal(Game.tribalCouncilCount, 1);
    assert.equal(Game.deck.getCardCount(), deckSize, "the Tribal Council card was used up");
    assert.deepEqual(restored(p3).hand, [], "cards played at the council stay played");
    assert.equal(Game.currentPlayer(), restored(p2));
    assert.match(
      game.channel.texts.at(-1)!,
      /restarted in the middle of Tribal Council #1, so it has been called off.* It's <@2>'s turn\.$/,
    );

    Game.deck.addCard(new Card(CardName.SpyShack));
    const next = game.as(p2);
    await draw.execute(next.asCommand());
    assert.match(next.lastText, /It's <@3>'s turn/);
  });

  it("still gives the next turn to whoever took over with I'm the Leader Now", async () => {
    useFastTimings({ votingMs: 60_000 });
    const game = startTestGame(4);
    const [p1, , , p4] = game.players;
    void runTribalCouncil(game, { drawer: p1 }); // runs until the restart cuts it off
    await waitFor(() => Game.tribalCouncilState === TribalCouncilState.Voting);
    p4.hand.push(new Card(CardName.ImTheLeaderNow));
    await imTheLeader.execute(game.as(p4).asCommand());

    await restart();
    assert.equal(Game.currentPlayer(), restored(p4));
    assert.match(game.channel.texts.at(-1)!, /It's <@4>'s turn/);
  });

  it("someone voted out of the game just before it still hands their cards to their heir", async () => {
    const game = startTestGame(5);
    const [p1, p2, p3] = game.players;
    for (const player of game.players) player.hand = [];
    takeLife(p2);
    p2.hand = [new Card(CardName.ExtraVote)];
    p3.hand = [new Card(inheritanceCardName(p2.username), null, null, null, undefined, p2)];
    // Everyone votes P2: P2 goes home, then the leader has to pick second place
    const { council } = await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p2, p2],
    });
    assert.equal(p2.lives, 0);
    assert.ok(council.pendingTie);
    const dmCount = sentDMs.length;

    await restart();
    assert.deepEqual(restored(p3).hand.map((c) => c.getName()), [CardName.ExtraVote]);
    assert.deepEqual(restored(p2).hand, []);
    assert.equal(restored(p2).lives, 0, "the vote-out stands");
    assert.equal(Game.currentPlayer(), restored(p3), "P2 is out, so the turn skips to P3");
    const transcript = game.channel.transcript();
    assert.match(transcript, /Castaways already voted out tonight stay out/);
    assert.match(transcript, /<@3> played \*\*Inheritance: P2\*\* and inherits 1 card from <@2>/);
    assert.ok(sentDMs.slice(dmCount).some((dm) => dm.userId === p3.id && dm.content.includes("Extra Vote")));
  });
});

describe("a restart during the Final Tribal Council", () => {
  /** Four players: P3 and P4 are the jury, and the Final Tribal Council is open. */
  async function reachFinalTribal() {
    const game = startTestGame(4);
    const [p1, , p3, p4] = game.players;
    takeLife(p4);
    takeLife(p4);
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });
    assert.ok(Game.finalTribalCouncil);
    return game;
  }

  it("keeps the jury's votes and posts the vote buttons again", async () => {
    const game = await reachFinalTribal();
    const [p1, p2, p3, p4] = game.players;
    await castVote.execute(game.as(p3, { player: game.userOf(p1) }).asCommand());

    await restart();
    const council = Game.finalTribalCouncil!;
    assert.deepEqual([...council.votes].map(([juror, finalist]) => [juror, finalist.id]), [[p3.id, p1.id]]);
    assert.match(game.channel.transcript(), /jury's votes are safe \(1\/2 cast\)/);
    const again = game.as(p3, { player: game.userOf(p2) });
    await castVote.execute(again.asCommand());
    assert.match(again.lastText, /already cast your vote/);

    const intro = game.channel.messages.filter((m) => m.content.includes("FINAL TRIBAL COUNCIL")).at(-1)!;
    assert.match(intro.content, /Votes cast: 1\/2/);
    const click = game.as(p4);
    click.customId = `ftc:${Game.id}:vote:${p1.id}`;
    await intro.collectors[0].click(click.asButton());
    await waitFor(() => Game.winner !== null);
    assert.equal(Game.winner, restored(p1));
  });

  it("reads a tied vote again, and the leader still breaks the tie", async () => {
    const game = await reachFinalTribal();
    const [p1, p2, p3, p4] = game.players;
    await castVote.execute(game.as(p3, { player: game.userOf(p1) }).asCommand());
    await castVote.execute(game.as(p4, { player: game.userOf(p2) }).asCommand());
    assert.ok(Game.finalTribalCouncil?.awaitingTieBreak);

    await restart();
    assert.ok(Game.finalTribalCouncil?.awaitingTieBreak);
    await breakTie.execute(game.as(p3, { player1: game.userOf(p2) }).asCommand());
    assert.equal(Game.winner, restored(p2));
  });

  it("voting that closed when time ran out stays closed", async () => {
    useFastTimings({ finalVoteMs: 30 });
    const game = await reachFinalTribal();
    const [p1, p2, p3] = game.players;
    // Nobody votes in time: zero votes each is a tie for the leader to break
    await waitFor(() => Game.finalTribalCouncil?.awaitingTieBreak === true);

    await restart();
    assert.ok(Game.finalTribalCouncil?.awaitingTieBreak);
    const late = game.as(p3, { player: game.userOf(p1) });
    await castVote.execute(late.asCommand());
    assert.match(late.lastText, /Voting at Final Tribal Council is closed/);
    await breakTie.execute(game.as(p3, { player1: game.userOf(p2) }).asCommand());
    assert.equal(Game.winner, restored(p2));
  });

  it("opens it if the bot stopped just before it started", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    takeLife(p3);
    takeLife(p3);
    Game.finalTribalLeader = p3;
    Game.tribalCouncilState = TribalCouncilState.FINAL;

    await restart();
    const council = Game.finalTribalCouncil;
    assert.ok(council);
    assert.deepEqual(council.finalists, [restored(p1), restored(p2)]);
    assert.equal(council.leader, restored(p3));
    assert.match(game.channel.texts.at(-1)!, /FINAL TRIBAL COUNCIL/);
  });

  it("a finished game comes back quietly, winner and all", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });
    await castVote.execute(game.as(p3, { player: game.userOf(p2) }).asCommand());
    assert.equal(Game.winner, p2);
    const messages = game.channel.messages.length;

    await restart();
    assert.equal(Game.winner, restored(p2));
    assert.equal(Game.active, false);
    assert.equal(game.channel.messages.length, messages, "nothing to announce");
    const result = Game.validateAction(game.as(p1).asCommand());
    assert.match((result as { error: string }).error, /game is over — <@2> won/);
  });
});
