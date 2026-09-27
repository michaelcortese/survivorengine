/**
 * The Tribal Council state machine, and the tie-break ladder.
 *
 * The ladder is the single rule the old implementation got most wrong, so it is worth restating
 * the rulebook verbatim before any code: "If it's unclear who is voted out (because too many
 * players tied, some players got no votes, and/or some players played Immunity Idols), the
 * Tribal Council Leader must decide who to vote out using these criteria: First, always choose
 * from the (non-immune) players who got votes. If there aren't any… Choose from the (non-immune)
 * players who got no votes. Finally, if there's not enough of them… Choose from the players who
 * played Immunity Idols."
 *
 * Three consequences the code below has to honour and the old code did not:
 *  - An Immunity Idol is NOT absolute protection. Rung 3 exists so a council can never end with
 *    nobody voted out.
 *  - Rung 3 is the players who PLAYED idols, which is not the set the idols PROTECTED — an idol
 *    may be played on an ally. The printed reading is the default;
 *    `houseRules.tieBreakIdolTierIncludesProtected` widens it and says so.
 *  - Only the reached rung's players may be offered, so a UI cannot present an ineligible target.
 *
 * ELIMINATIONS ARE RESOLVED ONE AT A TIME, and `afterPlayerCountChanged` runs between them. That
 * is what makes "at a Double Elimination Tribal Council after just the first player is voted out"
 * work without a special case, and it is why a Double Elimination can never take the table from
 * 3 players to 1.
 */

import { eliminationsFor, councilKindOf } from "./cards.js";
import { kindOf, moveToZone } from "./card.js";
import {
  councilCardsLeftInDeck,
  redistributeVoteCards,
  sweepCouncilCards,
} from "./deck.js";
import {
  emitPublic,
  emitTo,
  newCouncilId,
  newEffectId,
  patchCouncil,
  stamp,
  type Ctx,
  type DraftPlayer,
} from "./draft.js";
import { afterPlayerCountChanged, flipCharacterCard } from "./final.js";
import {
  hasOpenPendings,
  openLeaderDecision,
  openTake,
  prunePending,
} from "./pending.js";
import {
  charactersRemaining,
  findPlayer,
  handOffTurn,
  nextInPlayAfter,
  nextInPlayFromSeat,
  playersInPlay,
} from "./player.js";
import type { FinalCouncilTrigger } from "./events.js";
import {
  CardKind,
  TIE_BREAK_LADDER,
  assertNever,
  councilOf,
  isInPlay,
  turnOf,
  type AdvantagePlay,
  type CardUid,
  type CastVoteRecord,
  type CouncilPhase,
  type CouncilState,
  type IdolPlay,
  type LeaderDecisionReason,
  type PendingLeaderDecision,
  type PlayerId,
  type TieBreakTier,
  type VoteObligation,
  type VoteSource,
  type VoteTallyRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Starting a council
// ---------------------------------------------------------------------------

/**
 * "When you draw a Tribal Council Card, IMMEDIATELY place it face up in front of you to start a
 * Tribal Council. This happens at the END of your turn."
 *
 * `drawerId` is who physically drew it and never changes; `leaderId` may differ from the first
 * instant when a Camp Raid intercepted the draw (`houseRules.campRaidTakesTribalCouncilCard`),
 * and may change again if "I'm the Leader Now" is played.
 */
export function startCouncil(
  ctx: Ctx,
  cardUid: CardUid,
  drawerId: PlayerId,
  leaderId: PlayerId,
): void {
  const kind = councilKindOf(kindOf(ctx, cardUid));
  if (!kind) throw new Error(`startCouncil: ${cardUid} is not a Tribal Council card`);
  const turn = turnOf(ctx.stage);
  if (!turn) throw new Error("startCouncil: a council always interrupts a turn");

  moveToZone(ctx, cardUid, "inPlay");
  const council: CouncilState = {
    id: newCouncilId(ctx),
    kind,
    cardUid,
    phase: "advantages",
    drawerId,
    leaderId,
    nextTurnOverride: null,
    advantagesPlayed: [],
    votes: [],
    finishedVoting: [],
    requiredCasts: [],
    idolPlays: [],
    nullifierPlays: [],
    tally: null,
    flippedThisCouncil: [],
    eliminationsRemaining: eliminationsFor(kind),
    phaseEnteredAtMs: ctx.nowMs,
    phaseDeadlineMs: ctx.nowMs + ctx.config.timings.councilDiscussionSafetyTimeout,
  };
  ctx.stage = { kind: "council", turn, council };

  const remaining = councilCardsLeftInDeck(ctx);
  const total = ctx.playerCount === null ? remaining + 1 : totalCouncilsFor(ctx);
  emitPublic(ctx, {
    type: "council_started",
    councilId: council.id,
    kind,
    cardUid,
    drawerId,
    leaderId,
    councilNumber: Math.max(total - remaining, 1),
    councilsRemainingInDeck: remaining,
  });
}

function totalCouncilsFor(ctx: Ctx): number {
  return ctx.cards.filter(
    (c) =>
      (c.kind === CardKind.TribalCouncilSingle ||
        c.kind === CardKind.TribalCouncilDouble) &&
      !ctx.zones.removedFromGame.includes(c.uid),
  ).length;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export function councilPhaseDeadline(ctx: Ctx, phase: CouncilPhase): number | null {
  const t = ctx.config.timings;
  switch (phase) {
    case "advantages":
    case "discussion":
      return ctx.nowMs + t.councilDiscussionSafetyTimeout;
    case "voting":
      return ctx.nowMs + t.councilVotingSafetyTimeout;
    case "idols":
      return ctx.nowMs + t.idolWindow;
    case "nullifiers":
      return ctx.nowMs + t.nullifierWindow;
    case "tally":
    case "tie_break":
    case "cleanup":
      // Driven by the leader-decision pending or by the engine, never by a phase clock.
      return null;
    default:
      return assertNever(phase, "councilPhaseDeadline");
  }
}

export function enterPhase(ctx: Ctx, to: CouncilPhase): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  const deadlineMs = councilPhaseDeadline(ctx, to);
  patchCouncil(ctx, {
    phase: to,
    phaseEnteredAtMs: ctx.nowMs,
    phaseDeadlineMs: deadlineMs,
  });
  emitPublic(ctx, {
    type: "council_phase_changed",
    councilId: council.id,
    from: council.phase,
    to,
    deadlineMs,
  });
}

/** The phases the Leader may advance by hand. Everything after voting closes is automatic. */
export function leaderAdvanceableFrom(phase: CouncilPhase): CouncilPhase | null {
  switch (phase) {
    case "advantages":
      return "discussion";
    case "discussion":
      return "voting";
    case "voting":
      return "idols";
    case "idols":
      return "nullifiers";
    case "nullifiers":
      return "tally";
    case "tally":
    case "tie_break":
    case "cleanup":
      return null;
    default:
      return assertNever(phase, "leaderAdvanceableFrom");
  }
}

/** Run the transition the Leader (or the phase backstop) asked for. */
export function advanceCouncilPhase(ctx: Ctx, council: CouncilState): void {
  switch (council.phase) {
    case "advantages":
      enterPhase(ctx, "discussion");
      return;
    case "discussion":
      openVoting(ctx);
      return;
    case "voting":
      closeVoting(ctx);
      return;
    case "idols":
      // The nullifier window exists only if there is something to nullify.
      if (council.idolPlays.length > 0) openNullifierWindow(ctx);
      else enterTally(ctx);
      return;
    case "nullifiers":
      enterTally(ctx);
      return;
    case "tally":
    case "tie_break":
    case "cleanup":
      return;
    default:
      assertNever(council.phase, "advanceCouncilPhase");
  }
}

// ---------------------------------------------------------------------------
// Tribal Advantages (the pre-voting window)
// ---------------------------------------------------------------------------

function recordAdvantage(ctx: Ctx, council: CouncilState, play: AdvantagePlay): void {
  patchCouncil(ctx, { advantagesPlayed: [...council.advantagesPlayed, play] });
  emitPublic(ctx, {
    type: "advantage_played",
    councilId: council.id,
    cardUid: play.cardUid,
    kind: play.kind,
    playedById: play.playedBy,
    targetId: play.targetId,
  });
}

/**
 * Control the Vote: "take any player's Vote Card. You MUST use that Vote Card in addition to
 * your Vote Card during the Tribal Council at which this card is played."
 *
 * The take goes through the ordinary `PendingTake` machinery when
 * `houseRules.sorryForYouBlocksControlTheVote` is on, because the card says "take" and Sorry For
 * You says "ANY time someone tries to take cards from you" — a pairing the printed rules never
 * address, so it is disclosed rather than decided silently.
 */
export function playControlTheVote(
  ctx: Ctx,
  council: CouncilState,
  actor: DraftPlayer,
  cardUid: CardUid,
  targetId: PlayerId,
  voteCardUid: CardUid,
): void {
  moveToZone(ctx, cardUid, "inPlay");
  emitPublic(ctx, {
    type: "card_played",
    playerId: actor.id,
    cardUid,
    kind: CardKind.ControlTheVote,
    consumedTurnPlay: false,
  });
  recordAdvantage(ctx, council, {
    cardUid,
    kind: CardKind.ControlTheVote,
    playedBy: actor.id,
    targetId,
    atSeq: stamp(ctx),
  });

  if (ctx.config.houseRules.sorryForYouBlocksControlTheVote) {
    emitPublic(ctx, {
      type: "house_rule_applied",
      rule: "sorryForYouBlocksControlTheVote",
      setting: true,
      affectedPlayerIds: [actor.id, targetId],
    });
    openTake(ctx, {
      origin: { kind: "control_the_vote", effectId: newEffectId(ctx), cardUid },
      takerIds: [actor.id],
      victimId: targetId,
      spec: { kind: "specific", cardUids: [voteCardUid] },
    });
    return;
  }
  applyVoteCardTaken(ctx, actor.id, targetId, voteCardUid);
}

/** The Vote Card has changed hands: the taker now owes TWO casts this council. */
export function applyVoteCardTaken(
  ctx: Ctx,
  takerId: PlayerId,
  victimId: PlayerId,
  voteCardUid: CardUid,
): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  emitPublic(ctx, {
    type: "vote_card_taken",
    councilId: council.id,
    takerId,
    victimId,
    cardUid: voteCardUid,
    mustBeUsedThisCouncil: true,
  });
  // The obligation follows the CARD. Voting may already have opened while the victim's Sorry
  // For You window was still up, in which case `openVoting` recorded this very card against the
  // victim — who no longer holds it, so the cast could never be made and the vote could never
  // be closed by anyone but the safety backstop. "You MUST use that Vote Card IN ADDITION TO
  // your Vote Card during the Tribal Council at which this card is played": the debt is the
  // thief's.
  reassignObligation(ctx, {
    playerId: takerId,
    cardUid: voteCardUid,
    source: "stolen_vote_card",
  });
}

export function playGoodwillGamble(
  ctx: Ctx,
  council: CouncilState,
  actor: DraftPlayer,
  cardUid: CardUid,
  recipient: DraftPlayer,
): void {
  const at = actor.hand.indexOf(cardUid);
  if (at >= 0) actor.hand.splice(at, 1);
  recipient.grantedVotes.push(cardUid);
  emitPublic(ctx, {
    type: "card_played",
    playerId: actor.id,
    cardUid,
    kind: CardKind.GoodwillGamble,
    consumedTurnPlay: false,
  });
  recordAdvantage(ctx, council, {
    cardUid,
    kind: CardKind.GoodwillGamble,
    playedBy: actor.id,
    targetId: recipient.id,
    atSeq: stamp(ctx),
  });
  emitPublic(ctx, {
    type: "goodwill_gamble_given",
    councilId: council.id,
    giverId: actor.id,
    recipientId: recipient.id,
    cardUid,
  });
  // "MUST be used during the Tribal Council at which it is played (just like a Vote Card)."
  addObligation(ctx, {
    playerId: recipient.id,
    cardUid,
    source: "goodwill_gamble",
  });
}

/**
 * "I'm the Leader Now" — two effects, and audit #70 implemented only the first. It transfers the
 * Leader role AND the next turn: "It's your turn when the Tribal Council ends (or the player
 * after you if you are eliminated)."
 */
export function playImTheLeaderNow(
  ctx: Ctx,
  council: CouncilState,
  actor: DraftPlayer,
  cardUid: CardUid,
): void {
  moveToZone(ctx, cardUid, "inPlay");
  emitPublic(ctx, {
    type: "card_played",
    playerId: actor.id,
    cardUid,
    kind: CardKind.ImTheLeaderNow,
    consumedTurnPlay: false,
  });
  recordAdvantage(ctx, council, {
    cardUid,
    kind: CardKind.ImTheLeaderNow,
    playedBy: actor.id,
    targetId: null,
    atSeq: stamp(ctx),
  });
  const previous = council.leaderId;
  patchCouncil(ctx, { leaderId: actor.id, nextTurnOverride: actor.id });
  emitPublic(ctx, {
    type: "council_leader_changed",
    councilId: council.id,
    fromId: previous,
    toId: actor.id,
    cardUid,
    grantsNextTurn: true,
  });
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

export function addObligation(ctx: Ctx, obligation: VoteObligation): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  if (council.requiredCasts.some((c) => c.cardUid === obligation.cardUid)) return;
  patchCouncil(ctx, {
    requiredCasts: [...council.requiredCasts, obligation],
    // A player who now owes a cast is not finished: `finish_voting` is refused while anything
    // is outstanding, so leaving them on the list would close a ballot they still have to fill.
    finishedVoting: council.finishedVoting.filter((id) => id !== obligation.playerId),
  });
}

/**
 * Move an obligation to a different player, because the CARD moved. Distinct from
 * `addObligation`, which is a no-op when the card is already listed — exactly the short-circuit
 * that used to strand a stolen Vote Card's debt with its original owner.
 */
function reassignObligation(ctx: Ctx, obligation: VoteObligation): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  const others = council.requiredCasts.filter((c) => c.cardUid !== obligation.cardUid);
  patchCouncil(ctx, {
    requiredCasts: [...others, obligation],
    finishedVoting: council.finishedVoting.filter((id) => id !== obligation.playerId),
  });
}

/**
 * Open the vote.
 *
 * The obligation list is per CARD, not per player: Control the Vote ("You MUST use that Vote
 * Card IN ADDITION TO your Vote Card") and Goodwill Gamble ("MUST be used during the Tribal
 * Council at which it is played") both make a single player owe two casts, which a `PlayerId[]`
 * cannot express — which is why `must_cast_mandatory_vote` previously had nothing to check.
 */
export function openVoting(ctx: Ctx): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  const casts: VoteObligation[] = [...council.requiredCasts];
  const known = new Set(casts.map((c) => c.cardUid));
  for (const player of playersInPlay(ctx)) {
    for (const uid of player.voteCards) {
      if (!known.has(uid))
        casts.push({ playerId: player.id, cardUid: uid, source: "vote_card" });
    }
    for (const uid of player.grantedVotes) {
      if (!known.has(uid))
        casts.push({ playerId: player.id, cardUid: uid, source: "goodwill_gamble" });
    }
  }
  patchCouncil(ctx, { requiredCasts: casts });
  enterPhase(ctx, "voting");
  const updated = councilOf(ctx.stage);
  emitPublic(ctx, {
    type: "voting_opened",
    councilId: council.id,
    requiredVoterIds: [...new Set(casts.map((c) => c.playerId))],
    requiredCasts: casts,
    deadlineMs: updated?.phaseDeadlineMs ?? null,
  });
}

export function castVote(
  ctx: Ctx,
  council: CouncilState,
  voter: DraftPlayer,
  cardUid: CardUid,
  targetId: PlayerId,
  source: VoteSource,
): void {
  moveToZone(ctx, cardUid, "votingBox");
  const record: CastVoteRecord = {
    cardUid,
    voterId: voter.id,
    targetId,
    source,
    order: council.votes.length,
  };
  patchCouncil(ctx, {
    votes: [...council.votes, record],
    requiredCasts: council.requiredCasts.filter((c) => c.cardUid !== cardUid),
  });
  emitTo(
    ctx,
    {
      type: "vote_cast",
      councilId: council.id,
      voterId: voter.id,
      cardUid,
      targetId,
      source,
    },
    voter.id,
  );
}

/** Cards this player still owes the box. `finish_voting` is refused while it is non-empty. */
export function outstandingCasts(
  council: CouncilState,
  playerId: PlayerId,
): VoteObligation[] {
  return council.requiredCasts.filter((c) => c.playerId === playerId);
}

export function finishVoting(
  ctx: Ctx,
  council: CouncilState,
  playerId: PlayerId,
): void {
  const finished = council.finishedVoting.includes(playerId)
    ? council.finishedVoting
    : [...council.finishedVoting, playerId];
  patchCouncil(ctx, { finishedVoting: finished });
  const remaining = playersInPlay(ctx)
    .filter((p) => !finished.includes(p.id))
    .map((p) => p.id);
  emitPublic(ctx, {
    type: "voter_finished",
    councilId: council.id,
    voterId: playerId,
    remainingVoterIds: remaining,
  });
  // The Voting Box passes to every seat "even if they don't have a Vote Card", so voting closes
  // when the box has been all the way round — not when the last obligation is spent.
  if (remaining.length === 0) closeVoting(ctx);
}

/**
 * Give up on the casts nobody is going to make, and say who.
 *
 * The voting phase was the ONE window in the engine with no expiry default. `PendingDefault`
 * names one for takes, discards, challenges, card choices, alliance targets, steal victims,
 * leader decisions and Inheritance; the mandatory vote had none, and it is the window that
 * gates the rest of the game. `advance()` re-armed the phase clock forever while anything was
 * outstanding, and both interactive routes out (`advance_council`, `finish_voting`) refuse with
 * `must_cast_mandatory_vote` — so one player who closed Discord froze the council permanently,
 * with no error anyone could see and no escape that was not destructive (abandon the game, or
 * remove the player, which also takes them off the Jury).
 *
 * The owed CARDS are left where they are: `cleanupCouncil` collects every Vote Card back to the
 * bank and re-deals one per survivor, and discards any uncast Goodwill Gamble, so a forfeited
 * vote costs exactly the vote.
 */
export function forfeitOutstandingVotes(ctx: Ctx, council: CouncilState): void {
  const owed = council.requiredCasts;
  if (owed.length === 0) return;
  const playerIds = [...new Set(owed.map((cast) => cast.playerId))];
  patchCouncil(ctx, {
    requiredCasts: [],
    finishedVoting: [...new Set([...council.finishedVoting, ...playerIds])],
  });
  emitPublic(ctx, {
    type: "votes_forfeited",
    councilId: council.id,
    playerIds,
    casts: [...owed],
  });
}

export function closeVoting(ctx: Ctx): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  emitPublic(ctx, { type: "voting_closed", councilId: council.id });
  enterPhase(ctx, "idols");
  const updated = councilOf(ctx.stage);
  emitPublic(ctx, {
    type: "idol_window_opened",
    councilId: council.id,
    deadlineMs: updated?.phaseDeadlineMs ?? ctx.nowMs,
  });
}

// ---------------------------------------------------------------------------
// Idols
// ---------------------------------------------------------------------------

export function playImmunityIdol(
  ctx: Ctx,
  council: CouncilState,
  actor: DraftPlayer,
  cardUid: CardUid,
  protects: PlayerId,
): void {
  moveToZone(ctx, cardUid, "inPlay");
  emitPublic(ctx, {
    type: "card_played",
    playerId: actor.id,
    cardUid,
    kind: CardKind.ImmunityIdol,
    consumedTurnPlay: false,
  });
  const play: IdolPlay = {
    cardUid,
    playedBy: actor.id,
    protects,
    nullifiedBy: null,
    atSeq: stamp(ctx),
  };
  patchCouncil(ctx, { idolPlays: [...council.idolPlays, play] });
  emitPublic(ctx, {
    type: "idol_played",
    councilId: council.id,
    cardUid,
    playedById: actor.id,
    protectsId: protects,
  });
}

export function openNullifierWindow(ctx: Ctx): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  enterPhase(ctx, "nullifiers");
  const updated = councilOf(ctx.stage);
  emitPublic(ctx, {
    type: "nullifier_window_opened",
    councilId: council.id,
    idolCardUids: council.idolPlays
      .filter((i) => i.nullifiedBy === null)
      .map((i) => i.cardUid),
    deadlineMs: updated?.phaseDeadlineMs ?? ctx.nowMs,
  });
}

export function playIdolNullifier(
  ctx: Ctx,
  council: CouncilState,
  actor: DraftPlayer,
  cardUid: CardUid,
  targetIdolUid: CardUid,
): void {
  moveToZone(ctx, cardUid, "inPlay");
  emitPublic(ctx, {
    type: "card_played",
    playerId: actor.id,
    cardUid,
    kind: CardKind.IdolNullifier,
    consumedTurnPlay: false,
  });
  // "Cancels THAT immunity idol": one nullifier, one idol. There are 4 idols and 1 nullifier, so
  // the "all idols" reading would be wildly out of scale — but it is disclosed, not assumed.
  const cancelAll = ctx.config.houseRules.nullifierCancelsAllIdols;
  const idolPlays = council.idolPlays.map((play) =>
    play.nullifiedBy === null && (cancelAll || play.cardUid === targetIdolUid)
      ? { ...play, nullifiedBy: cardUid }
      : play,
  );
  patchCouncil(ctx, {
    idolPlays,
    nullifierPlays: [
      ...council.nullifierPlays,
      { cardUid, playedBy: actor.id, targetIdolUid, atSeq: stamp(ctx) },
    ],
  });
  if (cancelAll) {
    emitPublic(ctx, {
      type: "house_rule_applied",
      rule: "nullifierCancelsAllIdols",
      setting: true,
      affectedPlayerIds: council.idolPlays.map((i) => i.playedBy),
    });
  }
  for (const play of idolPlays) {
    if (play.nullifiedBy !== cardUid) continue;
    emitPublic(ctx, {
      type: "idol_nullified",
      councilId: council.id,
      nullifierCardUid: cardUid,
      idolCardUid: play.cardUid,
      playedById: actor.id,
      idolProtectedId: play.protects,
    });
  }
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

/** Votes for a player protected by a LIVE (non-nullified) idol are zeroed, not redirected. */
export function computeTally(ctx: Ctx, council: CouncilState): VoteTallyRow[] {
  const liveIdols = council.idolPlays.filter((i) => i.nullifiedBy === null);
  return playersInPlay(ctx).map((player) => {
    const rawVotes = council.votes.filter((v) => v.targetId === player.id).length;
    const protectedByIdolUids = liveIdols
      .filter((i) => i.protects === player.id)
      .map((i) => i.cardUid);
    const immune = protectedByIdolUids.length > 0;
    return {
      playerId: player.id,
      rawVotes,
      countedVotes: immune ? 0 : rawVotes,
      immune,
      protectedByIdolUids,
    };
  });
}

export function enterTally(ctx: Ctx): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  enterPhase(ctx, "tally");
  const rows = computeTally(ctx, council);
  patchCouncil(ctx, { tally: rows });

  // This event IS the moment the secret ballot becomes public information — and "the ballot" is
  // which colour each card went to, never who put it there. The authorship is dropped HERE, at
  // the emit site, rather than merely being left unrendered.
  emitPublic(ctx, {
    type: "votes_revealed",
    councilId: council.id,
    revealOrder: [...council.votes]
      .sort((a, b) => a.order - b.order)
      .map((vote) => ({
        cardUid: vote.cardUid,
        targetId: vote.targetId,
        source: vote.source,
        order: vote.order,
      })),
    totalVotes: council.votes.length,
  });
  const highest = highestCounted(rows);
  emitPublic(ctx, {
    type: "tally_computed",
    councilId: council.id,
    rows,
    highestCountedVotes: highest,
    topVoteGetters: rows
      .filter((r) => highest > 0 && r.countedVotes === highest)
      .map((r) => r.playerId),
  });
  resolveEliminations(ctx);
}

const highestCounted = (rows: readonly VoteTallyRow[]): number =>
  rows.reduce((best, row) => Math.max(best, row.countedVotes), 0);

// ---------------------------------------------------------------------------
// The tie-break ladder
// ---------------------------------------------------------------------------

interface Descent {
  readonly from: TieBreakTier;
  readonly to: TieBreakTier;
  readonly emptyBecause: "no_candidates" | "not_enough_candidates";
}

interface LadderResult {
  readonly tier: TieBreakTier;
  readonly candidates: readonly PlayerId[];
  readonly descents: readonly Descent[];
  readonly widenedByHouseRule: boolean;
}

function rungMembers(
  ctx: Ctx,
  council: CouncilState,
  rows: readonly VoteTallyRow[],
  tier: TieBreakTier,
): { readonly ids: PlayerId[]; readonly widened: boolean } {
  switch (tier) {
    case "voted_non_immune":
      return {
        ids: rows.filter((r) => !r.immune && r.rawVotes > 0).map((r) => r.playerId),
        widened: false,
      };
    case "unvoted_non_immune":
      return {
        ids: rows.filter((r) => !r.immune && r.rawVotes === 0).map((r) => r.playerId),
        widened: false,
      };
    case "played_or_protected_by_idol": {
      const eligible = new Set(rows.map((r) => r.playerId));
      // "Choose from the players who PLAYED Immunity Idols" — with no qualification about
      // whether the idol survived. A player whose own idol was cancelled by a Nullifier still
      // played one; filtering them out made them UNTOUCHABLE whenever they were immune through
      // somebody else's idol (off rungs 1 and 2 for being immune, off rung 3 for having been
      // nullified), which inverts the rule this rung exists to encode.
      const played = council.idolPlays
        .map((i) => i.playedBy)
        .filter((id) => eligible.has(id));
      if (!ctx.config.houseRules.tieBreakIdolTierIncludesProtected) {
        return { ids: [...new Set(played)], widened: false };
      }
      const protectedIds = council.idolPlays
        .filter((i) => i.nullifiedBy === null)
        .map((i) => i.protects)
        .filter((id) => eligible.has(id));
      const union = [...new Set([...played, ...protectedIds])];
      return { ids: union, widened: union.length > new Set(played).size };
    }
    default:
      return assertNever(tier, "rungMembers");
  }
}

/**
 * Walk the ladder and stop at the first rung that can supply `choose` candidates. Only that
 * rung's players are offered — the ladder cannot be skipped by a UI that offers the wrong list.
 */
export function walkLadder(
  ctx: Ctx,
  council: CouncilState,
  rows: readonly VoteTallyRow[],
  choose: number,
): LadderResult {
  const descents: Descent[] = [];
  let widened = false;
  for (let i = 0; i < TIE_BREAK_LADDER.length; i += 1) {
    const tier = TIE_BREAK_LADDER[i];
    if (!tier) break;
    const rung = rungMembers(ctx, council, rows, tier);
    widened = widened || rung.widened;
    if (rung.ids.length >= choose) {
      return { tier, candidates: rung.ids, descents, widenedByHouseRule: rung.widened };
    }
    const next = TIE_BREAK_LADDER[i + 1];
    if (next) {
      descents.push({
        from: tier,
        to: next,
        emptyBecause: rung.ids.length === 0 ? "no_candidates" : "not_enough_candidates",
      });
    } else if (rung.ids.length > 0) {
      // Last rung, short of `choose`: take what there is rather than end with nobody out.
      return { tier, candidates: rung.ids, descents, widenedByHouseRule: rung.widened };
    }
  }
  // THE LADDER IS EXHAUSTED. Every remaining player is immune through somebody ELSE's idol and
  // no idol PLAYER is still eligible, so all three printed rungs are empty. The rulebook has no
  // answer for this, but it does have a controlling principle — "an Immunity Idol is NOT
  // absolute protection", and tier 3 exists "precisely so a council can never end with nobody
  // out" — so the immunity qualifier is what gives way, not the ladder. The two vote-based
  // rungs are re-walked WITHOUT it, and the fall back to them is announced like any other
  // movement on the ladder rather than mislabelled as the printed idol rung.
  const last = TIE_BREAK_LADDER[TIE_BREAK_LADDER.length - 1] ?? "voted_non_immune";
  const voted = rows.filter((r) => r.rawVotes > 0).map((r) => r.playerId);
  const fallbackTier: TieBreakTier =
    voted.length > 0 ? "voted_non_immune" : "unvoted_non_immune";
  const candidates = voted.length > 0 ? voted : rows.map((r) => r.playerId);
  if (candidates.length > 0) {
    descents.push({ from: last, to: fallbackTier, emptyBecause: "no_candidates" });
  }
  return {
    tier: fallbackTier,
    candidates,
    descents,
    widenedByHouseRule: widened,
  };
}

// ---------------------------------------------------------------------------
// Elimination resolution
// ---------------------------------------------------------------------------

type Step =
  | { readonly kind: "flip"; readonly playerId: PlayerId; readonly votes: number }
  | {
      readonly kind: "decide";
      readonly reason: LeaderDecisionReason;
      readonly tier: TieBreakTier;
      readonly candidates: readonly PlayerId[];
      readonly choose: number;
      readonly descents: readonly Descent[];
      readonly widenedByHouseRule: boolean;
    }
  | { readonly kind: "done" };

function planNextElimination(ctx: Ctx, council: CouncilState): Step {
  const rows = (council.tally ?? []).filter(
    (row) =>
      !council.flippedThisCouncil.includes(row.playerId) &&
      (findPlayer(ctx, row.playerId)?.eliminatedAtSeq ?? null) === null &&
      (findPlayer(ctx, row.playerId)?.leftAtSeq ?? null) === null,
  );
  if (rows.length === 0) return { kind: "done" };

  const highest = highestCounted(rows);
  const top = rows.filter((r) => highest > 0 && r.countedVotes === highest);
  const stillToGo = council.eliminationsRemaining;
  const isDoubleStep = stillToGo >= 2;

  // "If there are only 3 players left and 2 players would be eliminated at the same time
  // (leaving you with only 1 player left in the game), the Tribal Council Leader decides which
  // of the tied players is eliminated. Immediately begin The Final Tribal Council."
  //
  // NOTE the scope. This overrides an outcome that would otherwise send TWO players home at
  // once, so it applies only when the first elimination is itself forced by a TIE ("which of the
  // TIED players"). With one clear top vote-getter there is nothing to override: that player is
  // flipped, and if that leaves two players the Final Tribal Council interrupts before the
  // second elimination — which is the rulebook's own "at a Double Elimination Tribal Council
  // after just the first player is voted out" route, not this one.
  //
  // It fires ONCE. A Leader who answers it by turning over a card that eliminates nobody has
  // not used up the "only one may be eliminated" cap, and the Double Elimination card still
  // owes its second turn-over — asking the override again would just loop.
  if (
    isDoubleStep &&
    top.length >= 2 &&
    playersInPlay(ctx).length === 3 &&
    council.flippedThisCouncil.length === 0
  ) {
    const fatal = top.filter((r) => {
      const p = findPlayer(ctx, r.playerId);
      return p !== null && charactersRemaining(p) === 1;
    });
    if (fatal.length >= 2) {
      return {
        kind: "decide",
        reason: "three_player_double_override",
        tier: "voted_non_immune",
        // ONLY the tied players a turn-over would actually ELIMINATE. The rule is "the Tribal
        // Council Leader decides which of the tied players IS ELIMINATED" — so a tied player who
        // still holds two Survivor Character Cards is not an answer to the question being asked,
        // and offering them one was how this went wrong: the Leader would name a two-torch
        // player, `applyLeaderDecision` would correctly notice nobody had been eliminated and
        // leave `eliminationsRemaining` at 2, and the re-entry into `planNextElimination` found
        // the override gated off by `flippedThisCouncil.length === 0` and fell through to the
        // "exactly 2 tied for most: both are voted out" branch — which flips whichever of the
        // two REMAINING tied players happens to sit at the lower seat, with no Leader decision
        // at all. A player went home, and became the Final Tribal Council Leader, because seat 1
        // sorts before seat 2. With this list every candidate's turn-over eliminates them, so
        // the decision always consumes the elimination it was asked about and the seat-order
        // branch is unreachable from here.
        candidates: fatal.map((r) => r.playerId),
        choose: 1,
        descents: [],
        widenedByHouseRule: false,
      };
    }
  }

  if (top.length === 1) {
    const row = top[0];
    if (!row) return { kind: "done" };
    return { kind: "flip", playerId: row.playerId, votes: row.countedVotes };
  }

  if (top.length >= 2) {
    if (isDoubleStep && top.length >= 3) {
      // "If 3 or more players are tied with the most votes, the Leader decides which 2 go."
      return {
        kind: "decide",
        reason: "double_tie_for_most",
        tier: "voted_non_immune",
        candidates: top.map((r) => r.playerId),
        choose: 2,
        descents: [],
        widenedByHouseRule: false,
      };
    }
    if (isDoubleStep) {
      // Exactly 2 tied for most: "both are voted out" — no Leader decision at all. They are
      // flipped one at a time so the Final Tribal Council can interrupt between them.
      const row = top[0];
      if (!row) return { kind: "done" };
      return { kind: "flip", playerId: row.playerId, votes: row.countedVotes };
    }
    return {
      kind: "decide",
      // Second pass of a Double Elimination: "1 player gets the most votes, and 2 or more are
      // tied with the second most… then the Leader decides which of the tied players is also
      // voted out."
      reason:
        council.kind === "double" && council.flippedThisCouncil.length > 0
          ? "double_tie_for_second"
          : "tie_for_most",
      tier: "voted_non_immune",
      candidates: top.map((r) => r.playerId),
      choose: 1,
      descents: [],
      widenedByHouseRule: false,
    };
  }

  // Nobody has a counted vote: every vote was nullified by an idol, or nobody voted at all.
  const ladder = walkLadder(ctx, council, rows, 1);
  if (ladder.candidates.length === 0) return { kind: "done" };
  return {
    kind: "decide",
    reason: "unclear_cascade",
    tier: ladder.tier,
    candidates: ladder.candidates,
    choose: 1,
    descents: ladder.descents,
    widenedByHouseRule: ladder.widenedByHouseRule,
  };
}

function triggerLabel(council: CouncilState): FinalCouncilTrigger {
  if (council.kind === "single") return "single_elimination";
  return council.eliminationsRemaining >= 2
    ? "double_elimination_partial"
    : "double_elimination_complete";
}

/**
 * Drive the council to its conclusion, one elimination at a time.
 *
 * Re-entered every time a window this resolution opened (a leader decision, an Inheritance
 * claim) closes, which is why the first thing it does is re-read the council out of the stage:
 * by then the Final Tribal Council may already have taken over.
 */
export function resolveEliminations(ctx: Ctx): void {
  for (;;) {
    const council = councilOf(ctx.stage);
    if (!council) return;
    if (council.phase !== "tally" && council.phase !== "tie_break") return;
    if (hasOpenPendings(ctx)) return;
    if (council.eliminationsRemaining <= 0) {
      cleanupCouncil(ctx);
      return;
    }

    const step = planNextElimination(ctx, council);
    switch (step.kind) {
      case "done":
        cleanupCouncil(ctx);
        return;
      case "decide": {
        for (const descent of step.descents) {
          emitPublic(ctx, {
            type: "tie_break_tier_descended",
            councilId: council.id,
            from: descent.from,
            to: descent.to,
            emptyBecause: descent.emptyBecause,
          });
        }
        if (step.widenedByHouseRule) {
          emitPublic(ctx, {
            type: "house_rule_applied",
            rule: "tieBreakIdolTierIncludesProtected",
            setting: true,
            affectedPlayerIds: [...step.candidates],
          });
        }
        if (council.phase !== "tie_break") enterPhase(ctx, "tie_break");
        const pending = openLeaderDecision(ctx, {
          leaderId: council.leaderId,
          reason: step.reason,
          tier: step.tier,
          candidates: step.candidates,
          choose: Math.min(step.choose, step.candidates.length),
        });
        emitPublic(ctx, {
          type: "tie_break_required",
          councilId: council.id,
          pendingId: pending.id,
          leaderId: council.leaderId,
          reason: step.reason,
          tier: step.tier,
          candidates: [...step.candidates],
          choose: pending.choose,
          deadlineMs: pending.deadlineMs,
        });
        return;
      }
      case "flip": {
        const player = findPlayer(ctx, step.playerId);
        if (!player) return;
        const trigger = triggerLabel(council);
        patchCouncil(ctx, { eliminationsRemaining: council.eliminationsRemaining - 1 });
        flipCharacterCard(
          ctx,
          player,
          step.votes,
          { allowInheritance: true, councilId: council.id },
          trigger,
        );
        break;
      }
      default:
        assertNever(step, "resolveEliminations");
    }
  }
}

/** The Leader has named who goes home. Applies every choice, then resumes the resolution. */
export function applyLeaderDecision(
  ctx: Ctx,
  pending: PendingLeaderDecision,
  targets: readonly PlayerId[],
  autoSelected: boolean,
): void {
  prunePending(ctx, pending.id);
  const council = councilOf(ctx.stage);
  if (!council) return;
  emitPublic(ctx, {
    type: "leader_chose_eliminations",
    councilId: council.id,
    leaderId: pending.leaderId,
    targetIds: [...targets],
    tier: pending.tier,
    reason: pending.reason,
  });
  if (autoSelected) {
    // The expiry default is documented in `PendingDefault.leader_choice_auto_selected`.
    emitPublic(ctx, {
      type: "pending_expired",
      pendingId: pending.id,
      pendingKind: "leader_decision",
      defaultApplied: "leader_choice_auto_selected",
    });
  }

  for (const targetId of targets) {
    const live = councilOf(ctx.stage);
    if (!live) return;
    const player = findPlayer(ctx, targetId);
    if (!player || !isInPlay(player)) continue;
    const votes = live.tally?.find((r) => r.playerId === targetId)?.countedVotes ?? 0;
    const isOverride = pending.reason === "three_player_double_override";
    const trigger: FinalCouncilTrigger = isOverride
      ? "three_player_override"
      : triggerLabel(live);
    flipCharacterCard(
      ctx,
      player,
      votes,
      { allowInheritance: true, councilId: live.id },
      trigger,
    );
    // The three-player override is a cap on ELIMINATIONS — "the Tribal Council Leader decides
    // which of the tied players is eliminated. Immediately begin The Final Tribal Council." If
    // the Leader spared everyone in danger and turned over a card that eliminated nobody, that
    // premise never came true: neither "2 players would be eliminated" nor the Final Council
    // follows, so the Double Elimination card's second turn-over — "The 2 DIFFERENT players
    // with the most votes must EACH turn over one of their Survivor Character Cards" — is still
    // owed, and the council must not simply stop with one card flipped and nobody out.
    const spentAnElimination = !isOverride || player.eliminatedAtSeq !== null;
    const after = councilOf(ctx.stage);
    if (after && spentAnElimination) {
      patchCouncil(ctx, {
        eliminationsRemaining: Math.max(after.eliminationsRemaining - 1, 0),
      });
    }
    // The Leader named every one of these players in ONE binding decision, so the rest of it
    // survives whatever the first elimination opened. Only the endgame may cut it short: "The
    // moment there are only 2 players left in the game … IMMEDIATELY start the Final Tribal
    // Council", including part-way through a Double Elimination. An Inheritance window may NOT
    // — the remaining names lived only in this loop and were lost when it returned, and the
    // Leader was then re-prompted from a freshly widened candidate list.
    if (playersInPlay(ctx).length <= 2) break;
  }

  resolveEliminations(ctx);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * "After voting has ended, return 1 Vote Card to every player who still has at least one
 * Survivor Character Card left in the game. Discard all other cards used during the Tribal
 * Council (including the Tribal Council Card) face up in the Discard Pile. After Tribal,
 * continue play with the player on your left."
 */
export function cleanupCouncil(ctx: Ctx): void {
  const council = councilOf(ctx.stage);
  const turn = turnOf(ctx.stage);
  if (!council || !turn) return;
  enterPhase(ctx, "cleanup");

  sweepCouncilCards(ctx, council);
  redistributeVoteCards(ctx, council.id);

  const eliminatedIds = council.flippedThisCouncil.filter((id) => {
    const player = findPlayer(ctx, id);
    return player !== null && player.eliminatedAtSeq !== null;
  });

  // Default: the player to the LEFT of the Leader. Overridden by "I'm the Leader Now", which
  // grants its player the next turn — "or the player after you if you are eliminated".
  let next: DraftPlayer | null;
  let fromOverride = false;
  const override = council.nextTurnOverride;
  if (override) {
    const player = findPlayer(ctx, override);
    fromOverride = true;
    next = player && isInPlay(player) ? player : nextInPlayAfter(ctx, override);
  } else {
    const leader = findPlayer(ctx, council.leaderId);
    next = leader ? nextInPlayFromSeat(ctx, leader.seat) : null;
  }

  emitPublic(ctx, {
    type: "council_ended",
    councilId: council.id,
    eliminatedIds,
    flippedIds: [...council.flippedThisCouncil],
    nextPlayerId: next?.id ?? null,
    nextTurnFromOverride: fromOverride,
  });

  ctx.stage = { kind: "turn", turn };
  handOffTurn(ctx, turn, next);
  afterPlayerCountChanged(ctx, "single_elimination");
}
