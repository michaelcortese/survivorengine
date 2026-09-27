import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Game, TribalCouncilState } from "../src/game/game";
import Card from "../src/game/card";
import type Player from "../src/game/player";
import { TribalCouncilType } from "../src/game/tribal_council";
import { GameConfig } from "../src/game/config";
import { CardName, inheritanceCardName } from "../src/game/cards";
import breakTie from "../src/commands/game/break_tie";
import castVote from "../src/commands/game/cast_vote";
import revealVotes from "../src/commands/game/reveal_votes";
import { useFastTimings, waitFor } from "./helpers/discord_fakes";
import { runTribalCouncil, startTestGame, takeLife, TestGame } from "./helpers/game_setup";

useFastTimings();

const mention = (player: Player) => `<@${player.id}>`;

function livesOf(game: TestGame): number[] {
  return game.players.map((player) => player.lives);
}

describe("Tribal Council", () => {
  beforeEach(() => {
    Game.reset();
    useFastTimings();
  });

  it("votes out the player with the most votes and grays out their first castaway", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    await runTribalCouncil(game, { drawer: p1, votes: [p2, p2, p3] });

    assert.deepEqual(livesOf(game), [2, 1, 2]);
    const transcript = game.channel.transcript();
    assert.match(transcript, /1st person voted out of Survivor with TWO VOTES/);
    assert.match(transcript, /their castaway \*\*P2 First\*\* is grayed out\. They have 1 life left/);
    assert.equal(Game.tribalCouncilState, TribalCouncilState.NotStarted);
    assert.equal(Game.tribalCouncil, null);
    // The board is posted with the image attached
    const board = game.channel.messages.find((m) => (m.payload.embeds ?? []).length > 0);
    assert.ok(board, "tribe board was posted");
    assert.equal((board.payload.files ?? []).length, 1);
    // Play continues with the player after the one who drew the card
    assert.equal(Game.currentPlayer(), p2);
    assert.ok(game.channel.texts.some((t) => t.includes(`It's ${mention(p2)}'s turn`)));
    assert.ok(game.players.every((p) => p.votes === 0));
  });

  it("gives every player still in the game one vote", async () => {
    const game = startTestGame(4);
    takeLife(game.players[3]);
    takeLife(game.players[3]);
    let votesDuringCouncil: number[] = [];
    await runTribalCouncil(game, {
      drawer: game.players[0],
      votes: [game.players[1]],
      before: () => {
        // init() hands out the votes; peek right after it starts
        setImmediate(() => (votesDuringCouncil = game.players.map((p) => p.votes)));
      },
    });
    assert.deepEqual(votesDuringCouncil.slice(0, 3), [1, 1, 1]);
    assert.equal(votesDuringCouncil[3], 0);
  });

  it("double: votes out first and second place", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p2, p3],
    });
    assert.deepEqual(livesOf(game), [2, 1, 1, 2]);
    assert.match(game.channel.transcript(), /1st and 2nd people voted out of Survivor/);
  });

  it("double: two tied for first both go", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p3, p2, p3],
    });
    assert.deepEqual(livesOf(game), [2, 1, 1, 2]);
  });

  it("double: when every vote is on one player, the leader picks second place from the rest", async () => {
    // This used to leave the leader needing to pick 2 players out of 1.
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    const { council } = await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p2, p2],
    });
    assert.equal(p2.lives, 1, "first place goes straight away");
    assert.deepEqual(council.pendingTie?.picks, 1);
    assert.deepEqual(
      new Set(council.pendingTie?.tied),
      new Set([p1, p3, p4]),
    );

    const leader = game.as(p1, { player1: game.userOf(p4) });
    await breakTie.execute(leader.asCommand());
    assert.deepEqual(livesOf(game), [2, 1, 2, 1]);
    assert.equal(Game.tribalCouncil, null);
  });

  it("double: 3+ tied for first means the leader picks two", async () => {
    const game = startTestGame(5);
    const [p1, p2, p3, p4] = game.players;
    const { council } = await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p3, p4],
    });
    assert.equal(council.pendingTie?.picks, 2);

    const onlyOne = game.as(p1, { player1: game.userOf(p2) });
    await breakTie.execute(onlyOne.asCommand());
    assert.match(onlyOne.lastText, /Select 2 players/);

    const both = game.as(p1, { player1: game.userOf(p2), player2: game.userOf(p4) });
    await breakTie.execute(both.asCommand());
    assert.deepEqual(livesOf(game), [2, 1, 2, 1, 2]);
  });

  it("double with only three players left votes out just one", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    takeLife(p2);
    takeLife(p3);
    await runTribalCouncil(game, {
      drawer: p1,
      type: TribalCouncilType.DOUBLE,
      votes: [p2, p2, p3],
    });
    assert.match(game.channel.transcript(), /just one castaway/);
    assert.equal(p2.lives, 0);
    assert.equal(p3.lives, 1, "second place is spared, so two players remain");
    assert.equal(Game.getAlivePlayers().length, 2);
  });

  it("single tie: only the leader can break it, and only with a tied player", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    const { council } = await runTribalCouncil(game, { drawer: p1, votes: [p2, p3] });
    assert.deepEqual(council.pendingTie, { tied: [p2, p3], picks: 1 });
    assert.match(game.channel.transcript(), /WE HAVE A TIE!/);

    const notLeader = game.as(p2, { player1: game.userOf(p3) });
    await breakTie.execute(notLeader.asCommand());
    assert.match(notLeader.lastText, /not the leader/);

    const notTied = game.as(p1, { player1: game.userOf(p1) });
    await breakTie.execute(notTied.asCommand());
    assert.match(notTied.lastText, /not one of the tied players/);

    const decides = game.as(p1, { player1: game.userOf(p3) });
    await breakTie.execute(decides.asCommand());
    assert.deepEqual(livesOf(game), [2, 2, 1]);
    assert.match(game.channel.transcript(), /1st person voted out of Survivor: <@3>/);
  });

  it("a tie the leader never breaks is settled by drawing rocks", async () => {
    useFastTimings({ tieBreakMs: 15 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    await runTribalCouncil(game, { drawer: p1, votes: [p2, p3] });
    await waitFor(() => Game.tribalCouncil === null);
    assert.equal(p2.lives + p3.lives, 3, "exactly one tied player lost a castaway");
    assert.match(game.channel.transcript(), /drawing rocks|draw rocks/);
  });

  it("an immunity idol cancels the votes against the protected player", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    await runTribalCouncil(game, {
      drawer: p1,
      votes: [p2, p2, p3],
      before: (council) => council.idolProtections.push({ protectedPlayer: p2, playedBy: p4 }),
    });
    assert.deepEqual(livesOf(game), [2, 2, 1, 2]);
    assert.match(game.channel.transcript(), /2 votes for <@2> do not count/);
  });

  it("a nullified idol doesn't protect anyone", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    await runTribalCouncil(game, {
      drawer: p1,
      votes: [p2, p2, p3],
      before: (council) => {
        council.idolProtections.push({ protectedPlayer: p2, playedBy: p2 });
        council.idolNullifications.push({
          nullifiedBy: p4,
          targetPlayer: p2,
          originalIdolPlayer: p2,
          originalProtectedPlayer: p2,
        });
      },
    });
    assert.deepEqual(livesOf(game), [2, 1, 2, 2]);
  });

  it("when idols cancel every vote, only non-immune players are tied", async () => {
    const game = startTestGame(4);
    const [p1, p2] = game.players;
    const { council } = await runTribalCouncil(game, {
      drawer: p1,
      votes: [p2, p2],
      before: (c) => c.idolProtections.push({ protectedPlayer: p2, playedBy: p2 }),
    });
    assert.match(game.channel.transcript(), /UNPRECEDENTED/);
    assert.ok(council.pendingTie);
    assert.ok(!council.pendingTie.tied.includes(p2));
    assert.equal(council.pendingTie.tied.length, 3);
  });

  it("says nobody voted (not that idols cancelled votes) when no votes were cast", async () => {
    const game = startTestGame(3);
    const { council } = await runTribalCouncil(game, { drawer: game.players[0], votes: [] });
    assert.match(game.channel.transcript(), /Nobody voted!/);
    assert.doesNotMatch(game.channel.transcript(), /UNPRECEDENTED/);
    assert.equal(council.pendingTie?.tied.length, 3);
  });

  it("an eliminated player's hand goes to whoever holds their Inheritance card", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    for (const player of game.players) player.hand = [];
    takeLife(p2);
    p2.hand = [new Card(CardName.ExtraVote), new Card(CardName.SorryForYou)];
    p3.hand = [new Card(inheritanceCardName(p2.username), null, null, null, undefined, p2)];
    await runTribalCouncil(game, { drawer: p1, votes: [p2] });

    assert.equal(p2.lives, 0);
    assert.deepEqual(p3.hand.map((c) => c.getName()).sort(), [CardName.ExtraVote, CardName.SorryForYou]);
    assert.match(game.channel.transcript(), /<@3> played \*\*Inheritance: P2\*\* and inherits 2 cards/);
  });

  it("after I'm the Leader Now, the new leader takes the next turn", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    await runTribalCouncil(game, {
      drawer: p1,
      votes: [p2],
      before: (council) => {
        council.leader = p3;
        council.leaderChangedByCard = true;
      },
    });
    assert.equal(Game.currentPlayer(), p3);
  });

  it("a council interrupted by /end_game stops without touching the next game", async () => {
    useFastTimings({ votingMs: 40 });
    const game = startTestGame(3);
    const running = runTribalCouncil(game, { drawer: game.players[0], votes: [game.players[1]] });
    await waitFor(() => Game.tribalCouncilState === TribalCouncilState.Voting);
    Game.reset();
    const next = startTestGame(3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(Game.tribalCouncilState, TribalCouncilState.NotStarted);
    assert.ok(next.players.every((p) => p.lives === 2));
    // The old council's promise never settles; don't wait on it.
    void running;
  });

  it("players vote with /cast_vote during the voting window", async () => {
    useFastTimings({ votingMs: 60 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    const running = runTribalCouncil(game, { drawer: p1 });
    await waitFor(() => Game.tribalCouncilState === TribalCouncilState.Voting);

    const self = game.as(p1, { player: game.userOf(p1) });
    await castVote.execute(self.asCommand());
    assert.match(self.lastText, /yourself/);

    for (const voter of [p1, p3]) {
      await castVote.execute(game.as(voter, { player: game.userOf(p2) }).asCommand());
    }
    const twice = game.as(p1, { player: game.userOf(p3) });
    await castVote.execute(twice.asCommand());
    assert.match(twice.lastText, /no votes remaining/);

    await running;
    assert.deepEqual(livesOf(game), [2, 1, 2]);
  });
});

describe("Final Tribal Council", () => {
  beforeEach(() => {
    Game.reset();
    useFastTimings();
  });

  it("starts by itself when two remain, then the jury crowns a winner", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });

    assert.equal(Game.tribalCouncilState, TribalCouncilState.FINAL);
    const council = Game.finalTribalCouncil;
    assert.ok(council);
    assert.deepEqual(council.finalists, [p1, p2]);
    assert.deepEqual(council.jury, [p3]);
    assert.equal(council.leader, p3);
    assert.match(game.channel.transcript(), /FINAL TRIBAL COUNCIL/);

    // Finalists can't vote; the juror can, once
    const finalistVote = game.as(p1, { player: game.userOf(p2) });
    await castVote.execute(finalistVote.asCommand());
    assert.match(finalistVote.lastText, /Only the jury/);

    const juror = game.as(p3, { player: game.userOf(p2) });
    await castVote.execute(juror.asCommand());
    await waitFor(() => Game.winner !== null);

    assert.equal(Game.winner, p2);
    assert.equal(Game.active, false);
    assert.match(game.channel.transcript(), /winner of Survivor is\.\.\. <@2>/);
  });

  it("jurors can vote with the buttons", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });

    const intro = game.channel.messages.find((m) => m.content.includes("FINAL TRIBAL COUNCIL"))!;
    const buttons = intro.collectors[0];
    const click = game.as(p3);
    click.customId = `ftc:${Game.id}:vote:${p1.id}`;
    await buttons.click(click.asButton());
    await waitFor(() => Game.winner !== null);
    assert.equal(Game.winner, p1);
    assert.match(click.lastText, /locked in/);
  });

  it("a tied jury is broken by the Final Tribal Council leader", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    takeLife(p4);
    takeLife(p4);
    takeLife(p3);
    Game.tribalCouncilCount = 1; // p4 went home earlier
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });
    const council = Game.finalTribalCouncil!;
    assert.equal(council.leader, p3, "the last player out leads the Final Tribal Council");

    await castVote.execute(game.as(p3, { player: game.userOf(p1) }).asCommand());
    await castVote.execute(game.as(p4, { player: game.userOf(p2) }).asCommand());
    await waitFor(() => council.awaitingTieBreak);
    assert.match(game.channel.transcript(), /It's a tie!/);

    const wrongPerson = game.as(p4, { player1: game.userOf(p1) });
    await breakTie.execute(wrongPerson.asCommand());
    assert.match(wrongPerson.lastText, /Only the Final Tribal Council Leader/);

    await breakTie.execute(game.as(p3, { player1: game.userOf(p1) }).asCommand());
    assert.equal(Game.winner, p1);
  });

  it("the leader can read the votes early if a juror never votes", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    takeLife(p4);
    takeLife(p4);
    takeLife(p3);
    await runTribalCouncil(game, { drawer: p1, votes: [p3] });
    await castVote.execute(game.as(p3, { player: game.userOf(p2) }).asCommand());

    const tooEarly = game.as(p4);
    await revealVotes.execute(tooEarly.asCommand());
    assert.match(tooEarly.lastText, /Not all jurors have voted/);

    await revealVotes.execute(game.as(p3).asCommand());
    await waitFor(() => Game.winner !== null);
    assert.equal(Game.winner, p2);
  });

  it("stops reading once a finalist has clinched a majority", async () => {
    const game = startTestGame(5);
    const [p1, p2, p3, p4, p5] = game.players;
    for (const juror of [p3, p4]) {
      takeLife(juror);
      takeLife(juror);
    }
    takeLife(p5);
    await runTribalCouncil(game, { drawer: p1, votes: [p5] });
    for (const juror of [p3, p4, p5]) {
      await castVote.execute(game.as(juror, { player: game.userOf(p1) }).asCommand());
    }
    await waitFor(() => Game.winner !== null);
    const transcript = game.channel.transcript();
    assert.match(transcript, /That's two votes for <@1>, enough to win/);
    assert.doesNotMatch(transcript, /THIRD VOTE/);
    assert.equal(GameConfig.livesPerPlayer, 2);
  });
});
