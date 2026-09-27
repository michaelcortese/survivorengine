/**
 * Regression tests for bugs found in code review of the engine rework.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Game, TribalCouncilState } from "../src/game/game";
import Card from "../src/game/card";
import { CardName, inheritanceCardName } from "../src/game/cards";
import { TribalCouncilType } from "../src/game/tribal_council";
import breakTie from "../src/commands/game/break_tie";
import draw from "../src/commands/game/draw";
import castVote from "../src/commands/game/cast_vote";
import knowledgeIsPower from "../src/commands/game/knowledge_is_power";
import sorryForYou from "../src/commands/game/sorry_for_you";
import stealRandom from "../src/commands/game/steal_random";
import { FakeInteraction, useFastTimings, waitFor } from "./helpers/discord_fakes";
import { runTribalCouncil, startTestGame, takeLife } from "./helpers/game_setup";

useFastTimings();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("review regressions", () => {
  beforeEach(() => {
    Game.reset();
    useFastTimings();
  });

  it("the forced discard after Sorry for You throws away the card the player picked", async () => {
    useFastTimings({ sorryForYouWindowMs: 5_000, menuMs: 5_000 });
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.CampRaid), new Card(CardName.ExtraVote)];
    p2.hand = [new Card(CardName.SorryForYou), new Card(CardName.ImmunityIdol)];

    const steal = stealRandom.execute(game.as(p1, { player: game.userOf(p2) }).asCommand());
    await waitFor(() => Game.interruption !== null);
    const block = game.as(p2);
    await sorryForYou.execute(block.asCommand());
    await steal;

    // The thief opens the private discard menu, picks Camp Raid and confirms
    const notice = block.followUps.find((m) => m.content.includes("must discard"))!;
    const open = game.as(p1);
    open.customId = "forced_discard_open";
    await notice.collectors[0].click(open.asButton());
    const menu = open.followUps[0];
    const [selectCollector, buttonCollector] = menu.collectors;

    const select = game.as(p1);
    select.customId = "forced_discard_select";
    select.values = [CardName.CampRaid];
    await selectCollector.click(select.asButton());

    const confirm = game.as(p1);
    confirm.customId = "forced_discard_confirm";
    await buttonCollector.click(confirm.asButton());

    assert.deepEqual(p1.hand.map((c) => c.getName()), [CardName.ExtraVote]);
    assert.match(confirm.lastText, /You discarded \*\*Camp Raid\*\*/);
    assert.ok(block.texts.some((t) => t.includes("discarded **Camp Raid**")));
    assert.ok(!block.texts.some((t) => t.includes("failed to choose")));
  });

  it("nobody can draw between the last vote-out and the Final Tribal Council", async () => {
    const game = startTestGame(3);
    const [p1, , p3] = game.players;
    takeLife(p3);
    game.channel.sendDelayMs = 20;
    const council = runTribalCouncil(game, { drawer: p1, votes: [p3] });
    // finish() has started: the council is over but the final hasn't opened yet
    await waitFor(() => Game.tribalCouncil === null);
    Game.deck.addCard(new Card(CardName.TribalCouncil, null, null, null, 1));

    const sneaky = game.as(p1);
    await draw.execute(sneaky.asCommand());
    assert.match(sneaky.lastText, /Final Tribal Council/);
    await council;
    assert.equal(Game.tribalCouncilState, TribalCouncilState.FINAL);
    assert.ok(Game.finalTribalCouncil);
  });

  it("a council interrupted by /end_game doesn't touch the next game's state", async () => {
    const game = startTestGame(3);
    const [p1, , p3] = game.players;
    takeLife(p3);
    game.channel.sendDelayMs = 20;
    const council = runTribalCouncil(game, { drawer: p1, votes: [p3] });
    await waitFor(() => !p3.isAlive());

    const next = startTestGame(3);
    Game.tribalCouncilState = TribalCouncilState.Voting;
    next.players[0].votes = 1;
    await council;
    await sleep(50);
    assert.equal(Game.tribalCouncilState, TribalCouncilState.Voting);
    assert.equal(next.players[0].votes, 1);
    assert.equal(Game.finalTribalCouncil, null);
    assert.ok(!next.channel.transcript().includes("No game is currently in progress"));
  });

  it("the leader can't break a tie that the rocks are already settling", async () => {
    useFastTimings({ tieBreakMs: 10 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    await runTribalCouncil(game, { drawer: p1, votes: [p2, p3] });
    game.channel.sendDelayMs = 100;
    await sleep(40); // the rocks are being drawn (their announcement is in flight)

    const late = game.as(p1, { player1: game.userOf(p2) });
    await breakTie.execute(late.asCommand());
    assert.match(late.lastText, /no tie|already/i);

    await waitFor(() => Game.tribalCouncil === null);
    await waitFor(() => game.channel.texts.some((t) => t.includes("tribal council has ended")));
    const loser = [p2, p3].find((p) => p.lives === 1)!;
    assert.equal(p2.lives + p3.lives, 3, "exactly one castaway was lost");
    const rocks = game.channel.texts.find((t) => t.includes("purple rock"))!;
    assert.ok(rocks.includes(`<@${loser.id}>`), "the rocks announcement names who actually went out");
  });

  it("a tied Final Tribal Council can only be decided once", async () => {
    useFastTimings({ tieBreakMs: 10 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    takeLife(p4);
    takeLife(p4);
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });
    const council = Game.finalTribalCouncil!;
    council.recordVote(p3, p1);
    council.recordVote(p4, p2);
    game.channel.sendDelayMs = 100;
    const reveal = council.afterVote();
    await waitFor(() => council.awaitingTieBreak, 5_000);
    await sleep(40); // rocks are deciding

    const late = new FakeInteraction(game.userOf(p3), game.channel, { player1: game.userOf(p1) });
    await breakTie.execute(late.asCommand());
    await reveal;
    await waitFor(() => Game.winner !== null, 5_000);
    await sleep(250);
    const crowned = game.channel.texts.filter((t) => t.includes("The winner of Survivor is"));
    assert.equal(crowned.length, 1, "only one winner is announced");
  });

  it("a player voted out in the same double council can't inherit from first place", async () => {
    const game = startTestGame(5);
    const [p1, p2, p3] = game.players;
    for (const player of game.players) player.hand = [];
    takeLife(p2);
    takeLife(p3);
    p2.hand = [new Card(CardName.ExtraVote)];
    p3.hand = [new Card(inheritanceCardName(p2.username), null, null, null, undefined, p2)];

    // Everyone votes P2: P2 goes first, then the leader picks P3 from the tie for second
    const { council } = await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p2, p2],
    });
    assert.equal(p2.lives, 0);
    assert.ok(council.pendingTie?.tied.includes(p3));
    await breakTie.execute(game.as(p1, { player1: game.userOf(p3) }).asCommand());

    assert.equal(p3.lives, 0);
    assert.doesNotMatch(game.channel.transcript(), /played \*\*Inheritance: P2\*\*/);
    assert.match(game.channel.transcript(), /<@2>'s 1 card go to the discard pile/);
  });

  it("the jury's votes are read when voting time runs out", async () => {
    useFastTimings({ finalVoteMs: 30 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    takeLife(p4);
    takeLife(p4);
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });
    await castVote.execute(game.as(p4, { player: game.userOf(p2) }).asCommand());
    // p3 never votes
    await waitFor(() => Game.winner !== null);
    assert.equal(Game.winner, p2);
    assert.match(game.channel.transcript(), /Time's up at Final Tribal Council/);
  });

  it("Knowledge is Power doesn't hand a card to someone voted out during the window", async () => {
    useFastTimings({ sorryForYouWindowMs: 40 });
    const game = startTestGame(4);
    const [p1, p2] = game.players;
    p1.hand = [new Card(CardName.KnowledgeIsPower)];
    p2.hand = [new Card(CardName.ImmunityIdol)];
    takeLife(p1);
    Game.tribalCouncilState = TribalCouncilState.Discussion;

    const ask = game.as(p1, { player: game.userOf(p2), card_name: CardName.ImmunityIdol });
    const asking = knowledgeIsPower.execute(ask.asCommand());
    await waitFor(() => Game.interruption !== null);
    Game.applyVoteOuts([p1]); // voted out while the window is open
    await asking;

    assert.deepEqual(p2.hand.map((c) => c.getName()), [CardName.ImmunityIdol]);
    assert.match(ask.lastText, /voted out before it changed hands/);
  });
});
