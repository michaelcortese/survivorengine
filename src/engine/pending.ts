/**
 * Pending windows: the one interruption model.
 *
 * This replaces the old global `{ active, target, sender, stopped }` interruption object and the
 * 28-line busy-wait that polled it (audit #28, #29, #51, #53, #83, #37, #39/#50). The shape is
 * what makes those defects unrepresentable:
 *
 *  - A window is addressed by `PendingId`. Several may be open at once without interfering, and
 *    every action that answers one names the exact window it answers, so a Sorry For You can
 *    never cancel the wrong steal (#83) and a stale click can never resolve a second window (#37).
 *  - A window has exactly one terminal status and is PRUNED from `GameState.pending` the moment
 *    it reaches one. `pending` therefore holds only open windows: a second resolution finds
 *    nothing and returns `pending_not_found`/`pending_already_resolved` rather than applying an
 *    effect twice. Dropping a reaction is equally impossible — the window stays in state until
 *    something closes it, and `tick` closes it with a stated default.
 *  - Nothing here reads a clock. `deadlineMs` is an absolute timestamp computed from the `nowMs`
 *    the caller passed in, and expiry happens inside `tick`.
 *
 * Card MOVEMENT for takes and forced discards lives here too, because "who gets nothing" is the
 * Sorry For You rule and it has to be decided in the same place the window closes.
 */

import type { PendingWindowKind } from "../config.js";
import {
  discardCard,
  giveCardTo,
  handHas,
  kindsOf,
  type DiscardReason,
} from "./card.js";
import {
  emitPublic,
  emitTo,
  newPendingId,
  stamp,
  type Ctx,
  type DraftPlayer,
} from "./draft.js";
import { findPlayer, requirePlayer } from "./player.js";
import type { FinalCouncilTrigger, PendingDefault } from "./events.js";
import {
  assertNever,
  type CardUid,
  type ChallengeKind,
  type ChallengeSlot,
  type EffectId,
  type LeaderDecisionReason,
  type Pending,
  type PendingAllianceTarget,
  type PendingCardChoice,
  type PendingChallenge,
  type PendingDiscard,
  type PendingId,
  type PendingInheritance,
  type PendingKind,
  type PendingLeaderDecision,
  type PendingStealVictim,
  type PendingTake,
  type PlayerColor,
  type PlayerId,
  type TakeOrigin,
  type TakeSpec,
  type TieBreakTier,
  takeCount,
} from "./types.js";

// ---------------------------------------------------------------------------
// Registry mechanics
// ---------------------------------------------------------------------------

const deadlineFor = (ctx: Ctx, kind: PendingWindowKind): number =>
  ctx.nowMs + ctx.config.timings.pendingWindows[kind];

export function findPending(ctx: Ctx, id: PendingId): Pending | null {
  return ctx.pending.find((p) => p.id === id) ?? null;
}

export const hasOpenPendings = (ctx: Ctx): boolean => ctx.pending.length > 0;

function push<T extends Pending>(ctx: Ctx, pending: T): T {
  ctx.pending.push(pending);
  return pending;
}

/** Replace a pending in place, keeping its position. Used to record partial progress. */
export function updatePending(ctx: Ctx, pending: Pending): void {
  const at = ctx.pending.findIndex((p) => p.id === pending.id);
  if (at < 0) throw new Error(`updatePending: ${pending.id} is not open`);
  ctx.pending[at] = pending;
}

/** Remove a pending from state. The record of what happened lives in the event log. */
export function prunePending(ctx: Ctx, id: PendingId): void {
  const at = ctx.pending.findIndex((p) => p.id === id);
  if (at >= 0) ctx.pending.splice(at, 1);
}

export function cancelPending(
  ctx: Ctx,
  pending: Pending,
  reason: "blocked" | "superseded" | "player_eliminated" | "game_ended" | "declined",
): void {
  prunePending(ctx, pending.id);
  emitPublic(ctx, {
    type: "pending_cancelled",
    pendingId: pending.id,
    pendingKind: pending.kind,
    reason,
  });
}

export function expirePending(
  ctx: Ctx,
  pending: Pending,
  applied: PendingDefault,
): void {
  prunePending(ctx, pending.id);
  emitPublic(ctx, {
    type: "pending_expired",
    pendingId: pending.id,
    pendingKind: pending.kind,
    defaultApplied: applied,
  });
}

/** Whose input is this window waiting on? Drives `PendingView` and `legalActions`. */
export function waitingOn(pending: Pending): readonly PlayerId[] {
  switch (pending.kind) {
    case "take":
      return [pending.victimId];
    case "discard":
      return [pending.playerId];
    case "challenge":
      return pending.slots.filter((s) => s.submission === null).map((s) => s.playerId);
    case "card_choice":
      return [pending.chooserId];
    case "alliance_target":
      return [pending.partnerId];
    case "steal_victim":
      return [pending.chooserId];
    case "leader_decision":
      return [pending.leaderId];
    case "inheritance":
      // Anyone MIGHT hold the matching Inheritance card, and which hands hold what is private —
      // so the window names nobody publicly. `legalActions` offers it to the actual holder.
      return [];
    default:
      return assertNever(pending, "waitingOn");
  }
}

/** How many cards or choices this window is about. Public: it is never a card identity. */
export function pendingCount(pending: Pending): number {
  switch (pending.kind) {
    case "take":
      return takeCount(pending.spec);
    case "discard":
      return pending.count;
    case "challenge":
      return pending.slots.length;
    case "card_choice":
      return 1;
    case "alliance_target":
      return 1;
    case "steal_victim":
      return pending.count;
    case "leader_decision":
      return pending.choose;
    case "inheritance":
      return pending.hand.length;
    default:
      return assertNever(pending, "pendingCount");
  }
}

/** Does this window concern that player at all? Used when they leave or are eliminated. */
export function pendingInvolves(pending: Pending, playerId: PlayerId): boolean {
  switch (pending.kind) {
    case "take":
      return pending.victimId === playerId || pending.takerIds.includes(playerId);
    case "discard":
      return pending.playerId === playerId;
    case "challenge":
      return pending.slots.some((s) => s.playerId === playerId);
    case "card_choice":
      return pending.chooserId === playerId || pending.fromPlayerId === playerId;
    case "alliance_target":
      return pending.initiatorId === playerId || pending.partnerId === playerId;
    case "steal_victim":
      return pending.chooserId === playerId;
    case "leader_decision":
      return pending.leaderId === playerId;
    case "inheritance":
      return pending.eliminatedPlayerId === playerId;
    default:
      return assertNever(pending, "pendingInvolves");
  }
}

/**
 * Cancel every window that names a player who has just left play.
 *
 * A leader decision is deliberately NOT cancelled here: the council still has to produce
 * somebody, and `tribal.ts` re-derives the candidate list from the survivors instead.
 */
export function cancelPendingsInvolving(
  ctx: Ctx,
  playerId: PlayerId,
  reason: "player_eliminated" | "game_ended",
): void {
  for (const pending of [...ctx.pending]) {
    if (pending.kind === "leader_decision") continue;
    if (pendingInvolves(pending, playerId)) cancelPending(ctx, pending, reason);
  }
}

export function cancelAllPendings(ctx: Ctx, reason: "game_ended"): void {
  for (const pending of [...ctx.pending]) cancelPending(ctx, pending, reason);
}

// ---------------------------------------------------------------------------
// Opening windows
// ---------------------------------------------------------------------------

export function openTake(
  ctx: Ctx,
  params: {
    readonly origin: TakeOrigin;
    readonly takerIds: readonly PlayerId[];
    readonly victimId: PlayerId;
    readonly spec: TakeSpec;
    /**
     * Open it already closed: the caller resolves it immediately and nobody may react.
     *
     * The one caller is the unblockable Camp Raid house rule
     * (`houseRules.sorryForYouBlocksCampRaid` off), which still needs a real `PendingTake` —
     * every take follow-up is keyed off one — but must not offer a Sorry For You window. It
     * used to hand-build the object instead: a literal with its id minted as
     * `` `pnd-${stamp(ctx)}` as PendingTake["id"] `` and pushed with a raw `ctx.pending.push`,
     * stepping around `newPendingId`, `push` and this constructor all at once, and carrying the
     * only branded-type cast anywhere in `src/engine` outside the `asPlayerId`-style
     * constructors in `types.ts`.
     */
    readonly unreactable?: boolean;
  },
): PendingTake {
  const deadlineMs = params.unreactable === true ? ctx.nowMs : deadlineFor(ctx, "take");
  const pending = push<PendingTake>(ctx, {
    kind: "take",
    id: newPendingId(ctx),
    status: "open",
    origin: params.origin,
    takerIds: [...params.takerIds],
    victimId: params.victimId,
    spec: params.spec,
    blockedByCardUid: null,
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  emitPublic(ctx, {
    type: "take_declared",
    pendingId: pending.id,
    origin: pending.origin,
    takerIds: pending.takerIds,
    victimId: pending.victimId,
    count: takeCount(pending.spec),
    selection: pending.spec.kind,
    deadlineMs,
  });
  return pending;
}

/**
 * Does this string look like a `PendingId`?
 *
 * Exported so the Discord layer can ASK rather than re-encode `/^pnd-/` by hand, which it did
 * in three places (`PENDING_ID_PATTERN` in `interactions.ts`, a doc example in `ui.ts`, and a
 * `startsWith("pnd-")` in the router). The wire format was known in five places and owned by
 * none, so changing it in `newPendingId` would have left the router looking for the old shape
 * and every Sorry-For-You press decoding as `target_required`.
 */
export const looksLikePendingId = (raw: string): boolean => /^pnd-\d+$/.test(raw);

export function openDiscard(
  ctx: Ctx,
  playerId: PlayerId,
  count: number,
  reason: PendingDiscard["reason"],
): PendingDiscard | null {
  const player = findPlayer(ctx, playerId);
  // Nothing to give up: the penalty simply does not land. Rulebook is silent; the alternative
  // is a window nobody can ever answer (docs/RULES.md, "A PLAYER WITH AN EMPTY HAND").
  if (!player || player.hand.length === 0) return null;
  const deadlineMs = deadlineFor(ctx, "discard");
  const pending = push<PendingDiscard>(ctx, {
    kind: "discard",
    id: newPendingId(ctx),
    status: "open",
    playerId,
    count: Math.min(count, player.hand.length),
    reason,
    chosen: [],
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  emitPublic(ctx, {
    type: "forced_discard_opened",
    pendingId: pending.id,
    playerId,
    count: pending.count,
    reason,
    deadlineMs,
  });
  return pending;
}

export function openChallenge(
  ctx: Ctx,
  params: {
    readonly challenge: ChallengeKind;
    readonly cardUid: CardUid;
    readonly initiatorId: PlayerId;
    readonly participantIds: readonly PlayerId[];
    readonly round: number;
  },
): PendingChallenge {
  const deadlineMs = deadlineFor(ctx, "challenge");
  const slots: ChallengeSlot[] = params.participantIds.map((playerId) => ({
    playerId,
    submission: null,
    submittedAtSeq: null,
  }));
  const pending = push<PendingChallenge>(ctx, {
    kind: "challenge",
    id: newPendingId(ctx),
    status: "open",
    challenge: params.challenge,
    cardUid: params.cardUid,
    initiatorId: params.initiatorId,
    slots,
    round: params.round,
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  emitPublic(ctx, {
    type: "challenge_started",
    pendingId: pending.id,
    challenge: params.challenge,
    cardUid: params.cardUid,
    initiatorId: params.initiatorId,
    participantIds: [...params.participantIds],
    round: params.round,
    deadlineMs,
  });
  return pending;
}

export function openCardChoice(
  ctx: Ctx,
  params: {
    readonly chooserId: PlayerId;
    readonly fromPlayerId: PlayerId;
    readonly reason: PendingCardChoice["reason"];
    readonly options: readonly CardUid[];
  },
): PendingCardChoice {
  const deadlineMs = deadlineFor(ctx, "card_choice");
  const pending = push<PendingCardChoice>(ctx, {
    kind: "card_choice",
    id: newPendingId(ctx),
    status: "open",
    chooserId: params.chooserId,
    fromPlayerId: params.fromPlayerId,
    reason: params.reason,
    options: [...params.options],
    chosen: null,
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  announceWindow(ctx, pending.id, "card_choice", [params.chooserId], deadlineMs);
  return pending;
}

export function openAllianceTarget(
  ctx: Ctx,
  params: {
    readonly cardUid: CardUid;
    readonly effectId: EffectId;
    readonly initiatorId: PlayerId;
    readonly partnerId: PlayerId;
    readonly forbiddenTargets: readonly PlayerId[];
  },
): PendingAllianceTarget {
  const deadlineMs = deadlineFor(ctx, "alliance_target");
  const pending = push<PendingAllianceTarget>(ctx, {
    kind: "alliance_target",
    id: newPendingId(ctx),
    status: "open",
    cardUid: params.cardUid,
    effectId: params.effectId,
    initiatorId: params.initiatorId,
    partnerId: params.partnerId,
    forbiddenTargets: [...params.forbiddenTargets],
    chosen: null,
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  announceWindow(ctx, pending.id, "alliance_target", [params.partnerId], deadlineMs);
  return pending;
}

export function openStealVictim(
  ctx: Ctx,
  params: {
    readonly chooserId: PlayerId;
    readonly cardUid: CardUid;
    readonly effectId: EffectId;
    readonly count: number;
  },
): PendingStealVictim {
  const deadlineMs = deadlineFor(ctx, "steal_victim");
  const pending = push<PendingStealVictim>(ctx, {
    kind: "steal_victim",
    id: newPendingId(ctx),
    status: "open",
    chooserId: params.chooserId,
    cardUid: params.cardUid,
    effectId: params.effectId,
    count: params.count,
    chosen: null,
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  announceWindow(ctx, pending.id, "steal_victim", [params.chooserId], deadlineMs);
  return pending;
}

export function openLeaderDecision(
  ctx: Ctx,
  params: {
    readonly leaderId: PlayerId;
    readonly reason: LeaderDecisionReason;
    readonly tier: TieBreakTier;
    readonly candidates: readonly PlayerId[];
    readonly choose: number;
  },
): PendingLeaderDecision {
  const deadlineMs = deadlineFor(ctx, "leader_decision");
  return push<PendingLeaderDecision>(ctx, {
    kind: "leader_decision",
    id: newPendingId(ctx),
    status: "open",
    leaderId: params.leaderId,
    reason: params.reason,
    tier: params.tier,
    candidates: [...params.candidates],
    choose: params.choose,
    chosen: [],
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
}

export function openInheritance(
  ctx: Ctx,
  params: {
    readonly eliminatedPlayerId: PlayerId;
    readonly color: PlayerColor;
    readonly hand: readonly CardUid[];
    readonly voteCardsReturned: number;
    readonly grantedVotesDiscarded: number;
    readonly deferredTrigger: FinalCouncilTrigger;
  },
): PendingInheritance {
  const deadlineMs = deadlineFor(ctx, "inheritance");
  const pending = push<PendingInheritance>(ctx, {
    kind: "inheritance",
    id: newPendingId(ctx),
    status: "open",
    eliminatedPlayerId: params.eliminatedPlayerId,
    color: params.color,
    hand: [...params.hand],
    claimedBy: null,
    voteCardsReturned: params.voteCardsReturned,
    grantedVotesDiscarded: params.grantedVotesDiscarded,
    deferredTrigger: params.deferredTrigger,
    openedAtMs: ctx.nowMs,
    deadlineMs,
  });
  emitPublic(ctx, {
    type: "inheritance_window_opened",
    pendingId: pending.id,
    eliminatedPlayerId: params.eliminatedPlayerId,
    color: params.color,
    handSize: params.hand.length,
    deadlineMs,
  });
  return pending;
}

/** The generic opening announcement, for the three windows with no dedicated event. */
function announceWindow(
  ctx: Ctx,
  pendingId: PendingId,
  pendingKind: PendingKind,
  waitingOnIds: readonly PlayerId[],
  deadlineMs: number,
): void {
  emitPublic(ctx, {
    type: "pending_opened",
    pendingId,
    pendingKind,
    waitingOnIds: [...waitingOnIds],
    deadlineMs,
  });
}

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

/**
 * Which cards a take can reach.
 *
 * The Vote Card is held apart from the hand and is taken only by Control the Vote — docs/RULES.md
 * asserts that but cites no printed sentence, so it is disclosed as
 * `houseRules.voteCardIsStealable` rather than hard-coded.
 */
export function stealablePool(ctx: Ctx, victim: DraftPlayer): CardUid[] {
  return ctx.config.houseRules.voteCardIsStealable
    ? [...victim.hand, ...victim.voteCards]
    : [...victim.hand];
}

function selectCards(ctx: Ctx, victim: DraftPlayer, spec: TakeSpec): CardUid[] {
  switch (spec.kind) {
    case "random": {
      const pool = stealablePool(ctx, victim);
      const shuffled = ctx.rng.shuffle(pool);
      return shuffled.slice(0, Math.min(spec.count, shuffled.length));
    }
    case "chosen":
      // A chosen take opens its own `card_choice` window once it survives Sorry For You; nothing
      // moves at this point.
      return [];
    case "specific":
      return spec.cardUids.filter(
        (uid) =>
          victim.hand.includes(uid) ||
          victim.voteCards.includes(uid) ||
          victim.grantedVotes.includes(uid),
      );
    default:
      return assertNever(spec, "selectCards");
  }
}

export interface TakeResult {
  /** Cards actually moved, per taker, in the order they were dealt out. */
  readonly moved: ReadonlyMap<PlayerId, readonly CardUid[]>;
  readonly total: number;
}

/**
 * Move the cards a take is owed and close the window.
 *
 * Multi-taker takes (Let's Form an Alliance with both partners on one victim, Power Pair's
 * matched pair) deal round-robin, so `spec.count` is the TOTAL and each taker gets their share —
 * "they each steal 1 random card from the 3rd player" with two takers is `count: 2`.
 */
export function resolveTake(ctx: Ctx, take: PendingTake): TakeResult {
  prunePending(ctx, take.id);
  const victim = findPlayer(ctx, take.victimId);
  const moved = new Map<PlayerId, CardUid[]>();
  for (const takerId of take.takerIds) moved.set(takerId, []);

  const selected = victim ? selectCards(ctx, victim, take.spec) : [];
  selected.forEach((uid, i) => {
    const takerId = take.takerIds[i % take.takerIds.length];
    if (!takerId) return;
    const taker = findPlayer(ctx, takerId);
    if (!taker) return;
    giveCardTo(ctx, taker, uid);
    moved.get(takerId)?.push(uid);
  });

  for (const takerId of take.takerIds) {
    const uids = moved.get(takerId) ?? [];
    if (uids.length === 0) continue;
    const taker = requirePlayer(ctx, takerId);
    emitTo(
      ctx,
      {
        type: "take_resolved",
        pendingId: take.id,
        takerId,
        victimId: take.victimId,
        cardUids: uids,
        kinds: kindsOf(ctx, uids),
      },
      takerId,
      take.victimId,
    );
    emitPublic(ctx, {
      type: "cards_transferred",
      fromId: take.victimId,
      toId: takerId,
      count: uids.length,
      fromHandSize: victim ? victim.hand.length : 0,
      toHandSize: taker.hand.length,
    });
  }

  if (selected.length === 0 && take.spec.kind !== "chosen") {
    for (const takerId of take.takerIds) {
      emitPublic(ctx, {
        type: "take_found_nothing",
        pendingId: take.id,
        takerId,
        victimId: take.victimId,
      });
    }
  }

  return { moved, total: selected.length };
}

/**
 * Sorry For You lands.
 *
 * "Instead, they get nothing from you and must discard 1 card (regardless of how many cards you
 * owe them)" — and, for a card that let more than one player take from you, "each of those
 * players gets nothing, and must EACH discard 1 card instead". Both clauses fall out of one
 * pending with an array of takers.
 */
export function blockTake(ctx: Ctx, take: PendingTake, sorryCardUid: CardUid): void {
  prunePending(ctx, take.id);
  emitPublic(ctx, {
    type: "take_blocked",
    pendingId: take.id,
    victimId: take.victimId,
    blockedTakerIds: [...take.takerIds],
    sorryCardUid,
  });
  for (const takerId of take.takerIds) {
    openDiscard(ctx, takerId, 1, "sorry_for_you_penalty");
  }
}

// ---------------------------------------------------------------------------
// Forced discards
// ---------------------------------------------------------------------------

/** Apply one card of a forced discard. Returns true when the obligation is fully paid. */
export function applyDiscardChoice(
  ctx: Ctx,
  pending: PendingDiscard,
  uid: CardUid,
  reason: DiscardReason,
  autoSelected: boolean,
): boolean {
  const player = requirePlayer(ctx, pending.playerId);
  if (!handHas(player, uid))
    throw new Error(`applyDiscardChoice: ${uid} is not in hand`);
  discardCard(ctx, uid, reason, { playerId: pending.playerId, autoSelected });
  const chosen = [...pending.chosen, uid];
  if (chosen.length >= pending.count || player.hand.length === 0) {
    prunePending(ctx, pending.id);
    return true;
  }
  updatePending(ctx, { ...pending, chosen });
  return false;
}

/** The expiry default: "the engine picked a card at random". */
export function autoResolveDiscard(ctx: Ctx, pending: PendingDiscard): void {
  const player = findPlayer(ctx, pending.playerId);
  let remaining = pending.count - pending.chosen.length;
  while (player && remaining > 0 && player.hand.length > 0) {
    const uid = ctx.rng.pick(player.hand);
    if (!uid) break;
    discardCard(ctx, uid, "forced", { playerId: pending.playerId, autoSelected: true });
    remaining -= 1;
  }
  expirePending(ctx, pending, "discard_auto_selected");
}

/** Record a challenge submission without revealing it. Returns the updated pending. */
export function recordSubmission(
  ctx: Ctx,
  pending: PendingChallenge,
  playerId: PlayerId,
  submission: ChallengeSlot["submission"],
): PendingChallenge {
  const slots = pending.slots.map((slot) =>
    slot.playerId === playerId
      ? { ...slot, submission, submittedAtSeq: stamp(ctx) }
      : slot,
  );
  const updated: PendingChallenge = { ...pending, slots };
  updatePending(ctx, updated);
  return updated;
}
