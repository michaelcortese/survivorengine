/**
 * `/card` — the Survival Guide, with autocomplete.
 *
 * Audit #80/#91: the old `/knowledge_is_power` took a free-text, CASE-SENSITIVE card name with
 * no autocomplete and burned the card on a typo, and audit #113: the reference data it looked
 * names up in was missing four entire card types and disagreed with the printed text of the ones
 * it had. Both are closed the same way — there is exactly one catalog, `engine/cards.ts`, whose
 * `rulesText` is a verbatim transcription of the printed Survival Guide, and exactly one
 * renderer for it, `render.cardEmbed`. This command is the lookup in front of them, and it does
 * not paraphrase a single word.
 *
 * Autocomplete does the matching, so a player normally never types a name at all. But somebody
 * always will, so `execute` re-runs the same match on whatever arrives and, when nothing fits,
 * says which cards were close instead of "There was an error while executing this command!"
 * (audit #23/#118).
 */

import { SlashCommandBuilder } from "discord.js";

import { bold, code, quantity } from "../discord/format.js";
import type {
  AutocompleteContext,
  Command,
  CommandContext,
} from "../discord/interactions.js";
import { CARD_NAME_INDEX } from "../discord/interactions.js";
import { cardEmbed } from "../discord/render.js";
import { lookupCardKindByName } from "../engine/cards.js";
import type { CardKind } from "../engine/types.js";

/** One entry of the pre-sorted `{kind, name, search}` index `interactions.ts` exports. */
type CardEntry = (typeof CARD_NAME_INDEX)[number];

/** How many near-misses a failed lookup offers. Enough to recognise, few enough to read. */
const SUGGESTIONS = 5;

/**
 * Everything matching a partial, case-insensitive query, best first.
 *
 * `search` is the card's name, its `CardKind` and every alias, lower-cased and joined, so
 * "leader", "im the leader now" and "im_the_leader_now" all find the same card. A name that
 * STARTS with the query sorts above one that merely contains it, which is what makes typing
 * "vote" offer Vote before Control the Vote.
 */
function matches(query: string): readonly CardEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return CARD_NAME_INDEX;
  return CARD_NAME_INDEX.filter((entry) => entry.search.includes(needle))
    .slice()
    .sort((a, b) => {
      const rank = (entry: CardEntry): number =>
        entry.name.toLowerCase().startsWith(needle) ? 0 : 1;
      return rank(a) - rank(b);
    });
}

/**
 * A typed or picked value, as a `CardKind`.
 *
 * Autocomplete hands back the `CardKind` itself, and `lookupCardKindByName` resolves that, the
 * printed name and every alias while ignoring case and punctuation. Only a genuinely free-text
 * near-miss ("spy shack pls") falls through to the fuzzy pass.
 */
function resolveCard(raw: string): CardKind | null {
  const exact = lookupCardKindByName(raw);
  if (exact !== null) return exact;
  return matches(raw)[0]?.kind ?? null;
}

const card: Command = {
  data: new SlashCommandBuilder()
    .setName("card")
    .setDescription(
      "Look up any card in the box: its printed rules, when you may play it, and the art.",
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Start typing — every card in the box is in the list")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const requested = ctx.interaction.options.getString("name", true);
    const kind = resolveCard(requested);

    if (kind === null) {
      // Not a `GameError`: the engine was never asked anything. A plain sentence that names
      // real cards is more use than a rule code that does not apply.
      const near = matches(requested)
        .slice(0, SUGGESTIONS)
        .map((entry) => code(entry.name));
      await ctx.reply.send({
        content:
          near.length === 0
            ? `There is no card called ${bold(requested)} in the box. Run \`/card\` again and pick from the list — it has all of them.`
            : `There is no card called ${bold(requested)}. Did you mean ${near.join(", ")}?`,
      });
      return;
    }

    // Reference material for one person, like `/help`: the interaction response is ephemeral,
    // and a player who wants the table to see a card can say what it does out loud.
    const embed = cardEmbed(kind, ctx.config);

    // A small, private courtesy: if you are in this channel's game, say how many you hold.
    // Nothing here is public — it goes out on the same ephemeral response as the card itself.
    const session = ctx.session();
    const privateView = session?.privateView(ctx.actor) ?? null;
    if (privateView !== null) {
      const held = privateView.hand.filter((instance) => instance.kind === kind).length;
      embed.addFields({
        name: "In your hand",
        value:
          held === 0
            ? "None. `/hand` shows what you are holding."
            : `${quantity(held, "copy", "copies")} — \`/hand\` shows the rest of your hand.`,
        inline: true,
      });
    }

    await ctx.reply.send({ embeds: [embed] });
  },

  /**
   * Autocomplete cannot defer: Discord wants an answer inside three seconds or it shows nothing
   * at all. This is a filter over a 19-entry in-memory index, so it answers in microseconds.
   * The router caps the response at Discord's 25-choice ceiling on the way out.
   */
  async autocomplete(ctx: AutocompleteContext): Promise<void> {
    await ctx.respond(
      matches(ctx.focused.value).map((entry) => ({
        name: entry.name,
        // The VALUE is the CardKind, so `execute` resolves it exactly rather than re-matching
        // a display name that could be ambiguous.
        value: entry.kind,
      })),
    );
  },
};

export default card;
