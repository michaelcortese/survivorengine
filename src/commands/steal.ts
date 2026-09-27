/**
 * `/steal` — turn step 1, mandatory.
 *
 * "Steal 1 card at random from any player." Three things have to be true afterwards and the old
 * bot managed one of them:
 *
 *   1. THE TABLE knows a steal happened. Public by rule — hand sizes are public — and it is the
 *      only cue the rest of the table has that the turn has begun. The engine's `take_declared`
 *      and `cards_transferred` events are public and the render pipeline posts them.
 *   2. THE THIEF learns which card they got. Private to the two players involved.
 *   3. THE VICTIM learns a card was taken, and gets the chance to answer it. The old bot told
 *      them NOTHING — a card simply vanished from their hand — and Sorry For You was a command
 *      they had to know to type inside a window they were never shown. Here the engine opens the
 *      window and the session posts its prompt (`/play` owns it), with the victim's own buttons
 *      on it — the same prompt a steal forced by the turn's backstop gets.
 *
 * The dispatch itself is three lines. Everything else in this file is those three facts reaching
 * the right people, and nothing here re-checks a rule: whose turn it is, whether the steal step
 * is still open and whether the target is a legal victim are all the engine's answers.
 */

import { SlashCommandBuilder } from "discord.js";

import { bold, cardName, deadline, mention } from "../discord/format.js";
import type {
  Command,
  CommandContext,
  ComponentContext,
  ComponentHandler,
  Payload,
} from "../discord/interactions.js";
import { UI_INTENT, packPlayerArg, playerOptions, select } from "../discord/ui.js";
import type { GameEvent } from "../engine/events.js";
import type { PlayerId } from "../engine/types.js";
import { asPlayerId } from "../engine/types.js";
import { applyAndConfirm } from "./play.js";

/** `args[0]` of the target picker this command mints. See `ComponentRoutes` for why it exists. */
const FLOW = "stl";

// ---------------------------------------------------------------------------
// What the thief is told
// ---------------------------------------------------------------------------

/**
 * The thief's private receipt, read from the events the dispatch produced.
 *
 * `take_resolved` is addressed to the taker and the victim only, so naming the card here — in an
 * ephemeral reply to the thief — reveals nothing the engine did not already decide they may see.
 * When the steal is still open the receipt says so instead: a Sorry For You may yet blank it.
 */
function receipt(events: readonly GameEvent[], actor: PlayerId): string {
  for (const event of events) {
    if (event.type === "take_resolved" && event.takerId === actor) {
      return event.kinds.length === 0
        ? "You came away with nothing."
        : `You took ${bold(event.kinds.map(cardName).join(", "))} from ${mention(event.victimId)}.`;
    }
    if (event.type === "take_found_nothing" && event.takerId === actor) {
      return `${mention(event.victimId)} had nothing to take. Your steal step is done.`;
    }
  }
  for (const event of events) {
    if (event.type === "take_declared") {
      return `Your steal is declared. ${mention(event.victimId)} may play ${bold("Sorry For You!")} until ${deadline(event.deadlineMs)} — the table will see how it lands.`;
    }
  }
  return "Your steal is in.";
}

// ---------------------------------------------------------------------------
// The picker, for a steal that arrives as a button
// ---------------------------------------------------------------------------

/**
 * `componentsForLegalActions()` mints a `steal_random` button with no victim in it, because the
 * action has a target list and a button cannot carry a choice. Without a handler that press
 * decodes to an action with no target and dies as "I could not work out what that button was
 * meant to do", so the press opens the picker instead.
 */
function victimMenu(ctx: ComponentContext): Payload | null {
  const session = ctx.session;
  const actor = ctx.actor;
  const legal = session
    .legalActions(actor, ctx.nowMs)
    .find((action) => action.kind === "steal_random");
  const targets = legal?.legalTargets ?? [];
  if (targets.length === 0) return null;

  return {
    content: "Step 1: take one card at random. You do not get to choose which card.",
    components: [
      select(
        {
          parts: {
            ...session.uiContext(actor),
            intent: UI_INTENT.Confirm,
            args: [FLOW],
          },
          placeholder: "Who are you stealing from?",
          options: playerOptions(
            session.view().players,
            targets,
            ctx.config.engine.limits.characterCardsPerPlayer,
          ),
        },
        ctx.config.discord,
      ),
    ],
  };
}

const openPicker: ComponentHandler = async (ctx) => {
  const menu = victimMenu(ctx);
  if (menu === null) {
    await ctx.reply.fail({
      code: "wrong_turn_phase",
      message: "there is nobody this player may steal from right now",
    });
    return;
  }
  await ctx.reply.send(menu);
};

const pickVictim: ComponentHandler = async (ctx) => {
  const raw = ctx.values[0];
  const target =
    raw === undefined
      ? null
      : (ctx.session
          .view()
          .players.find(
            (player) => raw === player.id || raw === packPlayerArg(player.id),
          )?.id ?? null);
  if (target === null) {
    await ctx.reply.fail({
      code: "target_not_in_game",
      message: "the picked victim is not at this table",
    });
    return;
  }
  await applyAndConfirm(
    ctx,
    { type: "steal_random", actor: ctx.actor, target },
    `You reach into ${mention(target)}'s hand. Watch the channel — what you got is on its way to you privately.`,
  );
};

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const steal: Command = {
  data: new SlashCommandBuilder()
    .setName("steal")
    .setDescription("Step 1 of your turn: take a random card from another player.")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("Who you are stealing from")
        .setRequired(true),
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) {
      await ctx.reply.fail(found.error);
      return;
    }
    const session = found.value;
    const target = asPlayerId(ctx.interaction.options.getUser("player", true).id);

    const outcome = ctx.dispatch(session, {
      type: "steal_random",
      actor: ctx.actor,
      target,
    });
    if (!outcome.ok) {
      await ctx.reply.fail(outcome.error);
      return;
    }

    // The table already heard it, and the victim's prompt follows the narration: `ctx.dispatch`
    // did both. This is only the thief's own copy.
    await ctx.reply.send({ content: receipt(outcome.value.events, ctx.actor) });
  },

  components: {
    steal_random: openPicker,
    [`${UI_INTENT.Confirm}:${FLOW}`]: pickVictim,
  },
};

export default steal;
