/**
 * `/skip` — decline the optional play step.
 *
 * "Remember: Steal, Play (or don't), then Draw!" Not playing is a real decision, not an absence
 * of one: the turn moves to the draw step immediately, and the table is told, so nobody sits
 * waiting on a player who has already decided. Audit #9 — the three-step turn was not enforced
 * at all — is the reason the step exists as state rather than as etiquette.
 *
 * There is nothing to validate here. Whether the steal is done, whether a card has already been
 * played and whether a window is still open are all the engine's answers, and each of them comes
 * back as a `GameError` that `reply.fail` renders into a sentence naming the rule.
 */

import { SlashCommandBuilder } from "discord.js";

import type { Command, CommandContext } from "../discord/interactions.js";
import { componentsForLegalActions } from "../discord/ui.js";

const skip: Command = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Step 2 of your turn: play nothing, and move on to your draw."),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) {
      await ctx.reply.fail(found.error);
      return;
    }
    const session = found.value;

    const outcome = ctx.dispatch(session, {
      type: "skip_play_step",
      actor: ctx.actor,
    });
    if (!outcome.ok) {
      await ctx.reply.fail(outcome.error);
      return;
    }

    // The table already heard it — `play_step_skipped` is a public event. This is the private
    // half: the one button that is now the whole of this player's turn. Enablement comes from
    // `legalActions()`, so if anything at the table is still being answered it renders dead
    // rather than failing when pressed (audit #88).
    await ctx.reply.send({
      content: "You play no card this turn. All that is left is your draw.",
      components: componentsForLegalActions(
        session.legalActions(ctx.actor, ctx.nowMs),
        {
          ...session.uiContext(ctx.actor),
          only: ["draw_card"],
          showUnavailable: ["draw_card"],
          primary: ["draw_card"],
        },
        ctx.config.discord,
      ),
    });
  },
};

export default skip;
