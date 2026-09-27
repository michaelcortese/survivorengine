/**
 * `/draw` — turn step 3, mandatory, and the end of the turn.
 *
 * Drawing is the one step that can never be refused for want of cards. Audit #20 verbatim:
 * "/draw returns 'No cards left in the deck.' … Play cannot continue and cannot conclude." The
 * engine has no `draw_pile_empty` error at all — an empty pile draws successfully and fires the
 * exhaustion policy — so this command has no such branch either, and cannot reintroduce one.
 *
 * Three things can come out of a draw and all three are the engine's decision, narrated by the
 * render pipeline:
 *
 *   * an ordinary card, private to the drawer;
 *   * a Tribal Council card, which stops the game and makes the drawer the Leader — `/council`
 *     takes it from there;
 *   * a Camp Raid resolving, which opens a take window against the drawer for the card they
 *     just drew ("but only after they look at it"). That window needs a prompt with the
 *     drawer's own buttons on it, which the session posts once the draw has been narrated.
 */

import { SlashCommandBuilder } from "discord.js";

import { bold, cardName, mention } from "../discord/format.js";
import type {
  Command,
  CommandContext,
  ComponentHandler,
} from "../discord/interactions.js";
import type { GameEvent } from "../engine/events.js";
import type { PlayerId } from "../engine/types.js";
import { applyAndConfirm } from "./play.js";

/**
 * The drawer's own account of their draw, read from the events the dispatch produced.
 *
 * `card_drawn` is addressed to the drawer alone, so naming the card in an ephemeral reply to
 * that same player reveals nothing. The public half — the pile count, the council, the turn
 * passing — is the renderer's, and is not repeated here (audit #119/#126: the same fact told
 * twice through two different visibility rules is how the two got mixed up in the first place).
 */
function summary(events: readonly GameEvent[], actor: PlayerId): string {
  const lines: string[] = [];

  for (const event of events) {
    if (event.type === "card_drawn" && event.playerId === actor) {
      lines.push(`You drew ${bold(cardName(event.kind))}.`);
    }
    if (event.type === "council_started" && event.leaderId === actor) {
      lines.push(
        `That is a Tribal Council card, so it goes face up in front of you and you are the ${bold("Tribal Council Leader")}. Run it with \`/council\`.`,
      );
    }
    if (event.type === "take_declared" && event.victimId === actor) {
      lines.push(
        `The Camp Raid in front of you is resolving — the prompt in the channel is yours to answer.`,
      );
    }
    if (event.type === "turn_ended" && event.playerId === actor) {
      lines.push(
        event.nextPlayerId === null
          ? "Your turn is over."
          : `Your turn is over. It passes to ${mention(event.nextPlayerId)}.`,
      );
    }
    if (event.type === "draw_pile_exhausted") {
      lines.push("That was the last card: the draw pile is empty.");
    }
  }

  return lines.length === 0 ? "You drew. Your turn is over." : lines.join("\n");
}

/** A Draw button minted anywhere in the bot lands here, so the drawer hears what they drew. */
const pressDraw: ComponentHandler = async (ctx) => {
  await applyAndConfirm(ctx, { type: "draw_card", actor: ctx.actor }, (outcome) =>
    summary(outcome.events, ctx.actor),
  );
};

const draw: Command = {
  data: new SlashCommandBuilder()
    .setName("draw")
    .setDescription("Step 3 of your turn: draw the top card. This ends your turn."),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) {
      await ctx.reply.fail(found.error);
      return;
    }
    const session = found.value;

    const outcome = ctx.dispatch(session, { type: "draw_card", actor: ctx.actor });
    if (!outcome.ok) {
      await ctx.reply.fail(outcome.error);
      return;
    }

    await ctx.reply.send({ content: summary(outcome.value.events, ctx.actor) });
  },

  components: {
    draw_card: pressDraw,
  },
};

export default draw;
