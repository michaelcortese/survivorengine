/**
 * `/vote` — one card, one name, into the box.
 *
 * ============================ WHAT THIS COMMAND HAS TO GET RIGHT ============================
 *
 *  1. SECRECY, IN BOTH DIRECTIONS. Who you voted for is yours alone until the Leader opens the
 *     box at `tally`; the engine enforces that structurally (`CouncilView.revealedVotes` is
 *     null before `VOTES_PUBLIC_FROM`), so this file's job is simply never to `announce()`
 *     anything derived from a ballot. But "how the vote is GOING" is public by rule — the box
 *     goes round the table in the open — so the channel gets a progress line and the player
 *     gets an ephemeral one. Audit #119/#126 ran in both directions at once: private
 *     information leaked publicly while public-by-rule information was whispered.
 *
 *     The progress line counts PLAYERS who have every card they owe in the box, never CARDS.
 *     `council.voteCount` is a real number on the public view and it is deliberately NOT
 *     announced: the box holding four cards when five people owe one each is exactly the
 *     "somebody is spending Extra Votes" tell that the rulebook's rhythm-tapping ritual exists
 *     to hide. Obligations were announced publicly when voting opened, so counting those back
 *     down reveals nothing that was not already said out loud.
 *
 *  2. EVERY OBLIGATION IS SPENT SEPARATELY. `CouncilState.requiredCasts` is per CARD, not per
 *     player: Control the Vote ("You MUST use that Vote Card IN ADDITION TO your Vote Card")
 *     and Goodwill Gamble ("MUST be used during the Tribal Council at which it is played") each
 *     make one player owe two casts. So a single `/vote` is one card, and the ephemeral ballot
 *     that comes back names what is still owed and which card each remaining vote would use.
 *
 *  3. CARDS BY UID. Every castable card comes out of `legalActions().playableCardUids` and
 *     travels in the custom_id as its uid (audit #39/#50). No hand position is ever computed,
 *     and a ballot re-rendered after the hand changed offers exactly what is castable NOW.
 *
 *  4. THE ENGINE JUDGES. Voting for an eliminated player, for yourself, after passing the box
 *     on, with a card you no longer hold, or when voting is not open are all engine refusals
 *     rendered by `ctx.reply.fail`. This file re-implements none of them.
 *
 * `/vote` also carries the Final Tribal Council's jury ballot, because that is what a juror
 * types. The engine's own guards (`not_a_juror`, `not_a_finalist`, `jury_vote_already_cast`)
 * decide whether it lands, and `FinalCouncilView.juryVotes` stays null until the simultaneous
 * reveal, so nothing here can spoil it.
 */

import {
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type ButtonBuilder,
} from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { bold, instanceName, italic, quantity, truncate } from "../discord/format.js";
import type {
  Command,
  CommandContext,
  ComponentContext,
  Payload,
  Responder,
} from "../discord/interactions.js";
import { actionFromComponent } from "../discord/interactions.js";
import type { GameSession } from "../discord/registry.js";
import { button, buttonRows, packPlayerArg, type Row } from "../discord/ui.js";
import type {
  ActionKind,
  CardUid,
  GameError,
  GameErrorCode,
  GameView,
  LegalAction,
  PlayerId,
} from "../engine/types.js";
import { asPlayerId } from "../engine/types.js";

const COUNCIL_ACCENT = 0xb8860b;
const FINAL_ACCENT = 0x4b0082;

/**
 * A refusal the engine never got the chance to make, phrased by CODE so the sentence still
 * comes from the single `ERROR_COPY` table in `interactions.ts` (audit #23/#118). Used only
 * where no action can be built at all — everywhere else the engine's own `err` is passed
 * straight through.
 */
const refuse = (code: GameErrorCode, message: string): GameError => ({ code, message });

const legalOf = (
  actions: readonly LegalAction[],
  kind: ActionKind,
): LegalAction | null => actions.find((action) => action.kind === kind) ?? null;

const nameOf = (view: GameView, playerId: PlayerId): string =>
  view.players.find((player) => player.id === playerId)?.displayName ?? "somebody";

// ---------------------------------------------------------------------------
// What this player may still put in the box
// ---------------------------------------------------------------------------

/**
 * One castable card, with the reason it is castable.
 *
 * The SOURCE is inferred from which private zone the uid sits in, which is the same test
 * `engine/game.ts:voteSourceOf` applies: a Vote Card (your own or one Control the Vote moved
 * into your pile) lives in `voteCards`, a Goodwill Gamble handed to you lives in
 * `grantedVotes`, and an Extra Vote is an ordinary hand card. The first two are OBLIGATIONS —
 * voting cannot close while either is unspent — and the third is a free choice, which is
 * exactly the distinction a player needs to see before they spend one.
 */
interface Castable {
  readonly uid: CardUid;
  readonly label: string;
  readonly detail: string;
  readonly mandatory: boolean;
}

interface Table {
  readonly session: GameSession;
  readonly actor: PlayerId;
  readonly nowMs: number;
  readonly config: SurvivorConfig;
}

function castablesFor(table: Table): readonly Castable[] {
  const legal = legalOf(
    table.session.legalActions(table.actor, table.nowMs),
    "cast_vote",
  );
  const uids = legal?.playableCardUids ?? [];
  if (uids.length === 0) return [];

  const priv = table.session.privateView(table.actor);
  const voteCards = new Set((priv?.voteCards ?? []).map((card) => card.uid));
  const granted = new Set((priv?.grantedVotes ?? []).map((card) => card.uid));

  return uids.map((uid) => {
    const card = table.session.game.card(uid);
    const label = card === null ? "A vote card" : instanceName(card);
    if (granted.has(uid)) {
      return {
        uid,
        label,
        detail: "given to you — you MUST cast it at this council",
        mandatory: true,
      };
    }
    if (voteCards.has(uid)) {
      return { uid, label, detail: "your Vote Card — required", mandatory: true };
    }
    return {
      uid,
      label,
      detail: "an extra vote from your hand — optional, and secret",
      mandatory: false,
    };
  });
}

// ---------------------------------------------------------------------------
// The public progress line
// ---------------------------------------------------------------------------

interface Progress {
  readonly done: number;
  readonly total: number;
}

/**
 * How many players have every card they owe in the box, out of everyone still in the game.
 *
 * `requiredVoterIds` shrinks as obligated cards are cast, and every one of those obligations
 * was named publicly by `voting_opened`. Counting them is therefore public arithmetic on
 * public facts — unlike `voteCount`, which would leak Extra Votes. See the file header.
 */
function progressOf(view: GameView): Progress | null {
  const council = view.council;
  if (!council || council.phase !== "voting") return null;
  const inPlay = view.players.filter(
    (player) => !player.eliminated && !player.departed,
  ).length;
  const owing = council.requiredVoterIds.length;
  return { done: Math.max(0, inPlay - owing), total: inPlay };
}

/**
 * Say how the vote is going — and ONLY when the count actually moved.
 *
 * An Extra Vote never changes it, so casting one produces no public message at all: the table
 * cannot tell an extra vote from a pause for thought, which is the whole point of the ritual.
 */
async function announceProgress(
  reply: Responder,
  before: GameView,
  after: GameView,
): Promise<void> {
  const was = progressOf(before);
  const now = progressOf(after);
  if (was === null || now === null || was.done === now.done) return;
  const headline = bold(`${now.done} of ${now.total} votes are in.`);
  const posted = await reply.announce({
    content:
      now.done >= now.total
        ? `🗳️ ${headline} Every required vote is in the box. The Leader closes it with \`/council\`.`
        : `🗳️ ${headline} ${italic("Nobody can see what any of them says.")}`,
  });
  // This one is a progress note rather than an affordance, so a failed post costs nothing the
  // voter cannot see for themselves — but it is still told to them rather than swallowed.
  if (posted === null) {
    await reply.send({
      content: `Your vote is in (${now.done} of ${now.total}). I could not post that to the channel — check that I have ${bold("Send Messages")} here.`,
    });
  }
}

// ---------------------------------------------------------------------------
// The ballot
// ---------------------------------------------------------------------------

/**
 * The ephemeral card that tells one player where their ballot stands.
 *
 * `target` is the name this player last aimed at, carried through so a second obligation can be
 * spent with one press. It is null when there is nothing to aim at yet, and then the ballot
 * says so rather than offering a button that cannot be built.
 */
function ballot(table: Table, target: PlayerId | null): Payload {
  const view = table.session.view();
  const council = view.council;
  const embed = new EmbedBuilder().setColor(COUNCIL_ACCENT).setTitle("Your ballot");

  if (council === null || council.phase !== "voting") {
    return {
      embeds: [
        embed.setDescription(
          "The Voting Box is closed. `/council` shows where the council stands now.",
        ),
      ],
    };
  }

  const legal = table.session.legalActions(table.actor, table.nowMs);
  const castables = castablesFor(table);
  const priv = table.session.privateView(table.actor);
  const myVotes = priv?.myVotes ?? [];
  const progress = progressOf(view);

  const lines: string[] = [];
  if (progress !== null) {
    lines.push(`${bold(`${progress.done} of ${progress.total} votes are in.`)}`);
  }

  if (myVotes.length > 0) {
    lines.push("", bold("You have cast:"));
    for (const vote of myVotes) {
      const card = table.session.game.card(vote.cardUid);
      lines.push(
        `• ${card === null ? "A vote" : instanceName(card)} → ${bold(nameOf(view, vote.targetId))}`,
      );
    }
  }

  const owed = castables.filter((castable) => castable.mandatory);
  if (castables.length > 0) {
    lines.push("", bold("Still to cast:"));
    for (const castable of castables) {
      lines.push(`• ${castable.label} — ${italic(castable.detail)}`);
    }
    if (owed.length > 0) {
      lines.push(
        "",
        italic(
          `Voting cannot close until ${quantity(owed.length, "required card")} of yours ${owed.length === 1 ? "is" : "are"} in the box.`,
        ),
      );
    }
  } else if (legalOf(legal, "finish_voting") !== null) {
    lines.push(
      "",
      "Nothing is left that you have to cast. Pass the box on when you are ready.",
    );
  } else {
    lines.push(
      "",
      "You have passed the box on. Your ballot is closed for this council.",
    );
  }

  if (target === null && castables.length > 0) {
    lines.push("", italic("Run `/vote <player>` again to aim the next one."));
  }

  // Elided, never rejected: a long council leaves a lot of cast votes on this card, and the
  // ceiling belongs to `config.discord` rather than to a literal here (audit #86/#95).
  embed.setDescription(
    truncate(lines.join("\n"), table.config.discord.maxEmbedDescriptionLength),
  );
  return { embeds: [embed], components: ballotRows(table, castables, target, legal) };
}

/**
 * One button per castable card, aimed at the name the player already chose.
 *
 * The card uid and the packed target both ride in `args`, so the router's own decoder rebuilds
 * `cast_vote` from the id — the encoder and decoder stay a single pair (see `ui.ts`).
 */
function ballotRows(
  table: Table,
  castables: readonly Castable[],
  target: PlayerId | null,
  legal: readonly LegalAction[],
): Row[] {
  const identity = table.session.uiContext(table.actor);
  const view = table.session.view();
  const buttons: ButtonBuilder[] = [];

  if (target !== null) {
    for (const castable of castables) {
      buttons.push(
        button(
          {
            parts: {
              ...identity,
              intent: "cast_vote",
              args: [castable.uid, packPlayerArg(target)],
            },
            label: `${castable.label} → ${nameOf(view, target)}`,
            style: castable.mandatory ? ButtonStyle.Primary : ButtonStyle.Secondary,
          },
          table.config.discord,
        ),
      );
    }
  }

  if (legalOf(legal, "finish_voting") !== null) {
    buttons.push(
      button(
        {
          parts: { ...identity, intent: "finish_voting", args: [] },
          label: "I'm done voting",
          style: ButtonStyle.Success,
        },
        table.config.discord,
      ),
    );
  }

  return buttonRows(buttons, table.config.discord);
}

// ---------------------------------------------------------------------------
// The Final Tribal Council's jury ballot
// ---------------------------------------------------------------------------

function juryReceipt(table: Table): Payload {
  const view = table.session.view();
  const final = view.finalCouncil;
  const embed = new EmbedBuilder()
    .setColor(FINAL_ACCENT)
    .setTitle("Your jury vote is locked in");
  if (final === null) {
    return { embeds: [embed.setDescription("The Final Tribal Council is over.")] };
  }
  return {
    embeds: [
      embed.setDescription(
        [
          `${bold(`${final.castCount} of ${final.jury.length} jurors have voted.`)}`,
          "",
          italic(
            "Nobody sees a single vote until every juror has voted — then they are all read out together.",
          ),
        ].join("\n"),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const vote: Command = {
  data: new SlashCommandBuilder()
    .setName("vote")
    .setDescription("Tribal Council: put one vote card in the box.")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription(
          "Who you are voting for (at the Final Council, who you want to WIN)",
        )
        .setRequired(true),
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) return ctx.reply.fail(found.error);
    const session = found.value;

    const target = asPlayerId(ctx.interaction.options.getUser("player", true).id);
    const table: Table = {
      session,
      actor: ctx.actor,
      nowMs: ctx.nowMs,
      config: ctx.config,
    };
    const before = session.view();

    // The Final Tribal Council: the jury votes FOR a winner. Every guard — juror, finalist,
    // phase, already voted — belongs to the engine, so this dispatches unconditionally.
    if (before.finalCouncil !== null) {
      const outcome = ctx.dispatch(session, {
        type: "cast_jury_vote",
        actor: ctx.actor,
        finalist: target,
      });
      if (!outcome.ok) return ctx.reply.fail(outcome.error);
      await ctx.reply.send(juryReceipt(table));
      return;
    }

    const council = before.council;
    if (council === null) {
      return ctx.reply.fail(
        refuse("no_council_in_progress", "no Tribal Council is in progress"),
      );
    }
    if (council.phase !== "voting") {
      return ctx.reply.fail(
        refuse("voting_not_open", `the council is in ${council.phase}`),
      );
    }
    if (!session.hasPlayer(ctx.actor)) {
      return ctx.reply.fail(refuse("not_in_game", "not a player at this table"));
    }
    // Checked before the castable list, because "no castable card" is ALSO what an eliminated
    // player looks like, and "you have already passed the box on" would be a lie to a juror.
    const me = before.players.find((player) => player.id === ctx.actor);
    if (me?.departed === true) {
      return ctx.reply.fail(refuse("player_left_game", "this player left the table"));
    }
    if (me?.eliminated === true) {
      return ctx.reply.fail(
        refuse("player_eliminated", "eliminated players do not vote"),
      );
    }

    const castables = castablesFor(table);
    if (castables.length === 0) {
      const passed = !council.remainingVoterIds.includes(ctx.actor);
      // Nothing to cast, but the box has not been passed on yet: Control the Vote took this
      // player's only Vote Card, or they simply never held one. `finish_voting` is LEGAL for
      // them and is the one publicly narrated "X has voted" event, so refusing here left a legal
      // action with no surface anywhere in the bot (audit #74's shape). The ballot renders the
      // button, so hand them the ballot.
      if (
        !passed &&
        legalOf(session.legalActions(ctx.actor, ctx.nowMs), "finish_voting")
      ) {
        await ctx.reply.send(ballot(table, null));
        return;
      }
      // Two different dead ends, and telling them apart is the whole difference between a
      // player who is finished and a player who never had a card (audit #23/#118).
      return ctx.reply.fail(
        passed
          ? "You have already passed the box on, so your ballot is closed for this council. `/council` shows who the vote is still waiting on."
          : refuse("no_vote_card", "no castable card in any private zone"),
      );
    }

    // More than one card could go in: never guess which one a player meant to spend.
    const only = castables.length === 1 ? castables[0] : undefined;
    if (only === undefined) {
      await ctx.reply.send(ballot(table, target));
      return;
    }

    const outcome = ctx.dispatch(session, {
      type: "cast_vote",
      actor: ctx.actor,
      cardUid: only.uid,
      target,
    });
    if (!outcome.ok) return ctx.reply.fail(outcome.error);

    await announceProgress(ctx.reply, before, session.view());
    // The engine already whispered "your vote is in the box" through the courier; this says
    // what is LEFT, which is the part a player with two obligations cannot work out alone.
    await ctx.reply.send(ballot(table, target));
  },

  components: {
    /**
     * A card button on the ballot. Rebuilt through the router's own decoder so that a uid in
     * `args` and a uid arriving as a select value both land on the same action.
     */
    cast_vote: async (ctx: ComponentContext): Promise<void> => {
      const built = actionFromComponent(ctx.parsed, ctx.values, ctx.session, {
        actor: ctx.actor,
        displayName: "",
      });
      if (!built.ok) return ctx.reply.fail(built.error);
      const action = built.value;
      if (action.type !== "cast_vote") {
        // Only reachable if this route key were ever minted for another intent.
        ctx.log.error("the cast_vote route decoded something else", undefined, {
          decoded: action.type,
        });
        return ctx.reply.fail(
          "That button was not a vote after all. Nothing has changed — `/vote` casts one.",
        );
      }

      const before = ctx.session.view();
      const outcome = ctx.dispatch(action);
      if (!outcome.ok) return ctx.reply.fail(outcome.error);

      const table: Table = {
        session: ctx.session,
        actor: ctx.actor,
        nowMs: ctx.nowMs,
        config: ctx.config,
      };
      await announceProgress(ctx.reply, before, ctx.session.view());
      // Re-render in place: the card just spent is gone from `legalActions`, so the button that
      // spent it disappears rather than sitting there ready to fail (audit #88).
      await ctx.reply.update(ballot(table, action.target));
    },

    /** "I'm done voting" — the engine narrates `voter_finished` to the channel itself. */
    finish_voting: async (ctx: ComponentContext): Promise<void> => {
      const outcome = ctx.dispatch({ type: "finish_voting", actor: ctx.actor });
      if (!outcome.ok) return ctx.reply.fail(outcome.error);
      await ctx.reply.update(
        ballot(
          {
            session: ctx.session,
            actor: ctx.actor,
            nowMs: ctx.nowMs,
            config: ctx.config,
          },
          null,
        ),
      );
    },
  },
};

export default vote;
