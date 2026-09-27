import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActionRowBuilder, ButtonBuilder, MessageFlags } from "discord.js";
import { Game, TribalCouncilState } from "../src/game/game";
import Card from "../src/game/card";
import { CardName } from "../src/game/cards";
import type Player from "../src/game/player";
import formAlliance from "../src/commands/game/form_alliance";
import sorryForYou from "../src/commands/game/sorry_for_you";
import {
  FakeInteraction,
  FakeMessage,
  fakeUser,
  sentDMs,
  useFastTimings,
  waitFor,
} from "./helpers/discord_fakes";
import { TestGame, startTestGame, takeLife } from "./helpers/game_setup";

useFastTimings();

const names = (hand: Card[]) => hand.map((card) => card.getName());

function playAlliance(game: TestGame, player: Player, partner: Player, target: Player) {
  const command = game.as(player, {
    partner: game.userOf(partner),
    target: game.userOf(target),
  });
  return { command, playing: formAlliance.execute(command.asCommand()) };
}

/** The message with the partner's buttons, if one was posted. */
function pickerOf(command: FakeInteraction): FakeMessage | undefined {
  return command.followUps.find((message) => message.collectors.length > 0);
}

/** Ids of the players on the partner's buttons. */
function offered(picker: FakeMessage): string[] {
  const rows = (picker.payload.components ?? []) as ActionRowBuilder<ButtonBuilder>[];
  return rows.flatMap((row) =>
    row.components.map((button) => (button.data as { custom_id: string }).custom_id.split(":")[1]),
  );
}

function buttonClick(game: TestGame, by: Player, victim: Player): FakeInteraction {
  const click = game.as(by);
  click.customId = `form_alliance:${victim.id}`;
  return click;
}

/** `by` clicks the button for `victim`; resolves once the click is handled. */
async function pick(game: TestGame, picker: FakeMessage, by: Player, victim: Player) {
  const click = buttonClick(game, by, victim);
  await picker.collectors[0].click(click.asButton());
  return click;
}

function publicTexts(interaction: FakeInteraction): string[] {
  return interaction.log
    .filter((entry) => entry.payload.flags !== MessageFlags.Ephemeral)
    .map((entry) => entry.payload.content ?? "");
}

function privateTexts(interaction: FakeInteraction): string[] {
  return interaction.log
    .filter((entry) => entry.payload.flags === MessageFlags.Ephemeral)
    .map((entry) => entry.payload.content ?? "");
}

describe("/form_alliance", () => {
  beforeEach(() => {
    Game.reset();
    useFastTimings();
    sentDMs.length = 0;
  });

  it("rejects a bad partner or target without using up the card", async () => {
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    takeLife(p4);
    takeLife(p4);
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p3.hand = [];
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ partner: game.userOf(p1), target: game.userOf(p2) }, /alliance with yourself/],
      [{ partner: fakeUser("99"), target: game.userOf(p2) }, /partner must be a player/],
      [{ partner: game.userOf(p4), target: game.userOf(p2) }, /<@4> has already been voted out/],
      [{ partner: game.userOf(p2), target: game.userOf(p2) }, /can't steal from each other/],
      [{ partner: game.userOf(p2), target: game.userOf(p1) }, /can't target yourself/],
      [{ partner: game.userOf(p2), target: game.userOf(p4) }, /<@4> has already been voted out/],
      [{ partner: game.userOf(p2), target: game.userOf(p3) }, /<@3> has no cards to steal/],
    ];
    for (const [options, error] of cases) {
      const attempt = game.as(p1, options);
      await formAlliance.execute(attempt.asCommand());
      assert.match(attempt.lastText, error);
    }
    assert.deepEqual(names(p1.hand), [CardName.FormAnAlliance], "the card is kept");
    assert.equal(Game.interruption, null, "no Sorry for You window was opened");
  });

  it("needs the card, and can't be played at Tribal Council", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    const options = { partner: game.userOf(p2), target: game.userOf(p3) };
    p1.hand = [];
    const noCard = game.as(p1, options);
    await formAlliance.execute(noCard.asCommand());
    assert.match(noCard.lastText, /must have the Let's Form an Alliance card/);

    p1.hand = [new Card(CardName.FormAnAlliance)];
    Game.tribalCouncilState = TribalCouncilState.Discussion;
    const atCouncil = game.as(p1, options);
    await formAlliance.execute(atCouncil.asCommand());
    assert.match(atCouncil.lastText, /cannot be played during the tribal council/);
    assert.equal(p1.hand.length, 1);
  });

  it("both partners steal a random card, and only the partner picks their victim", async () => {
    useFastTimings({ menuMs: 5_000 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p2.hand = [];
    p3.hand = [new Card(CardName.ImmunityIdol), new Card(CardName.ImmunityIdol)];
    p4.hand = [new Card(CardName.CampRaid)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;

    // The player's steal: the card is used up and one of p3's cards is taken
    assert.deepEqual(names(p1.hand), [CardName.ImmunityIdol]);
    assert.equal(p3.hand.length, 1);
    assert.match(
      command.texts[0],
      /<@1> played \*\*Let's Form an Alliance\*\* with <@2>! <@1> is attempting to steal from <@3>/,
    );
    assert.ok(publicTexts(command).some((text) => text.includes("<@1> has stolen a card from <@3>!!!")));
    assert.deepEqual(privateTexts(command), ["You successfully stole *Immunity Idol* from <@3>!"]);
    assert.ok(sentDMs.some((dm) => dm.userId === p3.id && dm.content.includes("<@1> stole **Immunity Idol**")));

    // The partner can steal from the same player, but not from their partner
    const picker = pickerOf(command)!;
    assert.match(picker.content, /<@2>, you're <@1>'s alliance partner/);
    assert.deepEqual(offered(picker), [p3.id, p4.id]);

    const outsider = await pick(game, picker, p3, p4);
    assert.match(outsider.lastText, /Only <@2> can pick/);
    assert.equal(p4.hand.length, 1);

    const click = await pick(game, picker, p2, p3);
    assert.equal(picker.edits.length, 0, "the pick isn't mistaken for a timeout");
    assert.equal(click.log[0].kind, "update", "the countdown replaces the buttons");
    assert.deepEqual(click.log[0].payload.components, []);
    assert.match(click.texts[0], /<@2> is attempting to steal from <@3>/);
    assert.deepEqual(names(p2.hand), [CardName.ImmunityIdol]);
    assert.equal(p3.hand.length, 0);
    assert.ok(publicTexts(click).some((text) => text.includes("<@2> has stolen a card from <@3>!!!")));
    assert.deepEqual(
      privateTexts(click),
      ["You successfully stole *Immunity Idol* from <@3>!"],
      "only the partner is told what they took",
    );
    assert.ok(sentDMs.some((dm) => dm.userId === p3.id && dm.content.includes("<@2> stole **Immunity Idol**")));
    assert.ok(
      ![...publicTexts(command), ...publicTexts(click)].some((text) => text.includes("Immunity Idol")),
      "the public messages don't reveal the stolen cards",
    );

    const again = await pick(game, picker, p2, p4);
    assert.match(again.lastText, /too late to pick/);
    assert.deepEqual(names(p4.hand), [CardName.CampRaid]);
  });

  it("Sorry for You blocks the player's steal, and the partner still gets theirs", async () => {
    useFastTimings({ sorryForYouWindowMs: 5_000, menuMs: 5_000 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)]; // nothing to discard once it's played
    p2.hand = [];
    p3.hand = [new Card(CardName.SorryForYou), new Card(CardName.ImmunityIdol)];
    p4.hand = [new Card(CardName.CampRaid)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await waitFor(() => Game.interruption !== null);
    const block = game.as(p3);
    await sorryForYou.execute(block.asCommand());
    await playing;

    assert.match(block.texts[0], /stopped <@1>'s action/);
    assert.deepEqual(names(p3.hand), [CardName.ImmunityIdol], "Sorry for You is used up; nothing stolen");
    assert.equal(p1.hand.length, 0, "the alliance card is still used up");
    assert.ok(publicTexts(command).some((text) => text.includes("<@1>'s steal from <@3> was interrupted")));
    assert.deepEqual(privateTexts(command), ["Your steal attempt was interrupted!"]);

    useFastTimings({ menuMs: 5_000 }); // the partner's window closes quickly
    await pick(game, pickerOf(command)!, p2, p4);
    assert.deepEqual(names(p2.hand), [CardName.CampRaid]);
    assert.equal(p4.hand.length, 0);
  });

  it("Sorry for You blocks the partner's steal, and the partner must discard", async () => {
    useFastTimings({ menuMs: 5_000 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p2.hand = [];
    p3.hand = [new Card(CardName.ExtraVote)];
    p4.hand = [new Card(CardName.SorryForYou), new Card(CardName.ImmunityIdol)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;
    assert.deepEqual(names(p1.hand), [CardName.ExtraVote]);

    useFastTimings({ sorryForYouWindowMs: 5_000, menuMs: 5_000 });
    const click = buttonClick(game, p2, p4);
    const picking = pickerOf(command)!.collectors[0].click(click.asButton());
    await waitFor(() => Game.interruption?.attacker === p2);
    const block = game.as(p4);
    await sorryForYou.execute(block.asCommand());
    await picking;

    assert.match(block.texts[0], /stopped <@2>'s action! <@2> must discard 1 card/);
    assert.deepEqual(names(p4.hand), [CardName.ImmunityIdol]);
    assert.equal(p2.hand.length, 0);
    assert.ok(publicTexts(click).some((text) => text.includes("<@2>'s steal from <@4> was interrupted")));
    assert.deepEqual(privateTexts(click), ["Your steal attempt was interrupted!"]);
  });

  it("the partner doesn't steal if they don't pick in time", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p2.hand = [];
    p3.hand = [new Card(CardName.ExtraVote), new Card(CardName.ExtraVote)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;
    const picker = pickerOf(command)!;
    await waitFor(() => picker.edits.length > 0);

    assert.match(picker.content, /<@2> didn't pick in time/);
    assert.deepEqual(picker.payload.components, [], "the buttons are gone");

    // A click that arrives just after the timeout doesn't steal
    const late = await pick(game, picker, p2, p3);
    assert.match(late.lastText, /too late to pick/);
    assert.equal(p2.hand.length, 0);
    assert.equal(p3.hand.length, 1);
  });

  it("keeps the buttons up while the partner can't steal yet", async () => {
    useFastTimings({ menuMs: 5_000 });
    const game = startTestGame(4);
    const [p1, p2, p3, p4] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p2.hand = [];
    p3.hand = [new Card(CardName.ExtraVote), new Card(CardName.ExtraVote)];
    p4.hand = [new Card(CardName.CampRaid)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;
    const picker = pickerOf(command)!;

    // Someone else's Sorry for You window is open
    const otherSteal = Game.openInterruptWindow(p3, p4, 60_000)!;
    const busy = await pick(game, picker, p2, p4);
    assert.match(busy.lastText, /Wait a moment and try again/);
    Game.blockInterruption();
    await otherSteal;

    // p4 has run out of cards since the buttons were posted
    p4.hand = [];
    const empty = await pick(game, picker, p2, p4);
    assert.match(empty.lastText, /<@4> has no cards to steal! Pick someone else/);

    assert.equal(picker.collectors[0].ended, false, "the buttons are still up");
    await pick(game, picker, p2, p3);
    assert.deepEqual(names(p2.hand), [CardName.ExtraVote]);
  });

  it("skips the partner's steal when nobody they could steal from has cards", async () => {
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p3.hand = [new Card(CardName.ExtraVote)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;

    assert.deepEqual(names(p1.hand), [CardName.ExtraVote]);
    assert.match(command.lastText, /<@2> would steal next, but nobody they can steal from has any cards/);
    assert.equal(pickerOf(command), undefined);
  });

  it("stops if the game ends during the player's steal", async () => {
    useFastTimings({ sorryForYouWindowMs: 5_000 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p3.hand = [new Card(CardName.ExtraVote)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await waitFor(() => Game.interruption !== null);
    Game.reset();
    await playing;

    assert.match(command.lastText, /The game ended before <@1> could steal from <@3>/);
    assert.equal(p3.hand.length, 1);
    assert.equal(pickerOf(command), undefined, "the partner isn't asked to pick");
  });

  it("stops if the game ends while the partner is picking", async () => {
    useFastTimings({ menuMs: 5_000 });
    const game = startTestGame(3);
    const [p1, p2, p3] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p2.hand = [];
    p3.hand = [new Card(CardName.ExtraVote), new Card(CardName.ExtraVote)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;
    const picker = pickerOf(command)!;

    startTestGame(3); // a new game starts before the partner picks
    const click = await pick(game, picker, p2, p3);
    assert.match(click.lastText, /The game ended before <@2> picked/);
    assert.deepEqual(click.log[0].payload.components, []);
    assert.equal(p2.hand.length, 0);
    assert.equal(p3.hand.length, 1);
  });

  it("a partner voted out before picking doesn't steal", async () => {
    useFastTimings({ menuMs: 5_000 });
    const game = startTestGame(4);
    const [p1, p2, p3] = game.players;
    p1.hand = [new Card(CardName.FormAnAlliance)];
    p2.hand = [];
    p3.hand = [new Card(CardName.ExtraVote), new Card(CardName.ExtraVote)];

    const { command, playing } = playAlliance(game, p1, p2, p3);
    await playing;
    takeLife(p2);
    takeLife(p2);

    const click = await pick(game, pickerOf(command)!, p2, p3);
    assert.match(click.lastText, /<@2> was voted out before picking/);
    assert.equal(p2.hand.length, 0);
    assert.equal(p3.hand.length, 1);
  });
});
