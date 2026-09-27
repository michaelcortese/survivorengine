/**
 * `/play` — turn step 2, and every follow-up choice a card needs.
 *
 * The old bot had one command per card and duplicated the validation in each of them (audit
 * #74: thirteen of the forty-seven cards had no command at all and nothing noticed). This file
 * has none of that: the menu is built from `legalActions()`, so a card appears if and only if
 * the ENGINE says it may be played right now, and the branching that follows is about what a
 * card needs POINTED AT, never about whether it may be played.
 *
 * Four defects are closed structurally here rather than by care:
 *
 *  - #39/#50  a hand was spliced by an array index captured up to sixty seconds earlier.
 *             Every option in every menu below carries a `CardUid`, and the uid is what the
 *             action is built from. A hand that changed while the menu sat open cannot make
 *             the wrong card leave: the engine refuses a uid that is no longer held.
 *  - #80/#91  Knowledge is Power took a free-text card name and a case-sensitive typo burned
 *             the card. `nameCard()` is a select over the catalog; a name that is not a
 *             `CardKind` cannot be expressed.
 *  - #44      a flow that outlived its interaction token. Nothing here sleeps and nothing
 *             here is a collector; each step is a fresh component carrying the state the next
 *             step needs, so a flow is resumable for as long as the nonce is current.
 *  - #88      a window that opened with no way to answer it. `windowPrompt()` is this
 *             command's `prompts` entry for every window a turn can open, addressed to the
 *             players the ENGINE says it is waiting on, and the SESSION posts it for every
 *             window that opens — by a click in any command, or by a timer. A button whose
 *             window has since closed re-renders dead instead of failing.
 *
 * `applyAndConfirm` is exported because `/steal` and `/draw` answer their buttons the same way.
 */

import {
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonBuilder,
} from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { bold, deadline, mention, quantity } from "../discord/format.js";
import type {
  Command,
  CommandContext,
  ComponentContext,
  ComponentHandler,
  Payload,
} from "../discord/interactions.js";
import type { GameSession } from "../discord/registry.js";
import {
  UI_INTENT,
  button,
  buttonRows,
  cardArg,
  cardOptions,
  packPlayerArg,
  pendingArg,
  playerOptions,
  select,
  type SelectOption,
} from "../discord/ui.js";
import { CARD_CATALOG, nameableKinds } from "../engine/cards.js";
import { challengeChoices } from "../engine/challenges.js";
import type {
  Action,
  ActionKind,
  CardUid,
  ChallengeKind,
  ChallengeSubmission,
  DispatchOutcome,
  FingerCount,
  GameError,
  LegalAction,
  PendingId,
  PendingView,
  PlayerId,
  Result,
  RpsThrow,
} from "../engine/types.js";
import { CardKind, asCardUid, assertNever, err, ok } from "../engine/types.js";

// ---------------------------------------------------------------------------
// Flow tags
// ---------------------------------------------------------------------------

/**
 * `args[0]` of every component this command mints.
 *
 * The generic UI intents (`up`, `ut`, `uy`, `un`) are shared by every command in the bot, so a
 * bare route key would silently deliver one flow's press to another flow's handler. The tag is
 * what makes `"up:sfy"` and `"up:dsc"` different routes — and `src/index.ts` refuses to boot on
 * a duplicate key, so a collision is a startup failure rather than audit #37 wearing a new hat.
 */
const FLOW = {
  /** The `/play` card menu. */
  Menu: "play",
  /** Collecting the targets one play needs. */
  Target: "pl",
  /** Sorry For You, against an open take. */
  Block: "sfy",
  /** A forced discard. */
  Discard: "dsc",
  /** A Reward Challenge submission. */
  Challenge: "chl",
  /** Picking a specific card out of somebody's hand (The Spy Shack, the Do or Die swap). */
  PickCard: "pck",
  /** An alliance partner naming their own mark. */
  Ally: "ally",
  /** It's a Numbers Game: the winner naming who they steal from. */
  Victim: "svc",
} as const;

type WindowFlow =
  | typeof FLOW.Block
  | typeof FLOW.Discard
  | typeof FLOW.Challenge
  | typeof FLOW.PickCard
  | typeof FLOW.Ally
  | typeof FLOW.Victim;

/** The engine action each window flow ultimately dispatches. */
const WINDOW_ACTION: Readonly<Record<WindowFlow, ActionKind>> = {
  [FLOW.Block]: "play_sorry_for_you",
  [FLOW.Discard]: "discard_card",
  [FLOW.Challenge]: "submit_challenge_choice",
  [FLOW.PickCard]: "choose_card",
  [FLOW.Ally]: "choose_alliance_target",
  [FLOW.Victim]: "choose_steal_victim",
};

const WINDOW_PROMPT: Readonly<Record<WindowFlow, string>> = {
  [FLOW.Block]: "Which Sorry For You! are you playing?",
  [FLOW.Discard]: "Which card are you discarding?",
  [FLOW.Challenge]: "Choose — nobody sees this until everyone has answered",
  [FLOW.PickCard]: "Which card are you taking?",
  [FLOW.Ally]: "Who are you stealing from?",
  [FLOW.Victim]: "Who are you stealing from?",
};

const WINDOW_DONE: Readonly<Record<WindowFlow, string>> = {
  [FLOW.Block]: "**Sorry For You!** played. The table has been told.",
  [FLOW.Discard]: "Discarded.",
  [FLOW.Challenge]:
    "Your choice is locked in. It stays secret until everyone has answered.",
  [FLOW.PickCard]: "Taken.",
  [FLOW.Ally]: "Named. Your steal is under way.",
  [FLOW.Victim]: "Named. Your steal is under way.",
};

const WINDOW_CLOSED =
  "That window has already closed. Nothing has changed — `/status` shows where things stand.";

// ---------------------------------------------------------------------------
// The turn-step cards, and what each one needs pointed at
// ---------------------------------------------------------------------------

/** Actions that are a turn step-2 card play. Everything else is a reaction or a council play. */
type PlayActionKind = Extract<
  ActionKind,
  | "play_camp_raid"
  | "play_knowledge_is_power"
  | "play_spy_shack"
  | "play_lets_form_an_alliance"
  | "play_do_or_die"
  | "play_power_pair"
  | "play_its_a_numbers_game"
>;

interface PlayersStep {
  readonly kind: "players";
  readonly prompt: string;
  /** How many names this step collects at once. Power Pair takes both in one select. */
  readonly pick: number;
}

interface CardKindStep {
  readonly kind: "card_kind";
  readonly prompt: string;
}

type PlayStep = PlayersStep | CardKindStep;

interface PlayFlow {
  readonly card: CardKind;
  readonly action: PlayActionKind;
  /** In order. An empty list means the card resolves the moment it is chosen. */
  readonly steps: readonly PlayStep[];
}

/**
 * One entry per playable card. The prompts are the only card-specific prose in this file; the
 * legality of every one of these is the engine's business and is never re-derived here.
 */
const PLAY_FLOWS: readonly PlayFlow[] = [
  {
    card: CardKind.CampRaid,
    action: "play_camp_raid",
    steps: [{ kind: "players", prompt: "Whose camp are you raiding?", pick: 1 }],
  },
  {
    card: CardKind.KnowledgeIsPower,
    action: "play_knowledge_is_power",
    steps: [
      { kind: "players", prompt: "Who are you asking?", pick: 1 },
      { kind: "card_kind", prompt: "Name the card you are asking for" },
    ],
  },
  {
    card: CardKind.TheSpyShack,
    action: "play_spy_shack",
    steps: [{ kind: "players", prompt: "Whose cards are you looking at?", pick: 1 }],
  },
  {
    card: CardKind.LetsFormAnAlliance,
    action: "play_lets_form_an_alliance",
    steps: [
      { kind: "players", prompt: "Who is your partner?", pick: 1 },
      { kind: "players", prompt: "Who are YOU stealing from?", pick: 1 },
    ],
  },
  {
    card: CardKind.DoOrDie,
    action: "play_do_or_die",
    steps: [{ kind: "players", prompt: "Who are you challenging?", pick: 1 }],
  },
  {
    card: CardKind.PowerPair,
    action: "play_power_pair",
    steps: [{ kind: "players", prompt: "Pick two other players", pick: 2 }],
  },
  {
    card: CardKind.ItsANumbersGame,
    action: "play_its_a_numbers_game",
    steps: [],
  },
];

const FLOW_BY_CARD: ReadonlyMap<CardKind, PlayFlow> = new Map(
  PLAY_FLOWS.map((flow) => [flow.card, flow]),
);

const FLOW_BY_ACTION: ReadonlyMap<ActionKind, PlayFlow> = new Map(
  PLAY_FLOWS.map((flow) => [flow.action, flow]),
);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Resolve a packed or plain player id against this table. Never trusts an id from the wire. */
function resolvePlayer(session: GameSession, raw: string): PlayerId | null {
  for (const player of session.view().players) {
    if (raw === player.id || raw === packPlayerArg(player.id)) return player.id;
  }
  return null;
}

/**
 * Where a handler's answer belongs.
 *
 * A press from one of our own ephemeral menus should REPLACE that menu — leaving a live select
 * behind is audit #88 in miniature. A press from the public prompt in the channel must not edit
 * that message, because the prompt may still belong to other players (a Reward Challenge names
 * every participant on one message), so it gets a fresh ephemeral instead.
 */
function sourceIsEphemeral(ctx: ComponentContext): boolean {
  const interaction = ctx.interaction;
  if (!interaction.isMessageComponent()) return false;
  return interaction.message.flags.has(MessageFlags.Ephemeral);
}

async function respond(ctx: ComponentContext, payload: Payload): Promise<void> {
  if (sourceIsEphemeral(ctx)) await ctx.reply.update(payload);
  else await ctx.reply.send(payload);
}

/** The `LegalAction` for one open window, or null if the engine is not offering it any more. */
function legalFor(
  ctx: ComponentContext,
  kind: ActionKind,
  pendingId: PendingId | null,
): LegalAction | null {
  return (
    ctx.session
      .legalActions(ctx.actor, ctx.nowMs)
      .find(
        (action) =>
          action.kind === kind &&
          (pendingId === null || action.pendingId === pendingId),
      ) ?? null
  );
}

const stillOpen = (session: GameSession, pendingId: PendingId | null): boolean =>
  pendingId !== null &&
  session.view().openPending.some((pending) => pending.id === pendingId);

// ---------------------------------------------------------------------------
// Prompting the windows a turn opens
// ---------------------------------------------------------------------------

/** A button that opens one player's private menu for one window. */
function windowButton(
  session: GameSession,
  player: PlayerId,
  flow: WindowFlow,
  pendingId: PendingId,
  label: string,
  style: ButtonStyle,
  config: SurvivorConfig,
): ButtonBuilder {
  return button(
    {
      parts: {
        ...session.uiContext(player),
        intent: UI_INTENT.OpenPlayMenu,
        args: [flow, pendingId],
      },
      label,
      style,
    },
    config.discord,
  );
}

const nameOf = (session: GameSession, playerId: PlayerId): string =>
  session.view().players.find((player) => player.id === playerId)?.displayName ??
  "Someone";

/**
 * The public prompt for one open window. This command's `prompts` entry for the six kinds it
 * owns; the session posts it once the narration of whatever opened the window has gone out.
 *
 * PUBLIC on purpose, and it says nothing private: who is being waited on, how long they have
 * and what kind of decision it is are all facts the physical game puts on the table. What the
 * player then chooses arrives on their own ephemeral menu (audit #119/#126 in both directions).
 *
 * `leader_decision` and `inheritance` are deliberately not prompted here — they belong to the
 * council flow, and two commands prompting one window would put two live buttons on it.
 */
function windowPrompt(
  session: GameSession,
  pending: PendingView,
  config: SurvivorConfig,
): Payload | null {
  const discord = config.discord;
  const waiting = pending.waitingOnIds;
  const first = waiting[0];

  switch (pending.kind) {
    case "take": {
      if (first === undefined) return null;
      return {
        content: `${mention(first)} — ${quantity(pending.count, "card")} ${pending.count === 1 ? "is" : "are"} being taken from you. You may block it with ${bold("Sorry For You!")} until ${deadline(pending.deadlineMs)}.`,
        components: buttonRows(
          [
            windowButton(
              session,
              first,
              FLOW.Block,
              pending.id,
              "Sorry For You!",
              ButtonStyle.Primary,
              config,
            ),
            button(
              {
                parts: {
                  ...session.uiContext(first),
                  intent: UI_INTENT.Cancel,
                  args: [FLOW.Block, pending.id],
                },
                label: "Let it happen",
                style: ButtonStyle.Secondary,
              },
              discord,
            ),
          ],
          discord,
        ),
      };
    }

    case "discard": {
      if (first === undefined) return null;
      return {
        content: `${mention(first)} — you must discard ${quantity(pending.count, "card")} by ${deadline(pending.deadlineMs)}.`,
        components: buttonRows(
          [
            windowButton(
              session,
              first,
              FLOW.Discard,
              pending.id,
              "Choose a card",
              ButtonStyle.Primary,
              config,
            ),
          ],
          discord,
        ),
      };
    }

    case "challenge": {
      if (waiting.length === 0) return null;
      return {
        content: `🎲 A Reward Challenge. ${waiting.map((id) => mention(id)).join(" ")} — each of you answers in secret, and everything is revealed at once. ${deadline(pending.deadlineMs)}.`,
        components: buttonRows(
          waiting.map((playerId) =>
            windowButton(
              session,
              playerId,
              FLOW.Challenge,
              pending.id,
              `${nameOf(session, playerId)}: choose`,
              ButtonStyle.Primary,
              config,
            ),
          ),
          discord,
        ),
      };
    }

    case "card_choice": {
      if (first === undefined) return null;
      return {
        content: `🔦 ${mention(first)} — pick your card by ${deadline(pending.deadlineMs)}.`,
        components: buttonRows(
          [
            windowButton(
              session,
              first,
              FLOW.PickCard,
              pending.id,
              "Pick a card",
              ButtonStyle.Primary,
              config,
            ),
          ],
          discord,
        ),
      };
    }

    case "alliance_target": {
      if (first === undefined) return null;
      return {
        content: `🤝 ${mention(first)} — name your own mark by ${deadline(pending.deadlineMs)}. You cannot steal from your partner.`,
        components: buttonRows(
          [
            windowButton(
              session,
              first,
              FLOW.Ally,
              pending.id,
              "Name your mark",
              ButtonStyle.Primary,
              config,
            ),
          ],
          discord,
        ),
      };
    }

    case "steal_victim": {
      if (first === undefined) return null;
      return {
        content: `🎯 ${mention(first)} — you won. Choose who you are taking ${quantity(pending.count, "card")} from, by ${deadline(pending.deadlineMs)}.`,
        components: buttonRows(
          [
            windowButton(
              session,
              first,
              FLOW.Victim,
              pending.id,
              "Choose a victim",
              ButtonStyle.Primary,
              config,
            ),
          ],
          discord,
        ),
      };
    }

    // Owned by the council flow: `/council` declares these two prompts, not this command.
    case "leader_decision":
    case "inheritance":
      return null;

    default:
      return assertNever(pending.kind, "windowPrompt");
  }
}

/**
 * THE dispatch path for every component in this file: apply, then answer the presser. A refusal
 * is rendered from its code and changes nothing. Whatever the play opened is prompted by the
 * session, after the table has been told what happened.
 */
export async function applyAndConfirm(
  ctx: ComponentContext,
  action: Action,
  done: string | ((outcome: DispatchOutcome) => string),
): Promise<void> {
  const outcome = ctx.dispatch(action);
  if (!outcome.ok) {
    await ctx.reply.fail(outcome.error);
    return;
  }
  await respond(ctx, {
    content: typeof done === "string" ? done : done(outcome.value),
  });
}

// ---------------------------------------------------------------------------
// The private menu behind a window prompt
// ---------------------------------------------------------------------------

const RPS_EMOJI: Readonly<Record<RpsThrow, string>> = {
  rock: "🪨",
  paper: "📄",
  scissors: "✂️",
};

/**
 * The menu for one Reward Challenge, straight from the engine's own list.
 *
 * The ranges — rock/paper/scissors for Do or Die, "hold out 1, 2, or 3 fingers" for Power Pair,
 * "show 1-5 fingers" for It's a Numbers Game — were restated here because `engine/challenges.ts`
 * kept them inside `submissionIsLegal()`, a predicate a menu cannot enumerate. Two copies of a
 * bound is how a UI comes to offer a choice the engine then rejects, so the engine now exports
 * `challengeChoices()` and this only decides what each one is CALLED.
 */
function challengeOptions(challenge: ChallengeKind): readonly SelectOption[] {
  return challengeChoices(challenge).map((submission) =>
    submission.kind === "rps"
      ? {
          value: submission.throw,
          label: submission.throw[0]!.toUpperCase() + submission.throw.slice(1),
          emoji: RPS_EMOJI[submission.throw],
        }
      : {
          value: String(submission.count),
          label: `${submission.count} ${submission.count === 1 ? "finger" : "fingers"}`,
        },
  );
}

/** The open challenge this player is being waited on for, with its private shape. */
function challengeFor(
  ctx: ComponentContext,
  pendingId: PendingId,
): ChallengeKind | null {
  const view = ctx.session.privateView(ctx.actor);
  if (view === null) return null;
  for (const pending of view.myPending) {
    if (pending.id === pendingId && pending.kind === "challenge")
      return pending.challenge;
  }
  return null;
}

/**
 * The ephemeral menu for one window, or null when there is nothing left for this player to do.
 *
 * Every option carries a `CardUid` or a packed `PlayerId`, never a position, and the option list
 * comes from `legalActions()` rather than from a hand read at render time — so a menu that has
 * been sitting on screen cannot offer a card that has since moved (audit #39/#50).
 */
function windowMenu(
  ctx: ComponentContext,
  flow: WindowFlow,
  pendingId: PendingId,
): Payload | null {
  const legal = legalFor(ctx, WINDOW_ACTION[flow], pendingId);
  if (legal === null) return null;

  const discord = ctx.config.discord;
  let options: readonly SelectOption[];

  switch (flow) {
    case FLOW.Block:
      options = cardOptions(ctx.session.game.cards(legal.playableCardUids ?? []));
      break;
    case FLOW.Discard:
      options = cardOptions(ctx.session.game.cards(legal.playableCardUids ?? []));
      break;
    case FLOW.PickCard:
      options = cardOptions(ctx.session.game.cards(legal.optionCardUids ?? []));
      break;
    case FLOW.Challenge: {
      const challenge = challengeFor(ctx, pendingId);
      if (challenge === null) return null;
      options = challengeOptions(challenge);
      break;
    }
    case FLOW.Ally:
    case FLOW.Victim:
      options = playerOptions(
        ctx.session.view().players,
        legal.legalTargets ?? [],
        ctx.config.engine.limits.characterCardsPerPlayer,
      );
      break;
    default:
      return assertNever(flow, "windowMenu");
  }

  if (options.length === 0) return null;
  return {
    content: WINDOW_PROMPT[flow],
    components: [
      select(
        {
          parts: {
            ...ctx.session.uiContext(ctx.actor),
            intent: UI_INTENT.Confirm,
            args: [flow, pendingId],
          },
          placeholder: WINDOW_PROMPT[flow],
          options,
        },
        discord,
      ),
    ],
  };
}

/** Why a menu came back empty, in words the player can act on. */
function nothingToDo(
  ctx: ComponentContext,
  flow: WindowFlow,
  pendingId: PendingId,
): string {
  if (!stillOpen(ctx.session, pendingId)) return WINDOW_CLOSED;
  if (flow === FLOW.Block) {
    return `You have no ${bold("Sorry For You!")} card to block with. Press **Let it happen** to let it through.`;
  }
  return "There is nothing left for you to answer here.";
}

/** A player pressed their button on a public window prompt: show them their private menu. */
function openWindow(flow: WindowFlow): ComponentHandler {
  return async (ctx: ComponentContext): Promise<void> => {
    const pendingId = pendingArg(ctx.parsed, 1);
    if (pendingId === null) {
      await ctx.reply.fail(WINDOW_CLOSED);
      return;
    }
    const menu = windowMenu(ctx, flow, pendingId);
    if (menu === null) {
      await ctx.reply.send({ content: nothingToDo(ctx, flow, pendingId) });
      // The whole window is gone: nobody's button on this message can do anything now.
      if (!stillOpen(ctx.session, pendingId)) await ctx.reply.disableSource();
      return;
    }
    // Always a NEW ephemeral message: the prompt this came from is public and may still name
    // other players (a Reward Challenge puts every participant on one message).
    await ctx.reply.send(menu);
  };
}

function submissionFrom(raw: string): ChallengeSubmission | null {
  if (raw === "rock" || raw === "paper" || raw === "scissors") {
    return { kind: "rps", throw: raw };
  }
  const count = Number.parseInt(raw, 10);
  if (count >= 1 && count <= 5) return { kind: "fingers", count: count as FingerCount };
  return null;
}

function windowAction(
  ctx: ComponentContext,
  flow: WindowFlow,
  pendingId: PendingId,
  value: string,
): Result<Action> {
  const actor = ctx.actor;
  switch (flow) {
    case FLOW.Block:
      return ok({
        type: "play_sorry_for_you",
        actor,
        cardUid: asCardUid(value),
        pendingId,
      });
    case FLOW.Discard:
      return ok({ type: "discard_card", actor, cardUid: asCardUid(value), pendingId });
    case FLOW.PickCard:
      return ok({ type: "choose_card", actor, cardUid: asCardUid(value), pendingId });
    case FLOW.Challenge: {
      const submission = submissionFrom(value);
      return submission === null
        ? err("wrong_pending_kind", `unrecognised challenge submission ${value}`)
        : ok({ type: "submit_challenge_choice", actor, pendingId, submission });
    }
    case FLOW.Ally: {
      const target = resolvePlayer(ctx.session, value);
      return target === null
        ? err("target_not_in_game", `no player at this table matches ${value}`)
        : ok({ type: "choose_alliance_target", actor, pendingId, target });
    }
    case FLOW.Victim: {
      const target = resolvePlayer(ctx.session, value);
      return target === null
        ? err("target_not_in_game", `no player at this table matches ${value}`)
        : ok({ type: "choose_steal_victim", actor, pendingId, target });
    }
    default:
      return assertNever(flow, "windowAction");
  }
}

/**
 * A choice was made on a private window menu.
 *
 * A window that is still open afterwards — a forced discard of two cards, say — re-renders its
 * menu rather than leaving the player looking at a confirmation with nothing to press.
 */
function resolveWindow(flow: WindowFlow): ComponentHandler {
  return async (ctx: ComponentContext): Promise<void> => {
    const pendingId = pendingArg(ctx.parsed, 1);
    const value = ctx.values[0];
    if (pendingId === null || value === undefined) {
      await ctx.reply.fail(
        "That choice did not come through. Press the button on the prompt in the channel again.",
      );
      return;
    }

    const action = windowAction(ctx, flow, pendingId, value);
    if (!action.ok) {
      await ctx.reply.fail(action.error);
      return;
    }

    const outcome = ctx.dispatch(action.value);
    if (!outcome.ok) {
      await ctx.reply.fail(outcome.error);
      return;
    }

    const again = windowMenu(ctx, flow, pendingId);
    await respond(ctx, again ?? { content: WINDOW_DONE[flow] });
  };
}

/** "Let it happen" on a take: decline the reaction outright. */
const declineWindow: ComponentHandler = async (ctx) => {
  const pendingId = pendingArg(ctx.parsed, 1);
  if (pendingId === null) {
    await ctx.reply.fail(WINDOW_CLOSED);
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
  await ctx.reply.send({ content: "You let it through." });
  await ctx.reply.disableSource();
};

// ---------------------------------------------------------------------------
// The play menu
// ---------------------------------------------------------------------------

/**
 * The cards this player may play RIGHT NOW, one option per kind.
 *
 * Copies of a card are interchangeable, so several Camp Raids are one option carrying the uid of
 * the first — a real card, addressed by identity, not a position in a list.
 */
function playMenu(
  session: GameSession,
  actor: PlayerId,
  legal: readonly LegalAction[],
  config: SurvivorConfig,
): Payload | null {
  const options: SelectOption[] = [];
  const seen = new Set<CardKind>();

  for (const action of legal) {
    const flow = FLOW_BY_ACTION.get(action.kind);
    if (flow === undefined || seen.has(flow.card)) continue;
    const uids = action.playableCardUids ?? [];
    const uid = uids[0];
    if (uid === undefined) continue;
    // "Legal but with nothing to point at" is dead: a Camp Raid when everyone is already raided.
    if (action.legalTargets !== undefined && action.legalTargets.length === 0) continue;

    seen.add(flow.card);
    const definition = CARD_CATALOG[flow.card];
    options.push({
      value: uid,
      label: uids.length > 1 ? `${definition.name} (${uids.length})` : definition.name,
      description: definition.compactText,
    });
  }

  if (options.length === 0) return null;
  return {
    content:
      "Your play step. Only you can see this, and only the cards you may legally play right now are listed.",
    components: [
      select(
        {
          parts: {
            ...session.uiContext(actor),
            intent: UI_INTENT.OpenPlayMenu,
            args: [FLOW.Menu],
          },
          placeholder: "Choose a card to play",
          options,
        },
        config.discord,
      ),
    ],
  };
}

/**
 * Why the menu is empty, as something the player can act on.
 *
 * The codes come from `GameErrorCode` so the wording is the one `describeGameError` already
 * gives every other refusal — audit #23/#118: "There was an error while executing this command!"
 * told a player nothing about the rule they had just broken.
 */
function whyNothingToPlay(
  session: GameSession,
  actor: PlayerId,
  legal: readonly LegalAction[],
): GameError | string {
  if (!session.hasPlayer(actor)) {
    return { code: "not_in_game", message: "not a player at this table" };
  }
  if (legal.some((action) => action.pendingId !== undefined)) {
    return "Something is waiting on YOU first. Answer the prompt in the channel, then play.";
  }

  const view = session.view();
  const turn = view.turn;
  if (turn === null)
    return { code: "wrong_turn_phase", message: "no turn is in progress" };
  if (turn.playerId !== actor)
    return { code: "not_your_turn", message: "another player's turn" };
  if (turn.phase === "steal") {
    // During the steal step the only window that can be open is the steal's own take.
    return view.openPending.some((pending) => pending.kind === "take")
      ? { code: "steal_being_answered", message: "the steal is still being answered" }
      : { code: "steal_step_not_done", message: "the steal step is not done" };
  }
  if (turn.cardPlayedThisTurn !== null) {
    return { code: "card_already_played_this_turn", message: "one card play per turn" };
  }
  if (turn.phase !== "play") {
    return {
      code: "wrong_turn_phase",
      message: `the turn is at the ${turn.phase} step`,
    };
  }
  if (view.openPending.length > 0) {
    return "Something at the table is still being answered. `/status` shows what everyone is waiting on.";
  }
  return "Nothing in your hand can be played right now. `/skip` moves you on to your draw, and `/hand` shows what you are holding.";
}

// ---------------------------------------------------------------------------
// Collecting what a card needs pointed at
// ---------------------------------------------------------------------------

/** The step still to be answered, given what has been collected so far. Null when complete. */
function nextStep(flow: PlayFlow, collected: readonly string[]): PlayStep | null {
  let consumed = 0;
  for (const step of flow.steps) {
    const picks = step.kind === "players" ? step.pick : 1;
    if (collected.length < consumed + picks) return step;
    consumed += picks;
  }
  return null;
}

/**
 * The next question, as a select.
 *
 * `args` carry the whole flow — the tag, the card uid, and every answer so far — so nothing is
 * held in memory between two clicks and a step is still answerable after a restart, for as long
 * as the nonce names a live game (audit #44: the old flows died with their interaction token).
 */
function stepPayload(
  ctx: ComponentContext,
  flow: PlayFlow,
  cardUid: CardUid,
  collected: readonly string[],
  step: PlayStep,
  legal: LegalAction,
): Payload {
  const definition = CARD_CATALOG[flow.card];
  const parts = {
    ...ctx.session.uiContext(ctx.actor),
    intent: UI_INTENT.PickTarget,
    args: [FLOW.Target, cardUid, ...collected],
  };

  if (step.kind === "card_kind") {
    // The cards actually in THIS game's deck, so the list offered and the list accepted
    // cannot disagree (the Idol Nullifier is a per-game setting).
    const options = nameableKinds(ctx.config.engine.deck).map((kind) => ({
      value: kind,
      label: CARD_CATALOG[kind].name,
      description: CARD_CATALOG[kind].compactText,
    }));
    return {
      content: `${bold(definition.name)} — ${step.prompt}. Pick from the list; there is no way to mistype a card here.`,
      components: [
        select({ parts, placeholder: step.prompt, options }, ctx.config.discord),
      ],
    };
  }

  // Already-named players cannot be named twice: "you can't steal from each other", "pick 2
  // OTHER players". The engine refuses a duplicate anyway; offering it would be a dead option.
  const already = new Set(
    collected
      .map((raw) => resolvePlayer(ctx.session, raw))
      .filter((player): player is PlayerId => player !== null),
  );
  const targets = (legal.legalTargets ?? []).filter((id) => !already.has(id));
  const options = playerOptions(
    ctx.session.view().players,
    targets,
    ctx.config.engine.limits.characterCardsPerPlayer,
  );

  return {
    content: `${bold(definition.name)} — ${step.prompt}`,
    components: [
      select(
        {
          parts,
          placeholder: step.prompt,
          options,
          minValues: Math.min(step.pick, Math.max(1, options.length)),
          maxValues: step.pick,
        },
        ctx.config.discord,
      ),
    ],
  };
}

/** Build the engine action once every step has an answer. */
function playAction(
  ctx: ComponentContext,
  flow: PlayFlow,
  cardUid: CardUid,
  collected: readonly string[],
): Result<Action> {
  const actor = ctx.actor;
  const players: PlayerId[] = [];
  let named: CardKind | null = null;
  let index = 0;

  for (const step of flow.steps) {
    if (step.kind === "players") {
      for (let pick = 0; pick < step.pick; pick += 1) {
        const raw = collected[index];
        index += 1;
        const player = raw === undefined ? null : resolvePlayer(ctx.session, raw);
        if (player === null) {
          return err(
            "target_required",
            `step ${index} of ${flow.action} has no target`,
          );
        }
        players.push(player);
      }
      continue;
    }
    const raw = collected[index];
    index += 1;
    const kind =
      nameableKinds(ctx.config.engine.deck).find((candidate) => candidate === raw) ??
      null;
    if (kind === null) {
      return err("unknown_card_kind", `${String(raw)} is not a card you can ask for`);
    }
    named = kind;
  }

  const first = players[0];
  const second = players[1];

  switch (flow.action) {
    case "play_camp_raid":
      return first === undefined
        ? err("target_required", "no camp to raid")
        : ok({ type: "play_camp_raid", actor, cardUid, target: first });
    case "play_spy_shack":
      return first === undefined
        ? err("target_required", "no hand to look at")
        : ok({ type: "play_spy_shack", actor, cardUid, target: first });
    case "play_do_or_die":
      return first === undefined
        ? err("target_required", "no opponent")
        : ok({ type: "play_do_or_die", actor, cardUid, opponent: first });
    case "play_power_pair":
      return first === undefined || second === undefined
        ? err("target_required", "Power Pair needs two other players")
        : ok({ type: "play_power_pair", actor, cardUid, first, second });
    case "play_knowledge_is_power":
      return first === undefined || named === null
        ? err("target_required", "Knowledge is Power needs a player and a card")
        : ok({ type: "play_knowledge_is_power", actor, cardUid, target: first, named });
    case "play_lets_form_an_alliance":
      return first === undefined || second === undefined
        ? err("target_required", "an alliance needs a partner and a mark")
        : ok({
            type: "play_lets_form_an_alliance",
            actor,
            cardUid,
            partner: first,
            victim: second,
          });
    case "play_its_a_numbers_game":
      return ok({ type: "play_its_a_numbers_game", actor, cardUid });
    default:
      return assertNever(flow.action, "playAction");
  }
}

/**
 * Advance one card's flow: ask the next question, or dispatch when there is nothing left to ask.
 *
 * Legality is re-read from `legalActions()` on EVERY step rather than trusted from the step
 * before, so a menu that has been open while the board moved refuses instead of acting on a
 * stale picture.
 */
async function continueFlow(
  ctx: ComponentContext,
  flow: PlayFlow,
  cardUid: CardUid,
  collected: readonly string[],
): Promise<void> {
  const legal = legalFor(ctx, flow.action, null);
  if (legal === null || !(legal.playableCardUids ?? []).includes(cardUid)) {
    await respond(ctx, {
      content: `You cannot play ${bold(CARD_CATALOG[flow.card].name)} any more — the table has moved on. \`/play\` shows what you can play now.`,
    });
    return;
  }

  const step = nextStep(flow, collected);
  if (step !== null) {
    await respond(ctx, stepPayload(ctx, flow, cardUid, collected, step, legal));
    return;
  }

  const action = playAction(ctx, flow, cardUid, collected);
  if (!action.ok) {
    await ctx.reply.fail(action.error);
    return;
  }
  await applyAndConfirm(
    ctx,
    action.value,
    `${bold(CARD_CATALOG[flow.card].name)} played. The table has been told; anything it opened is in the channel.`,
  );
}

/** A card was chosen from the `/play` menu. */
const chooseCard: ComponentHandler = async (ctx) => {
  const raw = ctx.values[0];
  if (raw === undefined) {
    await ctx.reply.fail("No card came through. Run `/play` again.");
    return;
  }
  const uid = asCardUid(raw);
  const card = ctx.session.game.card(uid);
  const flow = card === null ? undefined : FLOW_BY_CARD.get(card.kind);
  if (flow === undefined) {
    await ctx.reply.fail(
      "That card is not one you can play on your turn. `/hand` shows what you are holding.",
    );
    return;
  }
  await continueFlow(ctx, flow, uid, []);
};

/** One more answer arrived for a flow already under way. */
const pickTarget: ComponentHandler = async (ctx) => {
  const cardUid = cardArg(ctx.parsed, 1);
  if (cardUid === null) {
    await ctx.reply.fail(
      "That menu lost track of which card it was for. Run `/play` again.",
    );
    return;
  }
  const card = ctx.session.game.card(cardUid);
  const flow = card === null ? undefined : FLOW_BY_CARD.get(card.kind);
  if (flow === undefined) {
    await ctx.reply.fail("That card cannot be played on your turn.");
    return;
  }
  await continueFlow(ctx, flow, cardUid, [...ctx.parsed.args.slice(2), ...ctx.values]);
};

/**
 * A button minted straight from `legalActions()` — `componentsForLegalActions` puts the action
 * kind in the id and, when there is exactly one candidate card and no target to pick, the uid
 * too. Anything it could not carry is asked for here instead of guessed at.
 */
function enterFlow(action: PlayActionKind): ComponentHandler {
  return async (ctx: ComponentContext): Promise<void> => {
    const flow = FLOW_BY_ACTION.get(action);
    if (flow === undefined) return;
    const legal = legalFor(ctx, action, null);
    const uids = legal?.playableCardUids ?? [];
    const fromArgs = ctx.parsed.args.find((arg) => uids.includes(asCardUid(arg)));
    const cardUid = fromArgs !== undefined ? asCardUid(fromArgs) : uids[0];

    if (cardUid === undefined) {
      await ctx.reply.fail({
        code: "card_not_playable_now",
        message: `no playable ${action} in hand`,
      });
      return;
    }
    await continueFlow(ctx, flow, cardUid, []);
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const play: Command = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Step 2 of your turn: play one card, or find out that you cannot."),

  async execute(ctx: CommandContext): Promise<void> {
    const found = ctx.requireSession();
    if (!found.ok) {
      await ctx.reply.fail(found.error);
      return;
    }
    const session = found.value;
    const legal = session.legalActions(ctx.actor, ctx.nowMs);
    const menu = playMenu(session, ctx.actor, legal, ctx.config);

    // Ephemeral, always: which cards you hold is the one thing nobody else may see, and a menu
    // of them posted publicly would be audit #126 with buttons on it.
    if (menu === null) {
      await ctx.reply.fail(whyNothingToPlay(session, ctx.actor, legal));
      return;
    }
    await ctx.reply.send(menu);
  },

  components: {
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Menu}`]: chooseCard,
    [`${UI_INTENT.PickTarget}:${FLOW.Target}`]: pickTarget,

    // The seven turn-step cards, so a button minted anywhere in the bot lands in the same flow.
    play_camp_raid: enterFlow("play_camp_raid"),
    play_knowledge_is_power: enterFlow("play_knowledge_is_power"),
    play_spy_shack: enterFlow("play_spy_shack"),
    play_lets_form_an_alliance: enterFlow("play_lets_form_an_alliance"),
    play_do_or_die: enterFlow("play_do_or_die"),
    play_power_pair: enterFlow("play_power_pair"),
    play_its_a_numbers_game: enterFlow("play_its_a_numbers_game"),

    // Windows: the public prompt opens a private menu, the private menu resolves the window.
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Block}`]: openWindow(FLOW.Block),
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Discard}`]: openWindow(FLOW.Discard),
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Challenge}`]: openWindow(FLOW.Challenge),
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.PickCard}`]: openWindow(FLOW.PickCard),
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Ally}`]: openWindow(FLOW.Ally),
    [`${UI_INTENT.OpenPlayMenu}:${FLOW.Victim}`]: openWindow(FLOW.Victim),

    [`${UI_INTENT.Confirm}:${FLOW.Block}`]: resolveWindow(FLOW.Block),
    [`${UI_INTENT.Confirm}:${FLOW.Discard}`]: resolveWindow(FLOW.Discard),
    [`${UI_INTENT.Confirm}:${FLOW.Challenge}`]: resolveWindow(FLOW.Challenge),
    [`${UI_INTENT.Confirm}:${FLOW.PickCard}`]: resolveWindow(FLOW.PickCard),
    [`${UI_INTENT.Confirm}:${FLOW.Ally}`]: resolveWindow(FLOW.Ally),
    [`${UI_INTENT.Confirm}:${FLOW.Victim}`]: resolveWindow(FLOW.Victim),

    [`${UI_INTENT.Cancel}:${FLOW.Block}`]: declineWindow,
  },

  // Every window a turn can open. The session posts these; see `windowPrompt`.
  prompts: {
    take: windowPrompt,
    discard: windowPrompt,
    challenge: windowPrompt,
    card_choice: windowPrompt,
    alliance_target: windowPrompt,
    steal_victim: windowPrompt,
  },
};

export default play;
