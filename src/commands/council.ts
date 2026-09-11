/**
 * `/council` — the Leader's controls, and everybody else's view of what the council is waiting on.
 *
 * ============================ WHY THIS COMMAND EXISTS AT ALL ============================
 *
 * The old bot ran a Tribal Council as ten and a half minutes of `setTimeout` sleeps against a
 * single interaction token that Discord expires after fifteen — so the later `followUp()` calls
 * threw, and the game died mid-council with no way to restart it (audit #44). Nothing here
 * sleeps. A council phase advances when the LEADER PRESSES A BUTTON, the button is a fresh
 * `channel.send`/ephemeral rather than a token being kept alive, and the engine's phase
 * deadlines are only a backstop that `session.tick` applies.
 *
 * Two more defects are closed structurally rather than by care:
 *
 *  - RE-ENTRANCY. `advance_council` carries `from`, the phase the button was rendered against,
 *    so a second click on a stale panel is refused with `stale_phase` instead of advancing the
 *    council twice (audit #32). The phase travels in the custom_id; this file never assumes the
 *    board is where it was when the panel was drawn.
 *
 *  - THE TIE-BREAK LADDER, which is the single rule the old implementation got most wrong
 *    (audit #31/#32/#77). The rulebook says: choose first from the non-immune players who got
 *    votes; if there are none, from the non-immune players who got no votes; and finally from
 *    the players who PLAYED Immunity Idols — an idol is not absolute protection, and somebody
 *    must go home. The engine walks that ladder itself and hands the Leader a
 *    `PendingLeaderDecision` carrying the rung in force and the exact candidate list. This file
 *    offers ONLY those candidates, and prints the whole ladder with the active rung marked, so
 *    the UI teaches the rule at the one moment anybody cares about it.
 *
 * The Final Tribal Council gets the same treatment: the Leader's phase controls, the jurors'
 * ready-check, and the jury ballot. Jury votes stay invisible — `FinalCouncilView.juryVotes` is
 * null until every juror has voted — and the reveal is the engine's own simultaneous "3… 2… 1…".
 *
 * Everything a player may press is ephemeral and names exactly one presser in its custom_id, so
 * a spectator cannot advance somebody else's council and a stale panel cannot cross-wire into a
 * live one (audit #30/#47).
 */

import {
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type ButtonBuilder,
} from "discord.js";

import type { SurvivorConfig } from "../config.js";
import {
  bold,
  councilKindLabel,
  deadline,
  italic,
  mention,
  mentionList,
  quantity,
  tieBreakTierLabel,
  truncate,
} from "../discord/format.js";
import type {
  Command,
  CommandContext,
  ComponentContext,
  ComponentHandler,
  Payload,
  Responder,
} from "../discord/interactions.js";
import { ANY_PLAYER, actionFromComponent } from "../discord/interactions.js";
import type { GameSession } from "../discord/registry.js";
import {
  ACTION_CODE,
  ACTION_LABEL,
  UI_INTENT,
  button,
  buttonRows,
  cardOptions,
  packPlayerArg,
  pendingArg,
  phaseArg,
  playerOptions,
  select,
  type SelectOption,
  type Row,
} from "../discord/ui.js";
import { CARD_CATALOG } from "../engine/cards.js";
import { announceNewWindows, announceWindowOrSayWhy, openPendingIds } from "./play.js";
import type {
  Action,
  ActionKind,
  CardUid,
  CouncilPhase,
  CouncilView,
  FinalCouncilPhase,
  FinalCouncilView,
  GameError,
  GameErrorCode,
  GameView,
  LegalAction,
  LeaderDecisionReason,
  PendingId,
  PendingLeaderDecision,
  PlayerId,
  Result,
  TieBreakTier,
} from "../engine/types.js";
import {
  CardKind,
  COUNCIL_PHASE_ORDER,
  FINAL_COUNCIL_PHASE_ORDER,
  TIE_BREAK_LADDER,
  assertNever,
  asCardUid,
  err,
  ok,
} from "../engine/types.js";

const COUNCIL_ACCENT = 0xb8860b;
const FINAL_ACCENT = 0x4b0082;

/** See the note on the identical helper in `vote.ts`: the sentence still comes from the code. */
const refuse = (code: GameErrorCode, message: string): GameError => ({ code, message });

const legalOf = (
  actions: readonly LegalAction[],
  kind: ActionKind,
): LegalAction | null => actions.find((action) => action.kind === kind) ?? null;

const nameOf = (view: GameView, playerId: PlayerId): string =>
  view.players.find((player) => player.id === playerId)?.displayName ?? "somebody";

interface Table {
  readonly session: GameSession;
  readonly actor: PlayerId;
  readonly nowMs: number;
  readonly config: SurvivorConfig;
}

/**
 * An embed field, elided rather than rejected.
 *
 * Discord refuses the whole message when a field runs past its ceiling, and the ceilings live in
 * `config.discord` precisely so no renderer re-derives them (audit #86). A six-way tie-break on
 * the third rung of the ladder is the realistic worst case, and losing the last sentence of it
 * beats losing the prompt.
 */
const field = (
  table: Table,
  name: string,
  value: string,
): { readonly name: string; readonly value: string } => ({
  name,
  value: truncate(value, table.config.discord.maxEmbedFieldValueLength),
});

// ---------------------------------------------------------------------------
// The Tribal Council, phase by phase
// ---------------------------------------------------------------------------

const PHASE_LABEL: Readonly<Record<CouncilPhase, string>> = {
  advantages: "Advantages",
  discussion: "Discussion",
  voting: "Voting",
  idols: "Immunity Idols",
  nullifiers: "Idol Nullifiers",
  tally: "The Tally",
  tie_break: "The Leader Decides",
  cleanup: "Cleanup",
};

const PHASE_NOTE: Readonly<Record<CouncilPhase, string>> = {
  advantages: "Control the Vote · Goodwill Gamble · I'm the Leader Now",
  discussion: "talk, accuse, lie",
  voting: "every vote card goes in the box",
  idols: "played after every vote, before the box is opened",
  nullifiers: "an idol on the table can still be cancelled",
  tally: "the votes are read one at a time",
  tie_break: "only if it is unclear who is voted out",
  cleanup: "the interrupted turn resumes",
};

/**
 * What the Leader's button says, per phase.
 *
 * `null` for the three phases a Leader cannot advance: the tally resolves itself, the tie-break
 * ends when the Leader names somebody, and cleanup hands the turn back. Deriving the label from
 * this table rather than from "the next entry in the order" is what stops the panel offering
 * "Next: The Leader Decides" at the tally, which is not a thing anybody can press.
 */
const ADVANCE_LABEL: Readonly<Record<CouncilPhase, string | null>> = {
  advantages: "Open the discussion",
  discussion: "Open the vote",
  voting: "Close the Voting Box",
  idols: "Move on to Idol Nullifiers",
  nullifiers: "Read the votes",
  tally: null,
  tie_break: null,
  cleanup: null,
};

/** The ladder a player sees. `cleanup` is instantaneous and never worth a line. */
const LADDER: readonly CouncilPhase[] = COUNCIL_PHASE_ORDER.filter(
  (phase) => phase !== "cleanup",
);

/**
 * Phases that are FINISHED once the council has reached `current`.
 *
 * `advantages` is the exception, and it matters. The engine models the pre-vote window as two
 * phases, but the printed rule is one: "If anyone has a Tribal Advantage Card, you may play it
 * now **or anytime before we vote**", and "You can play as many Tribal Advantage Cards as you
 * would like during this discussion, but NOT once voting has started!" (docs/RULES.md). The
 * engine agrees — `requireAdvantageWindow` accepts both `advantages` and `discussion`, and
 * `legalActionsFor` offers all three advantage actions in both. Only this ladder disagreed: it
 * ticked `✅ Advantages` the moment the Leader opened the discussion, so a player holding the
 * game's single "I'm the Leader Now" read that as "the window has closed", did not play it, and
 * the Leader kept the tie-break authority for the whole council. The buttons were still live;
 * the misinformation was purely in the thing the panel puts under "Where the council is".
 */
function isFinished(phase: CouncilPhase, current: CouncilPhase): boolean {
  if (phase === "advantages" && current === "discussion") return false;
  return COUNCIL_PHASE_ORDER.indexOf(phase) < COUNCIL_PHASE_ORDER.indexOf(current);
}

function phaseLadder(current: CouncilPhase): string {
  return LADDER.map((phase) => {
    if (phase === current) {
      return `▶️ ${bold(PHASE_LABEL[phase])} — ${italic(PHASE_NOTE[phase])}`;
    }
    // Still open, just not the phase the Leader is driving: shown live rather than ticked off.
    if (phase === "advantages" && current === "discussion") {
      return `▶️ ${PHASE_LABEL[phase]} — ${italic(`${PHASE_NOTE[phase]} — still playable right up until the vote opens`)}`;
    }
    if (isFinished(phase, current)) return `✅ ${PHASE_LABEL[phase]}`;
    return `▫️ ${PHASE_LABEL[phase]} — ${italic(PHASE_NOTE[phase])}`;
  }).join("\n");
}

/** What the council is actually waiting on, in the players' own terms. */
function waitingOn(council: CouncilView, view: GameView): string {
  switch (council.phase) {
    case "advantages":
    case "discussion":
      return [
        "Anyone holding a Tribal Advantage may play it, in the open, until voting opens.",
        `The Leader moves the council on when the table is ready.`,
      ].join("\n");

    case "voting":
      return council.requiredVoterIds.length === 0
        ? "Every required vote is in the box. The Leader can close it."
        : [
            `Still owed to the box: ${mentionList(council.requiredVoterIds)}.`,
            italic(
              "Voting cannot close while a required card is unspent. `/vote <player>` casts one.",
            ),
          ].join("\n");

    case "idols":
      return [
        "Anyone may play an Immunity Idol now — on themselves or on anybody else — before a single vote is read.",
        council.idolPlays.length === 0
          ? italic("No idol on the table yet.")
          : council.idolPlays
              .map(
                (play) =>
                  `🗿 ${nameOf(view, play.playedBy)} protects ${bold(nameOf(view, play.protects))}`,
              )
              .join("\n"),
      ].join("\n");

    case "nullifiers":
      return [
        `${quantity(council.idolPlays.length, "idol")} on the table. An Idol Nullifier may cancel one.`,
        council.nullifierPlays.length === 0
          ? ""
          : italic(
              `${quantity(council.nullifierPlays.length, "idol")} already cancelled.`,
            ),
      ]
        .filter((part) => part !== "")
        .join("\n");

    case "tally":
      return "The box is open and the votes are being read.";

    case "tie_break":
      return `It is not clear who is voted out. ${mention(council.leaderId)} must decide.`;

    case "cleanup":
      return "The council is wrapping up and the interrupted turn resumes.";

    default:
      return assertNever(council.phase, "waitingOn");
  }
}

// ---------------------------------------------------------------------------
// The tie-break, which is the rule this UI exists to teach
// ---------------------------------------------------------------------------

const REASON_TEXT: Readonly<Record<LeaderDecisionReason, string>> = {
  tie_for_most: "Two or more players are tied for the most votes.",
  double_tie_for_most:
    "Three or more players are tied for the most votes, and two of them must go.",
  double_tie_for_second:
    "One player is clear on votes; the second place is tied, so you choose who joins them.",
  unclear_cascade:
    "There were not enough eligible players on the usual rung, so the rule has moved down the ladder.",
  three_player_double_override:
    "Only three players are left and a Double Elimination would leave one. The rulebook says eliminate ONE, then go straight to the Final Tribal Council.",
};

/**
 * The whole ladder, with the rung in force marked.
 *
 * Printing all three rungs every time is deliberate. A Leader handed only the candidate list has
 * no way to tell a correct third-rung prompt ("choose from the players who played idols") from a
 * bug, and that is exactly the moment the old implementation lost people's trust.
 */
function ladderText(active: TieBreakTier): string {
  return TIE_BREAK_LADDER.map((tier, index) => {
    const line = `${index + 1}. ${tieBreakTierLabel(tier)}`;
    return tier === active ? `${bold(line)} ← ${bold("in force now")}` : line;
  }).join("\n");
}

function tieBreakBlock(pending: PendingLeaderDecision, view: GameView): string {
  return [
    `⚖️ ${bold("You must decide who goes home.")}`,
    REASON_TEXT[pending.reason],
    "",
    bold("The rulebook's order, and it may not be skipped:"),
    ladderText(pending.tier),
    "",
    `Name exactly ${quantity(pending.choose, "player")} from ${bold(tieBreakTierLabel(pending.tier))}:`,
    pending.candidates.map((id) => `• ${bold(nameOf(view, id))}`).join("\n"),
    italic(`Decide by ${deadline(pending.deadlineMs)}, or the bot decides for you.`),
  ].join("\n");
}

function leaderDecisionFor(table: Table): PendingLeaderDecision | null {
  const priv = table.session.privateView(table.actor);
  for (const pending of priv?.myPending ?? []) {
    if (pending.kind === "leader_decision" && pending.status === "open") return pending;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The Tribal Council panel
// ---------------------------------------------------------------------------

function councilPanel(table: Table, council: CouncilView, view: GameView): Payload {
  const isLeader = council.leaderId === table.actor;
  const legal = table.session.legalActions(table.actor, table.nowMs);
  const decision = leaderDecisionFor(table);

  const embed = new EmbedBuilder()
    .setColor(COUNCIL_ACCENT)
    .setTitle(`Tribal Council — ${councilKindLabel(council.kind)}`)
    .setDescription(
      [
        `Leader: ${mention(council.leaderId)}${
          council.leaderId === council.drawerId
            ? " — they drew the card"
            : ` — took the role from ${mention(council.drawerId)}`
        }`,
        `${quantity(council.eliminationsRemaining, "player")} still to be voted out tonight.`,
      ].join("\n"),
    )
    .addFields(
      field(table, "Where the council is", phaseLadder(council.phase)),
      field(table, "Waiting on", waitingOn(council, view)),
    );

  if (decision !== null) {
    embed.addFields(field(table, "The tie-break", tieBreakBlock(decision, view)));
  } else if (council.phase === "tie_break" && !isLeader) {
    embed.addFields(
      field(
        table,
        "The tie-break",
        `${mention(council.leaderId)} is choosing from the rung of the ladder the rules allow. Nobody else may choose.`,
      ),
    );
  }

  if (!isLeader) {
    embed.setFooter({
      text: `Only the Leader advances the council. Everything else you may do right now is on /hand and /vote.`,
    });
  }

  return { embeds: [embed], components: councilRows(table, council, legal, decision) };
}

function councilRows(
  table: Table,
  council: CouncilView,
  legal: readonly LegalAction[],
  decision: PendingLeaderDecision | null,
): Row[] {
  const identity = table.session.uiContext(table.actor);
  const rows: Row[] = [];
  const buttons: ButtonBuilder[] = [];

  const advanceLabel = ADVANCE_LABEL[council.phase];
  if (council.leaderId === table.actor && advanceLabel !== null) {
    // Enablement comes from the engine, never from an opinion here: a Leader who cannot close
    // the box because somebody still owes a card sees the button DISABLED with the reason on
    // the panel, rather than absent or live-and-doomed (audit #88).
    const advanceable = legalOf(legal, "advance_council") !== null;
    buttons.push(
      button(
        {
          parts: {
            ...identity,
            intent: "advance_council",
            // The phase the button was drawn against. A stale panel is refused with
            // `stale_phase` instead of advancing the council a second time (audit #32).
            args: [phaseArg(council.phase)],
          },
          label: advanceLabel,
          style: ButtonStyle.Primary,
          disabled: !advanceable,
        },
        table.config.discord,
      ),
    );
  }

  // The five cards that are played AT a council. Enablement is the engine's — a card only gets
  // a button when `legalActions()` offers it in the phase the council is actually in — and the
  // press opens a private menu rather than acting, because four of the five need a target that
  // a button cannot carry.
  for (const play of COUNCIL_PLAYS) {
    if (legalOf(legal, play.kind) === null) continue;
    buttons.push(
      button(
        {
          parts: { ...identity, intent: play.kind, args: [] },
          label: ACTION_LABEL[play.kind],
          style: ButtonStyle.Secondary,
        },
        table.config.discord,
      ),
    );
  }

  if (buttons.length > 0) rows.push(...buttonRows(buttons, table.config.discord));

  const choose = legalOf(legal, "leader_choose_eliminations");
  if (decision !== null && choose !== null) {
    const candidates = choose.legalTargets ?? decision.candidates;
    rows.push(
      select(
        {
          parts: {
            ...identity,
            intent: "leader_choose_eliminations",
            args: [decision.id],
          },
          placeholder:
            decision.choose === 1
              ? "Choose who is voted out"
              : `Choose ${decision.choose} players`,
          // ONLY the rung the engine is on. The ladder cannot be skipped by a UI offering the
          // wrong list — the whole reason `candidates` is computed in the engine.
          options: playerOptions(
            table.session.view().players,
            candidates,
            table.config.engine.limits.characterCardsPerPlayer,
          ),
          minValues: decision.choose,
          maxValues: decision.choose,
        },
        table.config.discord,
      ),
    );
  }

  return rows.slice(0, table.config.discord.maxActionRowsPerMessage);
}

// ---------------------------------------------------------------------------
// The five cards that are played AT a council, and nowhere else
// ---------------------------------------------------------------------------

/**
 * Control the Vote, Goodwill Gamble, I'm the Leader Now, the Immunity Idol and the Idol
 * Nullifier.
 *
 * These five have no other home. `/play` is turn step 2 and its menu is built from
 * `PLAY_FLOWS`, which lists the seven cards playable on your own turn; the engine offers these
 * five only while a council is running, in the phase each belongs to. Until this section existed
 * `legalActions()` offered all five and NOTHING in the bot minted a component for any of them,
 * so five of the forty-seven cards in the box were unplayable — audit #74 ("thirteen cards had
 * no command at all and nothing noticed") returning by a different door.
 *
 * The shape is the same two-step one `/play` uses: a button on the council panel opens a
 * PRIVATE menu, and the menu's value completes the action. Which cards are on offer, which
 * targets are legal and whether the phase is right are all `legalActions()` — this table holds
 * only the prose and the shape of the second question.
 */
type CouncilPlayKind =
  | "play_control_the_vote"
  | "play_goodwill_gamble"
  | "play_im_the_leader_now"
  | "play_immunity_idol"
  | "play_idol_nullifier";

interface CouncilPlay {
  readonly kind: CouncilPlayKind;
  readonly card: CardKind;
  /** What the second question asks for. `none` resolves on the button press itself. */
  readonly aim: "player" | "idol" | "none";
  readonly prompt: string;
  readonly done: string;
}

const COUNCIL_PLAYS: readonly CouncilPlay[] = [
  {
    kind: "play_control_the_vote",
    card: CardKind.ControlTheVote,
    aim: "player",
    prompt: "Whose Vote Card are you taking?",
    done: "**Control the Vote** played, in the open. Their Vote Card is yours to cast — and you MUST cast it, on top of your own.",
  },
  {
    kind: "play_goodwill_gamble",
    card: CardKind.GoodwillGamble,
    aim: "player",
    prompt: "Who are you giving a vote to?",
    done: "**Goodwill Gamble** played. They must cast it at this council — you do not get to say who at.",
  },
  {
    kind: "play_im_the_leader_now",
    card: CardKind.ImTheLeaderNow,
    aim: "none",
    prompt: "Take the role of Tribal Council Leader",
    done: "**I'm the Leader Now!** You run this council.",
  },
  {
    kind: "play_immunity_idol",
    card: CardKind.ImmunityIdol,
    aim: "player",
    prompt: "Who does the idol protect?",
    done: "🗿 **Immunity Idol** played, face up. Every vote against them is void — unless somebody cancels it.",
  },
  {
    kind: "play_idol_nullifier",
    card: CardKind.IdolNullifier,
    aim: "idol",
    prompt: "Which Immunity Idol are you cancelling?",
    done: "**Idol Nullifier** played. That idol protects nobody.",
  },
];

const COUNCIL_PLAY_BY_KIND: ReadonlyMap<CouncilPlayKind, CouncilPlay> = new Map(
  COUNCIL_PLAYS.map((play) => [play.kind, play]),
);

/**
 * Flow tags. `args[0]` of every component minted below.
 *
 * The generic UI intents belong to no command in particular, so a bare route key would deliver
 * one flow's press to another flow's handler. `src/index.ts` refuses to boot on a duplicate
 * key, which makes a collision a startup failure rather than a mis-routed card.
 */
const FLOW = {
  /** Completing one of the five council plays. */
  Play: "cpl",
  /** Claiming an Inheritance. */
  Inherit: "inh",
  /** "Show me my controls" on a public prompt. */
  Panel: "cnl",
} as const;

/** Which council play a component is completing, carried as its 2-char `ACTION_CODE`. */
const COUNCIL_PLAY_BY_CODE: ReadonlyMap<string, CouncilPlay> = new Map(
  COUNCIL_PLAYS.map((play) => [ACTION_CODE[play.kind], play]),
);

/**
 * The private menu for one council play, or null when the engine is no longer offering it.
 *
 * Every option is a `CardUid` or a packed `PlayerId` taken from `legalActions()` at the moment
 * the menu is drawn (audit #39/#50), and the card the play will use rides in `args` so the
 * choice made here cannot be applied to a different copy.
 */
function councilPlayMenu(ctx: ComponentContext, play: CouncilPlay): Payload | null {
  const legal = legalOf(ctx.session.legalActions(ctx.actor, ctx.nowMs), play.kind);
  const cardUid = (legal?.playableCardUids ?? [])[0];
  if (legal === null || cardUid === undefined) return null;

  const view = ctx.session.view();
  const options: readonly SelectOption[] =
    play.aim === "idol"
      ? idolOptions(view)
      : playerOptions(
          view.players,
          legal.legalTargets ?? [],
          ctx.config.engine.limits.characterCardsPerPlayer,
        );
  if (options.length === 0) return null;

  return {
    content: `${bold(CARD_CATALOG[play.card].name)} — ${play.prompt}`,
    components: [
      select(
        {
          parts: {
            ...ctx.session.uiContext(ctx.actor),
            intent: UI_INTENT.Confirm,
            args: [FLOW.Play, ACTION_CODE[play.kind], cardUid],
          },
          placeholder: play.prompt,
          options,
        },
        ctx.config.discord,
      ),
    ],
  };
}

/** Idols still standing. A nullified idol is not a legal target for a second nullifier. */
function idolOptions(view: GameView): readonly SelectOption[] {
  const council = view.council;
  if (council === null) return [];
  return council.idolPlays
    .filter((idol) => idol.nullifiedBy === null)
    .map((idol) => ({
      value: idol.cardUid,
      label: `${nameOf(view, idol.playedBy)}'s idol`,
      description: `protects ${nameOf(view, idol.protects)}`,
    }));
}

function councilPlayAction(
  ctx: ComponentContext,
  play: CouncilPlay,
  cardUid: CardUid,
  value: string,
): Result<Action> {
  const actor = ctx.actor;
  if (play.kind === "play_im_the_leader_now") {
    return ok({ type: "play_im_the_leader_now", actor, cardUid });
  }
  if (play.kind === "play_idol_nullifier") {
    return value === ""
      ? err("target_required", "no idol named")
      : ok({
          type: "play_idol_nullifier",
          actor,
          cardUid,
          targetIdolUid: asCardUid(value),
        });
  }
  const target = resolvePlayer(ctx.session, value);
  if (target === null) {
    return err("target_not_in_game", `no player at this table matches ${value}`);
  }
  switch (play.kind) {
    case "play_control_the_vote":
      return ok({ type: "play_control_the_vote", actor, cardUid, target });
    case "play_goodwill_gamble":
      return ok({ type: "play_goodwill_gamble", actor, cardUid, recipient: target });
    case "play_immunity_idol":
      return ok({ type: "play_immunity_idol", actor, cardUid, protects: target });
    default:
      return assertNever(play.kind, "councilPlayAction");
  }
}

/** Resolve a packed or plain player id against this table. Never trusts an id off the wire. */
function resolvePlayer(session: GameSession, raw: string): PlayerId | null {
  for (const player of session.view().players) {
    if (raw === player.id || raw === packPlayerArg(player.id)) return player.id;
  }
  return null;
}

/** A council play button was pressed: open its private menu, or resolve it outright. */
function openCouncilPlay(kind: CouncilPlayKind): ComponentHandler {
  return async (ctx: ComponentContext): Promise<void> => {
    const play = COUNCIL_PLAY_BY_KIND.get(kind);
    if (play === undefined) return;

    if (play.aim === "none") {
      const legal = legalOf(ctx.session.legalActions(ctx.actor, ctx.nowMs), kind);
      const cardUid = (legal?.playableCardUids ?? [])[0];
      if (cardUid === undefined) {
        await ctx.reply.fail(
          refuse("card_not_playable_now", `no playable ${kind} in hand right now`),
        );
        return;
      }
      // `aim: "none"` is I'm the Leader Now and nothing else: it is the one of the five that is
      // complete the moment a card is named. `councilPlayAction` still builds it, so there is
      // exactly one place an action of one of these five kinds is constructed.
      const action = councilPlayAction(ctx, play, cardUid, "");
      if (!action.ok) {
        await ctx.reply.fail(action.error);
        return;
      }
      await dispatchCouncilPlay(ctx, action.value, play.done);
      return;
    }

    const menu = councilPlayMenu(ctx, play);
    if (menu === null) {
      await ctx.reply.fail(
        refuse(
          "card_not_playable_now",
          `${kind} has nothing legal to point at in this phase`,
        ),
      );
      return;
    }
    await ctx.reply.send(menu);
  };
}

/** A choice was made on a council play's private menu. */
const resolveCouncilPlay: ComponentHandler = async (ctx) => {
  const code = ctx.parsed.args[1] ?? "";
  const play = COUNCIL_PLAY_BY_CODE.get(code);
  const cardUid = ctx.parsed.args[2];
  const value = ctx.values[0];
  if (play === undefined || cardUid === undefined || value === undefined) {
    await ctx.reply.fail(
      "That menu lost track of what it was for. `/council` draws the controls again.",
    );
    return;
  }
  const action = councilPlayAction(ctx, play, asCardUid(cardUid), value);
  if (!action.ok) {
    await ctx.reply.fail(action.error);
    return;
  }
  await dispatchCouncilPlay(ctx, action.value, play.done);
};

/**
 * Dispatch, tell the presser, and prompt whatever the play just opened.
 *
 * The TABLE has already been told: `ctx.dispatch` rendered every event to the audience the
 * engine chose, and every one of these five plays is public by rule ("in the open", "face up").
 */
async function dispatchCouncilPlay(
  ctx: ComponentContext,
  action: Action,
  done: string,
): Promise<void> {
  const before = openWindowIds(ctx.session);
  const outcome = ctx.dispatch(action);
  if (!outcome.ok) {
    await ctx.reply.fail(outcome.error);
    return;
  }
  await ctx.reply.update({ content: done, components: [] });
  await announceCouncilWindows(ctx.reply, ctx.session, before, ctx.config);
}

// ---------------------------------------------------------------------------
// The two windows the council owns
// ---------------------------------------------------------------------------

/** Every window open right now. Take it BEFORE a dispatch to spot what that dispatch opened. */
const openWindowIds = openPendingIds;

/**
 * Post a prompt for every window a council dispatch opened.
 *
 * TWO sources, because a council opens two different families of window:
 *
 *  - The ordinary ones — a `take` (Control the Vote takes somebody's Vote Card, and the victim
 *    may answer with Sorry For You!), a forced discard, a card choice. `play.ts` owns those
 *    prompts and `announceNewWindows` is exported for exactly this. Without this call a Tribal
 *    Advantage opened a take window that NOTHING in the bot prompted, the victim had no way to
 *    block or to let it through, and the council could not reach its tally until the deadline
 *    expired: `resolveEliminations` refuses to run while any window is open.
 *  - The two the council owns. `play.ts` deliberately declines both — `windowPrompt` returns
 *    null for `leader_decision` and `inheritance` — because two commands prompting one window
 *    would put two sets of live buttons on it.
 *
 * Everything here is public and says nothing private: WHO is being waited on and until WHEN are
 * table facts. Which cards were claimed stays in `take_resolved`, which is private.
 */
async function announceCouncilWindows(
  reply: Responder,
  session: GameSession,
  before: ReadonlySet<PendingId>,
  config: SurvivorConfig,
): Promise<void> {
  await announceNewWindows(reply, session, before, config);
  const view = session.view();
  for (const pending of view.openPending) {
    if (before.has(pending.id)) continue;
    const payload =
      pending.kind === "inheritance"
        ? inheritancePrompt(session, pending.id, config)
        : pending.kind === "leader_decision"
          ? leaderDecisionPrompt(session, pending.waitingOnIds, config)
          : null;
    // Checked, not dropped: a `leader_decision` prompt that fails to post wedges the tally for
    // the full backstop with nobody able to see why (`resolveEliminations` refuses to run while
    // any window is open).
    if (payload !== null) await announceWindowOrSayWhy(reply, payload, pending);
  }
}

/**
 * The claim prompt.
 *
 * ADDRESSED TO NOBODY, deliberately. `waitingOn(pending)` returns an EMPTY list for an
 * inheritance window and that is correct engine behaviour: "anyone MIGHT hold the matching
 * Inheritance card, and which hands hold what is private — so the window names nobody
 * publicly." A prompt built from `waitingOnIds` therefore has no buttons at all, which is
 * exactly what happened before this: the render pipeline announced that a hand was on the table,
 * no component in the bot could claim it, and the council sat at its tally until the window
 * expired (`resolveEliminations` refuses to run while any window is open).
 *
 * So the buttons are minted for `ANY_PLAYER` — the one other place in the bot a component
 * belongs to everybody. That leaks nothing, because the ENGINE is the gate at both ends:
 * `play_inheritance` needs a matching card in hand, and `decline_reaction` on an inheritance
 * window answers `not_a_participant` — "That prompt is not for you." — to anyone who does not
 * hold it. Printing a name here would be the leak.
 */
function inheritancePrompt(
  session: GameSession,
  pendingId: PendingId,
  config: SurvivorConfig,
): Payload {
  const shared = session.uiContext(ANY_PLAYER);
  return {
    content: `📜 Whoever holds the matching ${bold("Inheritance")} card may claim that whole hand now — the colour is in the message above. Nobody else can: the buttons answer only to the card.`,
    components: buttonRows(
      [
        button(
          {
            parts: {
              ...shared,
              intent: UI_INTENT.OpenPlayMenu,
              args: [FLOW.Inherit, pendingId],
            },
            label: ACTION_LABEL.play_inheritance,
            style: ButtonStyle.Primary,
          },
          config.discord,
        ),
        button(
          {
            parts: { ...shared, intent: "decline_reaction", args: [pendingId] },
            label: "Let it go to the discard pile",
            style: ButtonStyle.Secondary,
          },
          config.discord,
        ),
      ],
      config.discord,
    ),
  };
}

/**
 * The tie-break is the Leader's alone, and their controls are private, so the public prompt is
 * a pointer rather than a decision: it says the council is waiting on THEM, and gives them one
 * press to get their panel back without typing.
 */
function leaderDecisionPrompt(
  session: GameSession,
  waitingOn: readonly PlayerId[],
  config: SurvivorConfig,
): Payload | null {
  const leader = waitingOn[0];
  if (leader === undefined) return null;
  return {
    content: `⚖️ ${mention(leader)} — it is not clear who is voted out, so the ${bold("Tribal Council Leader")} decides. Your controls are below, or run \`/council\`.`,
    components: buttonRows(
      [
        button(
          {
            parts: {
              ...session.uiContext(leader),
              intent: UI_INTENT.Refresh,
              args: [FLOW.Panel],
            },
            label: "Open my controls",
            style: ButtonStyle.Primary,
          },
          config.discord,
        ),
      ],
      config.discord,
    ),
  };
}

/** "Claim the Inheritance": the private menu over the matching cards this player holds. */
const openInheritance: ComponentHandler = async (ctx) => {
  const pendingId = pendingArg(ctx.parsed, 1);
  const legal =
    pendingId === null
      ? null
      : (ctx.session
          .legalActions(ctx.actor, ctx.nowMs)
          .find(
            (action) =>
              action.kind === "play_inheritance" && action.pendingId === pendingId,
          ) ?? null);
  const uids = legal?.playableCardUids ?? [];
  if (pendingId === null || uids.length === 0) {
    await ctx.reply.fail(
      refuse("pending_not_found", "that inheritance window is no longer claimable"),
    );
    return;
  }
  // One matching card is the ordinary case: no question worth asking, so claim it.
  const only = uids.length === 1 ? uids[0] : undefined;
  if (only !== undefined) {
    await dispatchCouncilPlay(
      ctx,
      { type: "play_inheritance", actor: ctx.actor, cardUid: only, pendingId },
      "📜 Claimed. Their whole hand is yours — the cards themselves are on their way to you privately.",
    );
    return;
  }
  await ctx.reply.send({
    content: "Which Inheritance card are you playing?",
    components: [
      select(
        {
          parts: {
            ...ctx.session.uiContext(ctx.actor),
            intent: UI_INTENT.Confirm,
            args: [FLOW.Inherit, pendingId],
          },
          placeholder: "Your matching Inheritance cards",
          options: cardOptions(ctx.session.game.cards(uids)),
        },
        ctx.config.discord,
      ),
    ],
  });
};

const resolveInheritance: ComponentHandler = async (ctx) => {
  const pendingId = pendingArg(ctx.parsed, 1);
  const value = ctx.values[0];
  if (pendingId === null || value === undefined) {
    await ctx.reply.fail(
      refuse("pending_not_found", "that inheritance window is no longer claimable"),
    );
    return;
  }
  await dispatchCouncilPlay(
    ctx,
    {
      type: "play_inheritance",
      actor: ctx.actor,
      cardUid: asCardUid(value),
      pendingId,
    },
    "📜 Claimed. Their whole hand is yours.",
  );
};

/**
 * "Let it happen" / "pass", on any reaction window.
 *
 * The bare `decline_reaction` route key is claimed HERE rather than in `play.ts`: two commands
 * claiming one key is a boot failure, and `play.ts`'s take prompt routes its own decline through
 * `un:sfy` instead. Nothing here is council-specific — the action needs only the window it is
 * declining — so a `decline_reaction` button minted anywhere in the bot lands correctly.
 */
const declineReaction: ComponentHandler = async (ctx) => {
  const pendingId = pendingArg(ctx.parsed, 0);
  if (pendingId === null) {
    await ctx.reply.fail(
      refuse("pending_not_found", "that button did not name the window it answers"),
    );
    return;
  }
  const outcome = ctx.dispatch({
    type: "decline_reaction",
    actor: ctx.actor,
    pendingId,
  });
  if (!outcome.ok) {
    await ctx.reply.fail(outcome.error);
    return;
  }
  await ctx.reply.send({ content: "You let it go." });
  await ctx.reply.disableSource();
};

// ---------------------------------------------------------------------------
// The Final Tribal Council
// ---------------------------------------------------------------------------

const FINAL_PHASE_LABEL: Readonly<Record<FinalCouncilPhase, string>> = {
  opening: "The Leader's questions",
  statements: "The finalists make their case",
  jury_questions: "The jury speaks",
  jury_vote: "The jury votes",
  tie_break: "The Leader breaks the tie",
  complete: "The Sole Survivor",
};

const FINAL_PHASE_NOTE: Readonly<Record<FinalCouncilPhase, string>> = {
  opening: "three scripted questions, asked by the Leader",
  statements: "the final two may reveal their hands; they play no cards",
  jury_questions: "the jury asks, accuses and makes its own case",
  jury_vote: "every juror votes FOR a winner, in secret",
  tie_break: "an even jury split evenly; the Leader is not bound by their own vote",
  complete: "the votes are read together",
};

const FINAL_ADVANCE_LABEL: Readonly<Record<FinalCouncilPhase, string | null>> = {
  opening: "Ask the finalists to make their case",
  statements: "Hand the floor to the jury",
  jury_questions: "Open the jury vote",
  // From here the council runs itself: the vote reveals the moment the last juror votes.
  jury_vote: null,
  tie_break: null,
  complete: null,
};

function finalLadder(current: FinalCouncilPhase): string {
  const at = FINAL_COUNCIL_PHASE_ORDER.indexOf(current);
  return FINAL_COUNCIL_PHASE_ORDER.map((phase) => {
    const index = FINAL_COUNCIL_PHASE_ORDER.indexOf(phase);
    if (phase === current) {
      return `▶️ ${bold(FINAL_PHASE_LABEL[phase])} — ${italic(FINAL_PHASE_NOTE[phase])}`;
    }
    if (index < at) return `✅ ${FINAL_PHASE_LABEL[phase]}`;
    return `▫️ ${FINAL_PHASE_LABEL[phase]} — ${italic(FINAL_PHASE_NOTE[phase])}`;
  }).join("\n");
}

function finalWaitingOn(final: FinalCouncilView, view: GameView): string {
  switch (final.phase) {
    case "opening":
      return `${mention(final.leaderId)} asks the three questions, then moves the council on.`;
    case "statements":
      return `${mentionList([...final.finalists])} make their case.${
        final.revealedHands.length > 0
          ? ` Hands already on the table: ${mentionList(final.revealedHands)}.`
          : ""
      }`;
    case "jury_questions":
      return [
        "The jury has the floor.",
        `Ready to vote: ${final.readyJurors.length} of ${final.jury.length}. When every juror is ready the vote opens on its own.`,
      ].join("\n");
    case "jury_vote":
      return [
        `${bold(`${final.castCount} of ${final.jury.length} jurors have voted.`)}`,
        italic(
          "Nobody — not even the Leader — sees a single vote until the last one is in. Then they are all read together.",
        ),
        `Jurors: \`/vote <finalist>\`, or the buttons below.`,
      ].join("\n");
    case "tie_break":
      return `The jury split evenly. ${mention(final.leaderId)} chooses the winner, and need not stick with their own vote.`;
    case "complete":
      return final.winnerId === null
        ? "The Final Tribal Council is over."
        : `${bold(nameOf(view, final.winnerId))} is the Sole Survivor.`;
    default:
      return assertNever(final.phase, "finalWaitingOn");
  }
}

function finalPanel(table: Table, final: FinalCouncilView, view: GameView): Payload {
  const embed = new EmbedBuilder()
    .setColor(FINAL_ACCENT)
    .setTitle("Final Tribal Council")
    .setDescription(
      [
        `Leader: ${mention(final.leaderId)} — the most recently voted out.`,
        `The final two: ${mentionList([...final.finalists])}.`,
        `The jury: ${mentionList(final.jury)} (${quantity(final.jury.length, "vote")}).`,
      ].join("\n"),
    )
    .addFields(
      field(table, "Where the council is", finalLadder(final.phase)),
      field(table, "Waiting on", finalWaitingOn(final, view)),
    );

  return {
    embeds: [embed],
    components: finalRows(
      table,
      final,
      table.session.legalActions(table.actor, table.nowMs),
    ),
  };
}

function finalRows(
  table: Table,
  final: FinalCouncilView,
  legal: readonly LegalAction[],
): Row[] {
  const identity = table.session.uiContext(table.actor);
  const view = table.session.view();
  const buttons: ButtonBuilder[] = [];

  const advanceLabel = FINAL_ADVANCE_LABEL[final.phase];
  if (advanceLabel !== null && legalOf(legal, "advance_final_council") !== null) {
    buttons.push(
      button(
        {
          parts: {
            ...identity,
            intent: "advance_final_council",
            args: [phaseArg(final.phase)],
          },
          label: advanceLabel,
          style: ButtonStyle.Primary,
        },
        table.config.discord,
      ),
    );
  }

  if (legalOf(legal, "juror_ready") !== null) {
    buttons.push(
      button(
        {
          parts: { ...identity, intent: "juror_ready", args: [] },
          label: "I'm ready to vote",
          style: ButtonStyle.Success,
        },
        table.config.discord,
      ),
    );
  }

  const jury = legalOf(legal, "cast_jury_vote");
  for (const finalist of jury?.legalTargets ?? []) {
    buttons.push(
      button(
        {
          parts: {
            ...identity,
            intent: "cast_jury_vote",
            args: [packPlayerArg(finalist)],
          },
          label: `Vote for ${nameOf(view, finalist)} to win`,
          style: ButtonStyle.Secondary,
        },
        table.config.discord,
      ),
    );
  }

  const tie = legalOf(legal, "final_leader_break_tie");
  for (const finalist of tie?.legalTargets ?? []) {
    buttons.push(
      button(
        {
          parts: {
            ...identity,
            intent: "final_leader_break_tie",
            args: [packPlayerArg(finalist)],
          },
          label: `${nameOf(view, finalist)} wins`,
          style: ButtonStyle.Danger,
        },
        table.config.discord,
      ),
    );
  }

  if (legalOf(legal, "reveal_hand") !== null) {
    buttons.push(
      button(
        {
          parts: { ...identity, intent: "reveal_hand", args: [] },
          label: "Reveal my hand as evidence",
          style: ButtonStyle.Secondary,
        },
        table.config.discord,
      ),
    );
  }

  return buttonRows(buttons, table.config.discord);
}

// ---------------------------------------------------------------------------
// One panel for whichever council is running
// ---------------------------------------------------------------------------

function panel(table: Table): Payload {
  const view = table.session.view();
  if (view.council !== null) return councilPanel(table, view.council, view);
  if (view.finalCouncil !== null) return finalPanel(table, view.finalCouncil, view);
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COUNCIL_ACCENT)
        .setTitle("The council is over")
        .setDescription(
          "No Tribal Council is running now. `/status` shows whose turn it is.",
        ),
    ],
  };
}

/**
 * Every council button: rebuild the action from the custom_id, dispatch it, re-render the panel.
 *
 * Rebuilding through the router's own decoder keeps `ui.ts` the single encoder/decoder pair, and
 * re-rendering afterwards is what stops a phase button that has already fired from sitting there
 * live (audit #88) — the new panel's buttons come from `legalActions()` against the board as it
 * is now.
 */
async function pressAndRefresh(ctx: ComponentContext): Promise<void> {
  const built = actionFromComponent(ctx.parsed, ctx.values, ctx.session, {
    actor: ctx.actor,
    displayName: "",
  });
  if (!built.ok) return ctx.reply.fail(built.error);

  const before = openWindowIds(ctx.session);
  const outcome = ctx.dispatch(built.value);
  if (!outcome.ok) return ctx.reply.fail(outcome.error);

  // The table has already been told what happened: `ctx.dispatch` rendered every event to the
  // audience the ENGINE chose. This only refreshes the presser's own controls.
  await ctx.reply.update(
    panel({
      session: ctx.session,
      actor: ctx.actor,
      nowMs: ctx.nowMs,
      config: ctx.config,
    }),
  );
  // Reading the votes is what eliminates somebody, and eliminating somebody is what opens the
  // Inheritance window and (on an unclear vote) the Leader's tie-break. Both belong to this
  // command, so both are prompted from here — see `announceCouncilWindows`.
  await announceCouncilWindows(ctx.reply, ctx.session, before, ctx.config);
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const council: Command = {
  data: new SlashCommandBuilder()
    .setName("council")
    .setDescription(
      "Tribal Council: the Leader's controls, and what the council is waiting on.",
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) return ctx.reply.fail(found.error);
    const session = found.value;

    const view = session.view();
    if (view.council === null && view.finalCouncil === null) {
      return ctx.reply.fail(
        refuse("no_council_in_progress", "no council is running in this channel"),
      );
    }

    await ctx.reply.send(
      panel({ session, actor: ctx.actor, nowMs: ctx.nowMs, config: ctx.config }),
    );
  },

  components: {
    advance_council: pressAndRefresh,
    leader_choose_eliminations: pressAndRefresh,
    advance_final_council: pressAndRefresh,
    juror_ready: pressAndRefresh,
    cast_jury_vote: pressAndRefresh,
    final_leader_break_tie: pressAndRefresh,
    // Claimed here even though the router's generic path would dispatch it correctly, so the
    // finalist's own panel refreshes after the press rather than sitting there offering a
    // reveal that has already happened (audit #88).
    reveal_hand: pressAndRefresh,

    // The five cards played AT a council. Without these five routes the buttons above decode
    // to `target_required` — and before the buttons existed, five cards in the box had no
    // surface at all.
    play_control_the_vote: openCouncilPlay("play_control_the_vote"),
    play_goodwill_gamble: openCouncilPlay("play_goodwill_gamble"),
    play_im_the_leader_now: openCouncilPlay("play_im_the_leader_now"),
    play_immunity_idol: openCouncilPlay("play_immunity_idol"),
    play_idol_nullifier: openCouncilPlay("play_idol_nullifier"),
    [`${UI_INTENT.Confirm}:${FLOW.Play}`]: resolveCouncilPlay,

    // The Inheritance window, which nothing in the bot used to prompt.
    play_inheritance: openInheritance,
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Inherit}`]: openInheritance,
    [`${UI_INTENT.Confirm}:${FLOW.Inherit}`]: resolveInheritance,
    decline_reaction: declineReaction,

    /** "Open my controls" on the public tie-break prompt. */
    [`${UI_INTENT.Refresh}:${FLOW.Panel}`]: async (
      ctx: ComponentContext,
    ): Promise<void> => {
      await ctx.reply.send(
        panel({
          session: ctx.session,
          actor: ctx.actor,
          nowMs: ctx.nowMs,
          config: ctx.config,
        }),
      );
    },
  },
};

export default council;
