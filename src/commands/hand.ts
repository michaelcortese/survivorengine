/**
 * `/hand` — the one surface in this game that is never public.
 *
 * Three defects shaped this file:
 *
 *  - Audit #126 sent public-by-rule facts ephemerally and private ones publicly. A hand is the
 *    one thing that genuinely IS private, so this is the command that may be ephemeral, and it
 *    goes out through `ctx.reply.send` — never `announce`, never a public interaction reply.
 *  - Audit #86: the old `/hand` built one unbounded string and Discord rejected the whole
 *    message with a 400 once a hand reached about a dozen distinct card kinds, so the player
 *    saw NOTHING. Here the page is packed against `config.discord` ceilings and what does not
 *    fit moves to the next page — every card's full printed rules text stays reachable. Nothing
 *    is silently dropped.
 *  - Audit #39/#50: cards are named by uid and rendered from the catalog, never addressed by a
 *    position in an array. This command never mutates anything, so there is nothing to address
 *    at all — the pagination buttons carry a page number and are re-read against a fresh
 *    `privateView()` on every press.
 *
 * The summary embeds come from `render.handEmbeds`, so `/hand`, the private couriers and any
 * future surface all describe a hand the same way. What this file adds is the Survival Guide
 * detail — official rules text and art, per card kind you actually hold — plus "what you can do
 * right now", taken from `legalActions()` rather than from an opinion about the turn structure.
 */

import { ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { bold, instanceName, italic, truncate } from "../discord/format.js";
import type {
  Command,
  CommandContext,
  ComponentContext,
  Payload,
} from "../discord/interactions.js";
import type { GameSession } from "../discord/registry.js";
import { handEmbeds, timingText } from "../discord/render.js";
import {
  ACTION_LABEL,
  UI_INTENT,
  argAt,
  button,
  buttonRows,
  type Row,
} from "../discord/ui.js";
import { CARD_CATALOG } from "../engine/cards.js";
import type {
  ActionKind,
  CardInstance,
  CardKind,
  LegalAction,
  PlayerId,
  Result,
} from "../engine/types.js";
import { err, ok } from "../engine/types.js";

const ACCENT = 0x2f6f4e;

/**
 * The flow tag on the pagination buttons, and therefore the route key this command claims.
 *
 * `UI_INTENT.Refresh` has a generic meaning in the router (re-post the public board), so the
 * tag is not optional decoration: `routeKeysFor` tries `"ur:hand"` before the bare `"ur"`, and
 * without it a page turn would fall through to the generic handler and print the status board
 * into somebody's private hand.
 */
const HAND_PAGE_FLOW = "hand";
const HAND_PAGE_ROUTE = `${UI_INTENT.Refresh}:${HAND_PAGE_FLOW}`;

// ---------------------------------------------------------------------------
// Card detail
// ---------------------------------------------------------------------------

/**
 * How a legal action is actually reached, so the list is instructions rather than vocabulary.
 *
 * `Record<ActionKind, string>` on purpose: a 41st action cannot be added without deciding what
 * a player is supposed to press, which is audit #82 ("the message names a command that does
 * not exist") pointed at its own root cause. Every command named here exists in the surface
 * `/help commands` lists.
 */
const ACTION_HINT: Readonly<Record<ActionKind, string>> = {
  join_game: "the lobby message",
  leave_game: "the lobby message",
  choose_color: "the lobby message",
  name_castaways: "`/castaways`, or the lobby message",
  start_game: "the lobby message",
  abandon_game: "`/survivor abandon`",
  remove_player: "the lobby message",
  transfer_host: "`/survivor host <player>`",

  steal_random: "`/steal <player>`",

  play_camp_raid: "`/play`",
  play_knowledge_is_power: "`/play`",
  play_spy_shack: "`/play`",
  play_lets_form_an_alliance: "`/play`",
  play_do_or_die: "`/play`",
  play_power_pair: "`/play`",
  play_its_a_numbers_game: "`/play`",
  skip_play_step: "`/skip`",
  draw_card: "`/draw`",

  play_sorry_for_you: "the prompt in the channel",
  play_inheritance: "the prompt in the channel",
  decline_reaction: "the prompt in the channel",
  submit_challenge_choice: "the challenge prompt in the channel",
  choose_alliance_target: "the prompt in the channel",
  choose_card: "the prompt in the channel",
  choose_steal_victim: "the prompt in the channel",
  discard_card: "the prompt in the channel",

  advance_council: "`/council`",
  // The five cards played AT a council are on the `/council` panel, not `/play`: `/play` is
  // turn step 2 and its menu holds only the seven cards playable on your own turn.
  play_control_the_vote: "`/council`",
  play_goodwill_gamble: "`/council`",
  play_im_the_leader_now: "`/council`",
  cast_vote: "`/vote <player>`",
  finish_voting: "the voting prompt in the channel",
  play_immunity_idol: "`/council`",
  play_idol_nullifier: "`/council`",
  leader_choose_eliminations: "`/council`",

  advance_final_council: "`/council`",
  reveal_hand: "the Final Tribal Council prompt",
  juror_ready: "the Final Tribal Council prompt",
  cast_jury_vote: "the Final Tribal Council prompt",
  final_leader_break_tie: "the Final Tribal Council prompt",
};

/** One entry per distinct card kind held, with the instance names behind it. */
interface HandGroup {
  readonly kind: CardKind;
  readonly count: number;
  /** Inheritance and character cards are named by colour, so the instances are kept. */
  readonly names: readonly string[];
}

function groupHand(hand: readonly CardInstance[]): readonly HandGroup[] {
  const byKind = new Map<CardKind, string[]>();
  for (const card of hand) {
    const names = byKind.get(card.kind);
    if (names) names.push(instanceName(card));
    else byKind.set(card.kind, [instanceName(card)]);
  }
  return [...byKind.entries()]
    .map(([kind, names]) => ({ kind, count: names.length, names }))
    .sort((a, b) => CARD_CATALOG[a.kind].sortOrder - CARD_CATALOG[b.kind].sortOrder);
}

/**
 * The Survival Guide entry for a card you are holding: VERBATIM printed rules text, when you
 * may play it, and the art. Audit #92 — rules text paraphrased from memory in three places —
 * is why nothing here is written by hand; every word comes from `CARD_CATALOG`.
 */
function detailEmbed(group: HandGroup, config: SurvivorConfig): EmbedBuilder {
  const definition = CARD_CATALOG[group.kind];
  // Two Inheritance cards are two different cards; two Camp Raids are the same card twice.
  const coloured = group.names.some((name) => name !== definition.name);
  const body = coloured
    ? `${italic(group.names.join(" · "))}\n\n${definition.rulesText}`
    : definition.rulesText;

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(group.count > 1 ? `${definition.name} ×${group.count}` : definition.name)
    .setDescription(truncate(body, config.discord.maxEmbedDescriptionLength))
    .addFields({
      name: "When you can play it",
      // The same sentence the `/card` Survival Guide entry prints. Shared rather than
      // re-worded here: one card, one answer, wherever it is asked.
      value: timingText(definition.timing),
    });

  // Audit #90: art was pasted as a bare URL and vanished for anyone without Embed Links.
  if (config.discord.renderCardArt && definition.imageUrl !== null) {
    embed.setThumbnail(definition.imageUrl);
  }
  return embed;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Everything Discord counts towards a message's embed budget.
 *
 * Measured rather than estimated, because the whole point of paginating is that the estimate
 * was what blew up: the old `/hand` assumed a hand was small and lost the entire message when
 * it was not.
 */
function embedLength(embed: EmbedBuilder): number {
  const data = embed.data;
  let total = (data.title?.length ?? 0) + (data.description?.length ?? 0);
  total += data.footer?.text.length ?? 0;
  total += data.author?.name.length ?? 0;
  for (const field of data.fields ?? [])
    total += field.name.length + field.value.length;
  return total;
}

/**
 * Pack the detail embeds into pages against BOTH ceilings that can reject a message: the
 * number of embeds, and how much text they carry between them.
 *
 * The character budget is one embed description's worth (`maxEmbedDescriptionLength`) for the
 * whole message, which sits comfortably inside Discord's larger per-message embed total — a
 * deliberately conservative bound taken from config rather than a fresh literal (audit #86,
 * "several renderers re-derived Discord's limits and one of them got it wrong").
 *
 * A single group always goes somewhere, even if it is bigger than the budget on its own: a
 * page carrying one oversized card is still a page, whereas skipping it would be exactly the
 * silent truncation this command exists to avoid.
 */
function paginate(
  details: readonly EmbedBuilder[],
  slots: number,
  budget: number,
): readonly (readonly EmbedBuilder[])[] {
  const pages: EmbedBuilder[][] = [];
  let current: EmbedBuilder[] = [];
  let used = 0;

  for (const embed of details) {
    const cost = embedLength(embed);
    const full = current.length >= slots || used + cost > budget;
    if (current.length > 0 && full) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(embed);
    used += cost;
  }
  if (current.length > 0) pages.push(current);
  // An empty hand is still one (empty) page, so the caller never indexes into nothing.
  return pages.length > 0 ? pages : [[]];
}

/** Previous / page marker / next. Minted against the live nonce like every other component. */
function pageControls(
  session: GameSession,
  actor: PlayerId,
  index: number,
  total: number,
  config: SurvivorConfig,
): readonly Row[] {
  const parts = session.uiContext(actor);
  return buttonRows(
    [
      button(
        {
          parts: {
            ...parts,
            intent: UI_INTENT.Refresh,
            args: [HAND_PAGE_FLOW, String(Math.max(0, index - 1))],
          },
          label: "◀ Previous",
          style: ButtonStyle.Secondary,
          disabled: index === 0,
        },
        config.discord,
      ),
      // Inert: the router acknowledges it and says nothing. It is a label, not an affordance.
      button(
        {
          parts: { ...parts, intent: UI_INTENT.Inert, args: [] },
          label: `Page ${index + 1} of ${total}`,
          style: ButtonStyle.Secondary,
          disabled: true,
        },
        config.discord,
      ),
      button(
        {
          parts: {
            ...parts,
            intent: UI_INTENT.Refresh,
            args: [HAND_PAGE_FLOW, String(Math.min(total - 1, index + 1))],
          },
          label: "Next ▶",
          style: ButtonStyle.Secondary,
          disabled: index >= total - 1,
        },
        config.discord,
      ),
    ],
    config.discord,
  );
}

// ---------------------------------------------------------------------------
// What you can do right now
// ---------------------------------------------------------------------------

/**
 * Straight out of `legalActions()`.
 *
 * Audit #88 in prose form: the old bot told players what they could do from a hardcoded idea
 * of the turn structure, which disagreed with the validator often enough that people learned
 * to ignore it. If the engine does not offer the action, it does not appear here.
 */
function whatYouMayDo(actions: readonly LegalAction[]): string {
  const seen = new Set<ActionKind>();
  const lines: string[] = [];
  for (const action of actions) {
    if (seen.has(action.kind)) continue;
    seen.add(action.kind);
    lines.push(`• ${bold(ACTION_LABEL[action.kind])} — ${ACTION_HINT[action.kind]}`);
  }
  return lines.length === 0
    ? "Nothing right now. `/status` shows who everyone is waiting on."
    : lines.join("\n");
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * One page of the hand, built fresh from the engine.
 *
 * Shared by the command and the page buttons on purpose: a press re-reads `privateView()` and
 * `legalActions()` rather than paging through a snapshot captured when the message was posted,
 * so a hand that changed while the message sat there is simply shown as it now is.
 */
function handPayload(
  session: GameSession,
  actor: PlayerId,
  nowMs: number,
  config: SurvivorConfig,
  requestedPage: number,
): Result<Payload> {
  const privateView = session.privateView(actor);
  if (privateView === null) {
    return err("not_in_game", "no private view: this player is not at this table", {
      actor,
    });
  }

  const base = [...handEmbeds(privateView, session.view(), config)];
  const header = base[0];
  if (header === undefined) {
    return err("internal_invariant_violated", "handEmbeds returned no embeds");
  }
  header.addFields({
    name: "What you can do right now",
    value: truncate(
      whatYouMayDo(session.legalActions(actor, nowMs)),
      config.discord.maxEmbedFieldValueLength,
    ),
  });

  const details = groupHand(privateView.hand).map((group) =>
    detailEmbed(group, config),
  );
  const baseLength = base.reduce((sum, embed) => sum + embedLength(embed), 0);
  const pages = paginate(
    details,
    Math.max(1, config.discord.maxEmbedsPerMessage - base.length),
    Math.max(0, config.discord.maxEmbedDescriptionLength - baseLength),
  );

  const index = Math.min(Math.max(requestedPage, 0), pages.length - 1);
  const page = pages[index] ?? [];
  if (pages.length > 1) {
    header.setFooter({
      text: `Page ${index + 1} of ${pages.length} — every card you hold has its full rules text on one of these pages.`,
    });
  }

  return ok({
    embeds: [...base, ...page],
    components:
      pages.length > 1 ? pageControls(session, actor, index, pages.length, config) : [],
  });
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const hand: Command = {
  data: new SlashCommandBuilder()
    .setName("hand")
    .setDescription(
      "Privately: your cards and their rules, your votes, your torches, and what you can do.",
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) return ctx.reply.fail(found.error);
    const session = found.value;

    // Close anything whose deadline has already passed before reading legality, so "what you
    // can do right now" is true at the moment it is printed rather than a second ago.
    session.tick(ctx.nowMs);

    const payload = handPayload(session, ctx.actor, ctx.nowMs, ctx.config, 0);
    if (!payload.ok) return ctx.reply.fail(payload.error);

    // Ephemeral, always. This is the one thing in the game nobody else may see.
    await ctx.reply.send(payload.value);
  },

  components: {
    /**
     * Turn a page. The router has already proved this press belongs to this player, this game
     * and this incarnation, and has already ticked the clock.
     */
    [HAND_PAGE_ROUTE]: async (ctx: ComponentContext): Promise<void> => {
      const raw = argAt(ctx.parsed, 1);
      const requested = raw === null ? 0 : Number.parseInt(raw, 10);
      const payload = handPayload(
        ctx.session,
        ctx.actor,
        ctx.nowMs,
        ctx.config,
        Number.isFinite(requested) ? requested : 0,
      );
      if (!payload.ok) return ctx.reply.fail(payload.error);

      // Edit the ephemeral message the buttons live on rather than stacking a new one up.
      await ctx.reply.update(payload.value);
    },
  },
};

export default hand;
