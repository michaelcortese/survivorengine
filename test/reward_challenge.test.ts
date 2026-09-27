import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { Game, TribalCouncilState } from "../src/game/game";
import Card from "../src/game/card";
import Player from "../src/game/player";
import { CardName } from "../src/game/cards";
import {
  lowestUniquePick,
  powerPairResult,
  rockPaperScissors,
  swapRandomCards,
  takeRandomCards,
} from "../src/game/reward_challenge";
import draw from "../src/commands/game/draw";
import endGame from "../src/commands/game/end_game";
import rewardChallenge from "../src/commands/game/reward_challenge";
import sorryForYou from "../src/commands/game/sorry_for_you";
import {
  FakeInteraction,
  FakeMessage,
  fakeUser,
  sentDMs,
  useFastTimings,
  waitFor,
} from "./helpers/discord_fakes";
import { startTestGame, takeLife, TestGame } from "./helpers/game_setup";

useFastTimings();

const card = (name: string) => new Card(name);
const names = (player: Player) => player.hand.map((c) => c.getName()).sort();

interface ButtonData {
  custom_id?: string;
  label?: string;
}

function buttonsOn(message: FakeMessage): ButtonData[] {
  const rows = (message.payload.components ?? []) as { components: { data: ButtonData }[] }[];
  return rows.flatMap((row) => row.components.map((button) => button.data));
}

/** Clicks the button with this label (or matching this pattern) as `player`. */
async function press(game: TestGame, message: FakeMessage, player: Player, label: string | RegExp) {
  const button = buttonsOn(message).find((b) =>
    typeof label === "string" ? b.label === label : label.test(b.label ?? ""),
  );
  assert.ok(button?.custom_id, `there's a "${label}" button`);
  const collector = message.collectors.find((c) => !c.ended);
  assert.ok(collector, "the message is listening for clicks");
  const click = game.as(player);
  click.customId = button.custom_id;
  await collector.click(click.asButton());
  return click;
}

/** Starts a Reward Challenge without waiting for it to finish. */
function play(game: TestGame, player: Player, options: Record<string, unknown>) {
  const interaction = game.as(player, options);
  const running = rewardChallenge.execute(interaction.asCommand());
  return { interaction, running };
}

/** Waits for live buttons on the challenge's reply, or on the channel message containing `text`. */
async function buttonsReady(game: TestGame, interaction: FakeInteraction, text?: string) {
  const find = () =>
    text === undefined
      ? interaction.replyMessage
      : game.channel.messages.find((m) => m.content.includes(text));
  await waitFor(() => find()?.collectors.some((c) => !c.ended) ?? false);
  return find()!;
}

describe("Reward Challenge rules", () => {
  const [a, b, c, d] = ["1", "2", "3", "4"].map((id) => new Player(id, `P${id}`));

  it("It's a Numbers Game: the lowest number nobody else picked wins", () => {
    assert.deepEqual(
      lowestUniquePick(new Map([[a, 2], [b, 2], [c, 4], [d, 5]])),
      { player: c, pick: 4 },
    );
    assert.deepEqual(lowestUniquePick(new Map([[a, 3], [b, 1], [c, 5]])), { player: b, pick: 1 });
    assert.equal(lowestUniquePick(new Map([[a, 1], [b, 1], [c, 3], [d, 3]])), null);
    assert.equal(lowestUniquePick(new Map()), null);
  });

  it("Power Pair: a pair steals from the third, three of a kind discard, all different play again", () => {
    assert.deepEqual(powerPairResult([[a, 2], [b, 2], [c, 1]]), { kind: "pair", pair: [a, b], odd: c });
    assert.deepEqual(powerPairResult([[a, 3], [b, 1], [c, 3]]), { kind: "pair", pair: [a, c], odd: b });
    assert.deepEqual(powerPairResult([[a, 1], [b, 2], [c, 2]]), { kind: "pair", pair: [b, c], odd: a });
    assert.deepEqual(powerPairResult([[a, 2], [b, 2], [c, 2]]), { kind: "all_match" });
    assert.deepEqual(powerPairResult([[a, 1], [b, 2], [c, 3]]), { kind: "all_different" });
  });

  it("Do or Die: rock beats scissors, scissors beat paper, paper beats rock", () => {
    assert.deepEqual(rockPaperScissors([a, "rock"], [b, "scissors"]), { winner: a, loser: b });
    assert.deepEqual(rockPaperScissors([a, "scissors"], [b, "paper"]), { winner: a, loser: b });
    assert.deepEqual(rockPaperScissors([a, "rock"], [b, "paper"]), { winner: b, loser: a });
    assert.equal(rockPaperScissors([a, "paper"], [b, "paper"]), null);
  });

  it("a steal takes what's there, and a swap needs a card on both sides", () => {
    const thief = new Player("5", "Thief");
    const victim = new Player("6", "Victim");
    victim.hand = [card(CardName.ExtraVote)];
    assert.deepEqual(takeRandomCards(victim, thief, 2).map((c) => c.getName()), [CardName.ExtraVote]);
    assert.equal(victim.hand.length, 0);
    assert.equal(swapRandomCards(thief, victim), null);
    assert.deepEqual(names(thief), [CardName.ExtraVote], "nothing moved");

    victim.hand = [card(CardName.SpyShack)];
    swapRandomCards(thief, victim);
    assert.deepEqual(names(thief), [CardName.SpyShack]);
    assert.deepEqual(names(victim), [CardName.ExtraVote]);
  });
});

describe("/reward_challenge", () => {
  beforeEach(() => {
    Game.reset();
    useFastTimings();
  });

  it("has a subcommand for each Reward Challenge card", () => {
    const json = rewardChallenge.data.toJSON();
    const subcommands = (json.options ?? []) as {
      name: string;
      options?: { name: string; required?: boolean }[];
    }[];
    assert.deepEqual(
      subcommands.map((s) => [s.name, (s.options ?? []).map((o) => `${o.name}${o.required ? "" : "?"}`)]),
      [
        ["numbers_game", []],
        ["power_pair", ["player1", "player2"]],
        ["do_or_die", ["player"]],
      ],
    );
  });

  it("keeps the card when the play isn't valid", async () => {
    const game = startTestGame(4);
    const [p1, p2, , p4] = game.players;
    p1.hand = [card(CardName.PowerPair), card(CardName.DoOrDie)];
    takeLife(p4);
    takeLife(p4);
    const attempts: [Record<string, unknown>, RegExp][] = [
      [{ subcommand: "numbers_game" }, /must have the Reward Challenge: It's a Numbers Game card/],
      [{ subcommand: "power_pair", player1: game.userOf(p2), player2: game.userOf(p2) }, /two different players/],
      [{ subcommand: "power_pair", player1: game.userOf(p2), player2: game.userOf(p1) }, /target yourself/],
      [{ subcommand: "power_pair", player1: game.userOf(p2), player2: fakeUser("99") }, /not in the game/],
      [{ subcommand: "do_or_die", player: game.userOf(p4) }, /already been voted out/],
    ];
    for (const [options, error] of attempts) {
      const interaction = game.as(p1, options);
      await rewardChallenge.execute(interaction.asCommand());
      assert.match(interaction.lastText, error);
    }

    Game.tribalCouncilState = TribalCouncilState.Discussion;
    const atTribal = game.as(p1, { subcommand: "do_or_die", player: game.userOf(p2) });
    await rewardChallenge.execute(atTribal.asCommand());
    assert.match(atTribal.lastText, /cannot be played during the tribal council/);

    assert.deepEqual(names(p1), [CardName.PowerPair, CardName.DoOrDie].sort());
    assert.equal(Game.rewardChallenge, null);
  });

  it("It's a Numbers Game: the lowest unique number steals 2 random cards from whoever they choose", async () => {
    const game = startTestGame(5);
    const [p1, p2, p3, p4, p5] = game.players;
    takeLife(p5);
    takeLife(p5); // on the jury, so not playing
    p1.hand = [card(CardName.NumbersGame), card(CardName.CampRaid)];
    p2.hand = [card(CardName.ImmunityIdol), card(CardName.ExtraVote)];
    p3.hand = [];
    p4.hand = [card(CardName.SpyShack)];

    const { interaction, running } = play(game, p1, { subcommand: "numbers_game" });
    const picks = await buttonsReady(game, interaction);
    assert.deepEqual(names(p1), [CardName.CampRaid], "the card is played");
    assert.match(picks.content, /Waiting on: <@1>, <@2>, <@3>, <@4>$/);

    const juror = await press(game, picks, p5, "1");
    assert.match(juror.lastText, /Only players still in the game can pick/);
    const first = await press(game, picks, p1, "2");
    assert.match(first.lastText, /You picked \*\*2\*\*/);
    assert.equal(first.log[0].payload.flags, MessageFlags.Ephemeral, "picks are confirmed privately");
    await press(game, picks, p2, "2");
    await press(game, picks, p3, "4");
    assert.match(picks.content, /Locked in: <@1>, <@2>, <@3>\n⏳ Waiting on: <@4>/);
    assert.doesNotMatch(picks.content, /\*\*[1-5]\*\*/, "nobody's pick is shown yet");
    await press(game, picks, p4, "5");

    const choose = await buttonsReady(game, interaction, "choose who to steal");
    assert.match(choose.content, /The picks: <@1> \*\*2\*\* · <@2> \*\*2\*\* · <@3> \*\*4\*\* · <@4> \*\*5\*\*/);
    assert.match(choose.content, /<@3> wins with the lowest unique number, \*\*4\*\*/);
    assert.deepEqual(buttonsOn(picks), [], "the pick buttons are gone");
    assert.deepEqual(
      buttonsOn(choose).map((b) => b.label),
      ["P1 (1 card)", "P2 (2 cards)", "P4 (1 card)"],
    );
    const notTheWinner = await press(game, choose, p2, /^P4/);
    assert.match(notTheWinner.lastText, /Only <@3> gets to choose/);
    await press(game, choose, p3, /^P2/);
    await running;

    assert.deepEqual(names(p3), [CardName.ExtraVote, CardName.ImmunityIdol].sort());
    assert.equal(p2.hand.length, 0);
    assert.match(game.channel.transcript(), /<@3> stole 2 cards from <@2>!/);
    assert.ok(sentDMs.some((dm) => dm.userId === p3.id && dm.content.includes(CardName.ImmunityIdol)));
    assert.ok(sentDMs.some((dm) => dm.userId === p2.id && dm.content.includes("<@3> stole")));
    assert.equal(Game.rewardChallenge, null);
  });

  it("It's a Numbers Game: nobody wins when every number is picked more than once", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    p1.hand = [card(CardName.NumbersGame)];
    const hands = game.players.map((p) => p.hand.length);

    const { interaction, running } = play(game, p1, { subcommand: "numbers_game" });
    const picks = await buttonsReady(game, interaction);
    await press(game, picks, p1, "1");
    await press(game, picks, p2, "3");
    await press(game, picks, p3, "1");
    await press(game, picks, p4, "3");
    await running;

    assert.match(game.channel.transcript(), /Every number was picked more than once, so nobody wins/);
    assert.deepEqual(game.players.map((p) => p.hand.length), [hands[0] - 1, ...hands.slice(1)]);
  });

  it("It's a Numbers Game: players who don't pick sit out, and a slow winner's victim is random", async () => {
    useFastTimings({ rewardChallengeMs: 100 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    p1.hand = [card(CardName.NumbersGame)];
    for (const player of [p2, p3, p4]) player.hand = [card(CardName.ExtraVote), card(CardName.SpyShack)];

    const { interaction, running } = play(game, p1, { subcommand: "numbers_game" });
    const picks = await buttonsReady(game, interaction);
    await press(game, picks, p1, "1");
    await press(game, picks, p2, "3");
    await running; // the picks time out, then so does the winner's choice

    const transcript = game.channel.transcript();
    assert.match(picks.content, /Time's up/);
    assert.match(transcript, /<@3> and <@4> didn't pick in time and sat this one out/);
    assert.match(transcript, /<@1> wins with the lowest unique number, \*\*1\*\*/);
    assert.match(transcript, /<@1> didn't choose in time, so <@[234]> was picked at random/);
    assert.equal(p1.hand.length, 2);
    assert.deepEqual([p2, p3, p4].map((p) => p.hand.length).sort(), [0, 2, 2]);
  });

  it("It's a Numbers Game: the player being robbed can block it with Sorry for You", async () => {
    useFastTimings({ sorryForYouWindowMs: 5_000, menuMs: 20 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [card(CardName.NumbersGame)];
    p2.hand = [card(CardName.SorryForYou), card(CardName.ImmunityIdol)];
    p3.hand = [card(CardName.ExtraVote)];

    const { interaction, running } = play(game, p1, { subcommand: "numbers_game" });
    const picks = await buttonsReady(game, interaction);
    await press(game, picks, p1, "1");
    await press(game, picks, p2, "1");
    await press(game, picks, p3, "2");

    // P2 is the only other player with cards, so P3 goes straight for them
    await waitFor(() => Game.interruption?.target === p2);
    assert.match(game.channel.transcript(), /<@2> is the only other player with cards/);
    assert.match(game.channel.texts.at(-1)!, /<@3> is trying to steal 2 random cards from <@2>/);
    const block = game.as(p2);
    await sorryForYou.execute(block.asCommand());
    await running;

    assert.deepEqual(names(p2), [CardName.ImmunityIdol]);
    assert.match(game.channel.transcript(), /<@3>'s steal from <@2> was blocked/);
    assert.match(block.texts[0], /stopped <@3>'s action/);
    await waitFor(() => p3.hand.length === 0); // and the thief discards a card
  });

  it("Power Pair: the matching pair each steal from the third, one Sorry for You window at a time", async () => {
    useFastTimings({ sorryForYouWindowMs: 200, menuMs: 20 });
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    p1.hand = [card(CardName.PowerPair), card(CardName.ExtraVote)];
    p2.hand = [];
    p3.hand = [card(CardName.SorryForYou), card(CardName.ImmunityIdol), card(CardName.CampRaid)];

    const { interaction, running } = play(game, p1, {
      subcommand: "power_pair",
      player1: game.userOf(p2),
      player2: game.userOf(p3),
    });
    const picks = await buttonsReady(game, interaction);
    assert.match(picks.content, /<@1> takes on <@2> and <@3>/);
    await press(game, picks, p3, "1");
    await press(game, picks, p1, "2");
    const bystander = await press(game, picks, game.players[3], "2");
    assert.match(bystander.lastText, /This challenge is between <@1>, <@2> and <@3>/);
    await press(game, picks, p2, "2");

    // P3 blocks P1's steal...
    await waitFor(() => Game.interruption?.attacker === p1);
    await sorryForYou.execute(game.as(p3).asCommand());
    // ...but P2's steal is a separate window, and P3 has no Sorry for You left
    await waitFor(() => Game.interruption?.attacker === p2);
    await running;

    const transcript = game.channel.transcript();
    assert.match(transcript, /<@1> \*\*2\*\* · <@2> \*\*2\*\* · <@3> \*\*1\*\*/);
    assert.match(transcript, /<@1> and <@2> match, so they each steal 1 random card from <@3>/);
    assert.match(transcript, /<@1>'s steal from <@3> was blocked/);
    assert.match(transcript, /<@2> stole a card from <@3>!/);
    assert.equal(p2.hand.length, 1);
    assert.equal(p3.hand.length, 1);
    await waitFor(() => p1.hand.length === 0); // blocked, so P1 discards
  });

  it("Power Pair: all different plays again, and three of a kind each discard a card", async () => {
    useFastTimings({ menuMs: 300 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [card(CardName.PowerPair), card(CardName.CampRaid), card(CardName.ExtraVote)];
    p2.hand = [card(CardName.SpyShack)];
    p3.hand = [card(CardName.ImmunityIdol), card(CardName.ExtraVote)];

    const { interaction, running } = play(game, p1, {
      subcommand: "power_pair",
      player1: game.userOf(p2),
      player2: game.userOf(p3),
    });
    const round1 = await buttonsReady(game, interaction);
    await press(game, round1, p1, "1");
    await press(game, round1, p2, "2");
    await press(game, round1, p3, "3");

    const round2 = await buttonsReady(game, interaction, "round 2");
    assert.match(round2.content, /<@1> \*\*1\*\* · <@2> \*\*2\*\* · <@3> \*\*3\*\*\nAll three are different, so play again!/);
    await press(game, round2, p1, "3");
    await press(game, round2, p2, "3");
    await press(game, round2, p3, "3");
    await running;
    assert.match(game.channel.transcript(), /All three match, so each of you discards 1 card/);

    // P1 picks what to discard; the others run out of time and lose a random card
    const notice = game.channel.messages.find((m) => m.content.startsWith("<@1> must discard"))!;
    const open = game.as(p1);
    open.customId = "forced_discard_open";
    await notice.collectors[0].click(open.asButton());
    const [selectCollector, buttonCollector] = open.followUps[0].collectors;
    const select = game.as(p1);
    select.customId = "forced_discard_select";
    select.values = [CardName.CampRaid];
    await selectCollector.click(select.asButton());
    const confirm = game.as(p1);
    confirm.customId = "forced_discard_confirm";
    await buttonCollector.click(confirm.asButton());

    assert.deepEqual(names(p1), [CardName.ExtraVote]);
    await waitFor(() => p2.hand.length === 0 && p3.hand.length === 1);
  });

  it("Do or Die: the winner steals 2 random cards, even from the player who started it", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [card(CardName.DoOrDie), card(CardName.ImmunityIdol), card(CardName.ExtraVote)];
    p2.hand = [];

    const { interaction, running } = play(game, p1, { subcommand: "do_or_die", player: game.userOf(p2) });
    const throws = await buttonsReady(game, interaction);
    assert.deepEqual(buttonsOn(throws).map((b) => b.label), ["Rock", "Paper", "Scissors"]);
    await press(game, throws, p1, "Rock");
    const again = await press(game, throws, p1, "Paper");
    assert.match(again.lastText, /You already picked 🪨 \*\*Rock\*\*/);
    await press(game, throws, p2, "Paper");
    await running;

    const transcript = game.channel.transcript();
    assert.match(transcript, /<@1> 🪨 \*\*Rock\*\* · <@2> 📄 \*\*Paper\*\*/);
    assert.match(transcript, /<@2> wins and steals 2 random cards from <@1>!/);
    assert.deepEqual(names(p2), [CardName.ExtraVote, CardName.ImmunityIdol].sort());
    assert.equal(p1.hand.length, 0);
  });

  it("Do or Die: a tie swaps a random card", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [card(CardName.DoOrDie), card(CardName.CampRaid)];
    p2.hand = [card(CardName.SpyShack)];

    const { interaction, running } = play(game, p1, { subcommand: "do_or_die", player: game.userOf(p2) });
    const throws = await buttonsReady(game, interaction);
    await press(game, throws, p1, "Scissors");
    await press(game, throws, p2, "Scissors");
    await running;

    assert.match(game.channel.transcript(), /It's a tie, so <@1> and <@2> swapped a random card/);
    assert.deepEqual(names(p1), [CardName.SpyShack]);
    assert.deepEqual(names(p2), [CardName.CampRaid]);
    assert.ok(sentDMs.some((dm) => dm.userId === p1.id && dm.content.includes("got **The Spy Shack** back")));
  });

  it("Do or Die: whoever doesn't throw in time gets a random throw", async () => {
    useFastTimings({ rewardChallengeMs: 50 });
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [card(CardName.DoOrDie), card(CardName.CampRaid), card(CardName.ExtraVote)];
    p2.hand = [card(CardName.SpyShack), card(CardName.ImmunityIdol)];

    const { interaction, running } = play(game, p1, { subcommand: "do_or_die", player: game.userOf(p2) });
    await press(game, await buttonsReady(game, interaction), p1, "Rock");
    await running;

    assert.match(game.channel.transcript(), /<@2> \S+ \*\*(Rock|Paper|Scissors)\*\* \(random\)/);
    assert.equal(p1.hand.length + p2.hand.length, 4, "cards change hands, but none go missing");
  });

  it("only one challenge at a time, and nobody draws until it's over", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [card(CardName.NumbersGame)];
    p2.hand = [card(CardName.DoOrDie)];
    Game.deck.addCard(card(CardName.ExtraVote)); // the next draw isn't a Tribal Council

    const { interaction, running } = play(game, p1, { subcommand: "numbers_game" });
    const picks = await buttonsReady(game, interaction);

    const second = game.as(p2, { subcommand: "do_or_die", player: game.userOf(p3) });
    await rewardChallenge.execute(second.asCommand());
    assert.match(second.lastText, /already being played/);
    assert.equal(p2.hand.length, 1, "the second card isn't used up");

    const tooSoon = game.as(p1);
    await draw.execute(tooSoon.asCommand());
    assert.match(tooSoon.lastText, /Reward Challenge is still being played/);
    assert.equal(Game.currentPlayer(), p1);

    for (const player of game.players) await press(game, picks, player, "1");
    await running;
    const afterwards = game.as(p1);
    await draw.execute(afterwards.asCommand());
    assert.match(afterwards.texts[0], /You drew a Extra Vote/);
  });

  it("/end_game calls off a challenge in progress", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [card(CardName.DoOrDie)];
    p2.hand = [card(CardName.ImmunityIdol)];

    const { interaction, running } = play(game, p1, { subcommand: "do_or_die", player: game.userOf(p2) });
    const throws = await buttonsReady(game, interaction);
    await press(game, throws, p1, "Rock");

    const end = game.as(p2);
    await endGame.execute(end.asCommand());
    const confirm = game.as(p2);
    confirm.customId = "end_game_confirm";
    await end.replyMessage!.collectors[0].click(confirm.asButton());
    await running;

    assert.equal(Game.active, false);
    assert.equal(Game.rewardChallenge, null);
    assert.match(throws.content, /called off/);
    assert.deepEqual(buttonsOn(throws), []);
    assert.deepEqual(names(p2), [CardName.ImmunityIdol]);
    assert.ok(!game.channel.transcript().includes("Rock, paper, scissors, shoot"));
  });

  it("a new game started during the reveal doesn't get a leftover steal", async () => {
    const game = startTestGame(3);
    const [p1, p2] = game.players;
    p1.hand = [card(CardName.DoOrDie)];
    p2.hand = [card(CardName.SpyShack)];

    const { interaction, running } = play(game, p1, { subcommand: "do_or_die", player: game.userOf(p2) });
    const throws = await buttonsReady(game, interaction);
    await press(game, throws, p1, "Rock");
    game.channel.sendDelayMs = 30; // the reveal is slow to post...
    await press(game, throws, p2, "Scissors");
    startTestGame(3); // ...and a new game starts meanwhile
    await running;

    assert.equal(game.channel.messages.length, 1, "no steal countdown was posted");
    assert.match(game.channel.texts[0], /<@1> wins and steals 2 random cards from <@2>!/);
    assert.deepEqual(names(p2), [CardName.SpyShack]);
  });
});
