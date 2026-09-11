/**
 * Leaving the game, and the Final Tribal Council.
 *
 * WHY THESE TWO THINGS SHARE A FILE: "The moment there are only 2 players left in the game,
 * regardless of how many Survivor Character Cards they have left, it's time to IMMEDIATELY start
 * the Final Tribal Council." Audit #14 is precisely that this trigger fired on one of four
 * elimination paths, and the prescribed fix is to centralise the check rather than enumerate the
 * call sites. So `afterPlayerCountChanged()` — ONE predicate, `playersInPlay(ctx).length === 2` —
 * lives here, and every route that can remove a player from play (`flipCharacterCard`,
 * `eliminatePlayer`, `depart`) is in the same file and calls it on the way out. Six routes reach
 * two players; `FinalCouncilTrigger` is a provenance LABEL for the narration, never a branch.
 *
 * Audit #1-#5, #18, #35, #56: in the old code the endgame was literally unreachable — nothing
 * ever wrote a jury vote, and `finalTribalLeader` was assigned on exactly one of four paths.
 * Here the Leader is derived from `max(eliminatedAtSeq)`, so every path that sets an elimination
 * sets the Leader too, and none of them has to remember to.
 */

import type { FinalCouncilTrigger } from "./events.js";
import { discardCard, inheritanceForColor, kindsOf, requireCard } from "./card.js";
import {
  redistributeVoteCards,
  returnVoteCardsToBank,
  sweepCouncilCards,
} from "./deck.js";
import {
  emitPublic,
  emitTo,
  patchCouncil,
  patchFinalCouncil,
  stamp,
  type Ctx,
  type DraftPlayer,
} from "./draft.js";
import {
  cancelAllPendings,
  cancelPendingsInvolving,
  expirePending,
  openInheritance,
  prunePending,
} from "./pending.js";
import {
  charactersRemaining,
  findPlayer,
  jurors,
  nextUnflippedCharacter,
  playersInPlay,
} from "./player.js";
import {
  councilOf,
  finalCouncilOf,
  finalPhaseAtOrAfter,
  isInPlay,
  type CardInstance,
  type CardUid,
  type CouncilId,
  type FinalCouncilPhase,
  type FinalCouncilState,
  type JuryVote,
  type PendingInheritance,
  type PlayerId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Flipping and elimination
// ---------------------------------------------------------------------------

export interface EliminationOptions {
  /** False for the mass force-eliminations that end an exhausted draw pile. */
  readonly allowInheritance: boolean;
  readonly councilId: CouncilId | null;
}

/**
 * Turn over ONE Survivor Character Card. This is not elimination — audit #110 announced the
 * first flip as "the 1st person voted out of Survivor". The card is turned OVER to its printed
 * "VOTED OUT" side and stays face up and visible (officialgamerules.org says face down; it is
 * wrong, and docs/RULES.md flags it).
 */
export function flipCharacterCard(
  ctx: Ctx,
  player: DraftPlayer,
  votesReceived: number,
  options: EliminationOptions,
  trigger: FinalCouncilTrigger,
): void {
  const card = nextUnflippedCharacter(player);
  if (!card) return;
  const at = player.characterCards.findIndex((c) => c.uid === card.uid);
  player.characterCards[at] = { ...card, flipped: true, flippedAtSeq: stamp(ctx) };
  emitPublic(ctx, {
    type: "character_card_flipped",
    playerId: player.id,
    cardUid: card.uid,
    charactersRemaining: charactersRemaining(player),
    votesReceived,
    councilId: options.councilId,
  });

  const council = councilOf(ctx.stage);
  if (council && !council.flippedThisCouncil.includes(player.id)) {
    // "2 DIFFERENT players" is about FLIPS: a two-torch player who has been flipped is still in
    // the game but must be excluded from the second elimination of a Double Elimination.
    patchCouncil(ctx, {
      flippedThisCouncil: [...council.flippedThisCouncil, player.id],
    });
  }

  if (charactersRemaining(player) === 0) eliminatePlayer(ctx, player, options, trigger);
}

/**
 * Both Survivor Character Cards turned over: the player is out and joins the Jury.
 *
 * "When this happens, put your cards face up on top of the Discard Pile" — unless the holder of
 * the matching-colour Inheritance card claims the hand instead. The rulebook does not address
 * the rest of what a dead player is holding, so `PendingInheritance` states the engine's answers
 * and this function implements them: Vote Cards to the bank (a dead player holding one would
 * block voting from ever closing, audit #23), a granted Goodwill Gamble discarded, a Camp Raid
 * marker in front of them cancelled.
 */
export function eliminatePlayer(
  ctx: Ctx,
  player: DraftPlayer,
  options: EliminationOptions,
  trigger: FinalCouncilTrigger,
): void {
  if (player.eliminatedAtSeq !== null || player.leftAtSeq !== null) return;
  player.eliminatedAtSeq = stamp(ctx);

  const order = ctx.players.filter((p) => p.eliminatedAtSeq !== null).length;
  emitPublic(ctx, {
    type: "player_eliminated",
    playerId: player.id,
    eliminationOrder: order,
    playersRemaining: playersInPlay(ctx).length,
    handSize: player.hand.length,
  });

  const released = releaseTableCards(ctx, player);
  cancelPendingsInvolving(ctx, player.id, "player_eliminated");
  dropCouncilObligations(ctx, player.id);

  const claimant = options.allowInheritance
    ? ctx.players.find(
        (p) => isInPlay(p) && inheritanceForColor(ctx, p, player.color) !== null,
      )
    : undefined;

  if (claimant && player.hand.length > 0) {
    openInheritance(ctx, {
      eliminatedPlayerId: player.id,
      color: player.color,
      hand: player.hand,
      // The window closes in a later dispatch, so what left the table now — and the trigger
      // label this elimination carries — have to travel with it.
      ...released,
      deferredTrigger: trigger,
    });
  } else {
    discardEliminatedHand(
      ctx,
      player,
      released.voteCardsReturned,
      released.grantedVotesDiscarded,
    );
  }

  afterPlayerCountChanged(ctx, trigger);
}

/** What `releaseTableCards` actually took back, for the elimination report. */
interface ReleasedTableCards {
  readonly voteCardsReturned: number;
  readonly grantedVotesDiscarded: number;
}

/** Vote Cards, granted votes and any Camp Raid marker leave with the player. */
function releaseTableCards(ctx: Ctx, player: DraftPlayer): ReleasedTableCards {
  const voteCardsReturned = returnVoteCardsToBank(ctx, player);
  const grantedVotesDiscarded = player.grantedVotes.length;
  for (const uid of [...player.grantedVotes]) {
    discardCard(ctx, uid, "elimination", { playerId: player.id });
  }
  if (player.campRaid) {
    const marker = player.campRaid;
    player.campRaid = null;
    discardCard(ctx, marker.cardUid, "elimination", { playerId: marker.raiderId });
  }
  // A Camp Raid this player placed on somebody else also dies with them: the raider can no
  // longer take anything.
  for (const other of ctx.players) {
    if (other.campRaid && other.campRaid.raiderId === player.id) {
      const marker = other.campRaid;
      other.campRaid = null;
      discardCard(ctx, marker.cardUid, "elimination", { playerId: player.id });
    }
  }
  return { voteCardsReturned, grantedVotesDiscarded };
}

/** So `finish_voting` can still close: audit #23, a dead player's obligation wedged the vote. */
function dropCouncilObligations(ctx: Ctx, playerId: PlayerId): void {
  const council = councilOf(ctx.stage);
  if (!council) return;
  patchCouncil(ctx, {
    requiredCasts: council.requiredCasts.filter((c) => c.playerId !== playerId),
    finishedVoting: council.finishedVoting.filter((id) => id !== playerId),
  });
}

export function discardEliminatedHand(
  ctx: Ctx,
  player: DraftPlayer,
  voteCardsReturned: number,
  grantedVotesDiscarded: number,
): void {
  const cards: CardInstance[] = player.hand.map((uid) => requireCard(ctx, uid));
  for (const uid of [...player.hand]) {
    discardCard(ctx, uid, "elimination", { playerId: player.id });
  }
  emitPublic(ctx, {
    type: "hand_discarded_on_elimination",
    playerId: player.id,
    cards,
    voteCardsReturned,
    grantedVotesDiscarded,
  });
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

/** "You get all of the cards in their hand instead of their cards going in the Discard Pile." */
export function claimInheritance(
  ctx: Ctx,
  pending: PendingInheritance,
  claimantId: PlayerId,
  inheritanceCardUid: CardUid,
): void {
  prunePending(ctx, pending.id);
  const claimant = findPlayer(ctx, claimantId);
  const dead = findPlayer(ctx, pending.eliminatedPlayerId);
  if (!claimant || !dead) return;

  emitPublic(ctx, {
    type: "card_played",
    playerId: claimantId,
    cardUid: inheritanceCardUid,
    kind: requireCard(ctx, inheritanceCardUid).kind,
    consumedTurnPlay: false,
  });
  discardCard(ctx, inheritanceCardUid, "played", { playerId: claimantId });

  // The snapshot is what transfers: a late claim cannot take cards that moved since.
  const taken = pending.hand.filter((uid) => dead.hand.includes(uid));
  for (const uid of taken) {
    const at = dead.hand.indexOf(uid);
    if (at >= 0) dead.hand.splice(at, 1);
    claimant.hand.push(uid);
  }
  emitPublic(ctx, {
    type: "inheritance_claimed",
    pendingId: pending.id,
    claimantId,
    eliminatedPlayerId: dead.id,
    cardUid: inheritanceCardUid,
    cardCount: taken.length,
  });
  emitTo(
    ctx,
    {
      type: "take_resolved",
      pendingId: pending.id,
      takerId: claimantId,
      victimId: dead.id,
      cardUids: taken,
      kinds: kindsOf(ctx, taken),
    },
    claimantId,
  );
  // Anything that moved out of the snapshot in the meantime still has to leave the table.
  if (dead.hand.length > 0) {
    discardEliminatedHand(
      ctx,
      dead,
      pending.voteCardsReturned,
      pending.grantedVotesDiscarded,
    );
  }
  // The elimination that opened this window may have been the one that left two players. The
  // endgame check was deferred until now precisely so the claim could land first — a hand
  // inherited a moment before the Final Tribal Council is evidence a finalist may reveal.
  afterPlayerCountChanged(ctx, pending.deferredTrigger);
}

/** Nobody claimed it: the hand goes face up on the Discard Pile. */
export function forfeitInheritance(
  ctx: Ctx,
  pending: PendingInheritance,
  expired: boolean,
): void {
  if (expired) expirePending(ctx, pending, "inheritance_forfeited");
  else prunePending(ctx, pending.id);
  const dead = findPlayer(ctx, pending.eliminatedPlayerId);
  if (dead) {
    discardEliminatedHand(
      ctx,
      dead,
      pending.voteCardsReturned,
      pending.grantedVotesDiscarded,
    );
  }
  afterPlayerCountChanged(ctx, pending.deferredTrigger);
}

// ---------------------------------------------------------------------------
// Leaving the table
// ---------------------------------------------------------------------------

/**
 * `leave_game` or a host `remove_player`, mid-game.
 *
 * Distinct from elimination in exactly one way that matters: a departed player is on NO jury.
 * `players` is never spliced — that would break seat ordering, elimination ordering and every
 * PlayerId reference held in council votes, idol plays, camp raid markers and open pendings
 * (audit #24).
 */
export function depart(
  ctx: Ctx,
  player: DraftPlayer,
  trigger: FinalCouncilTrigger,
): void {
  if (player.leftAtSeq !== null) return;
  player.leftAtSeq = stamp(ctx);
  const released = releaseTableCards(ctx, player);
  if (player.hand.length > 0) {
    discardEliminatedHand(
      ctx,
      player,
      released.voteCardsReturned,
      released.grantedVotesDiscarded,
    );
  }
  cancelPendingsInvolving(ctx, player.id, "player_eliminated");
  dropCouncilObligations(ctx, player.id);
  afterPlayerCountChanged(ctx, trigger);
}

// ---------------------------------------------------------------------------
// THE trigger
// ---------------------------------------------------------------------------

/**
 * The single predicate. Called after every flip, every elimination, every departure and every
 * draw that could change who is in play.
 */
export function afterPlayerCountChanged(ctx: Ctx, trigger: FinalCouncilTrigger): void {
  const stage = ctx.stage;
  if (stage.kind === "lobby" || stage.kind === "finished" || stage.kind === "abandoned")
    return;
  if (stage.kind === "final_council") return;

  const alive = playersInPlay(ctx);
  if (alive.length > 2) return;

  // "You can IMMEDIATELY play this card" — an Inheritance claim is a reaction to the very
  // elimination that may have ended the game, so the endgame waits for the window to close.
  // Re-entered from `claimInheritance` / `forfeitInheritance`.
  if (ctx.pending.some((p) => p.kind === "inheritance")) return;

  if (alive.length <= 1) {
    // A double elimination can only get here if something went wrong upstream (the engine flips
    // one at a time and re-checks), but a departure genuinely can: two players quit at once.
    finishGame(ctx, alive[0]?.id ?? null, alive.length === 1 ? "sole_survivor" : null);
    return;
  }

  const jury = jurors(ctx);
  if (jury.length === 0) {
    // No Jury means no Final Tribal Council Leader and nobody to vote — the route that gets here
    // is a 3-player game losing someone before anyone was ever voted out. The player holding
    // more Survivor Character Cards wins outright; level, and the game ends with no winner.
    // This is the invariant that keeps `FinalCouncilState.leaderId` non-nullable.
    const [a, b] = alive;
    if (!a || !b) return;
    const diff = charactersRemaining(a) - charactersRemaining(b);
    if (diff === 0) finishGame(ctx, null, null);
    else finishGame(ctx, diff > 0 ? a.id : b.id, "sole_survivor");
    return;
  }

  startFinalCouncil(ctx, alive, jury, trigger);
}

function startFinalCouncil(
  ctx: Ctx,
  alive: readonly DraftPlayer[],
  jury: readonly DraftPlayer[],
  trigger: FinalCouncilTrigger,
): void {
  const [a, b] = alive;
  if (!a || !b) return;

  // Any council in progress is over. Its cards still have to leave the table so the census
  // balances, and a dead inheritance window still has to put its hand somewhere.
  for (const pending of [...ctx.pending]) {
    if (pending.kind === "inheritance") forfeitInheritance(ctx, pending, false);
  }
  const council = councilOf(ctx.stage);
  if (council) {
    sweepCouncilCards(ctx, council);
    redistributeVoteCards(ctx, council.id);
    emitPublic(ctx, {
      type: "council_ended",
      councilId: council.id,
      eliminatedIds: ctx.players
        .filter((p) => council.flippedThisCouncil.includes(p.id) && !isInPlay(p))
        .map((p) => p.id),
      flippedIds: [...council.flippedThisCouncil],
      nextPlayerId: null,
      nextTurnFromOverride: false,
    });
  }
  cancelAllPendings(ctx, "game_ended");

  // "The player most recently eliminated is a member of the Jury AND the Final Tribal Council
  // Leader." `jurors()` is ordered by eliminatedAtSeq, so the Leader is the last entry.
  const leader = jury[jury.length - 1];
  if (!leader) return;

  const finalCouncil: FinalCouncilState = {
    phase: "opening",
    leaderId: leader.id,
    finalists: [a.id, b.id],
    jury: jury.map((p) => p.id),
    readyJurors: [],
    juryVotes: [],
    revealedHands: [],
    winnerId: null,
    winnerDecidedByLeaderTieBreak: false,
    phaseEnteredAtMs: ctx.nowMs,
    phaseDeadlineMs: ctx.nowMs + ctx.config.timings.finalCouncilPhaseSafetyTimeout,
  };
  ctx.stage = { kind: "final_council", finalCouncil };
  emitPublic(ctx, {
    type: "final_council_started",
    leaderId: finalCouncil.leaderId,
    finalists: finalCouncil.finalists,
    juryIds: finalCouncil.jury,
    trigger,
  });
}

// ---------------------------------------------------------------------------
// Ending the game
// ---------------------------------------------------------------------------

export function finishGame(
  ctx: Ctx,
  winnerId: PlayerId | null,
  method: "jury_majority" | "leader_tie_break" | "sole_survivor" | null,
  votes?: { readonly votes: number; readonly juryCount: number },
): void {
  const council = councilOf(ctx.stage);
  if (council) sweepCouncilCards(ctx, council);
  cancelAllPendings(ctx, "game_ended");
  if (winnerId && method) {
    emitPublic(ctx, {
      type: "winner_declared",
      winnerId,
      method,
      ...(votes ? { votes: votes.votes, juryCount: votes.juryCount } : {}),
    });
  }
  ctx.stage = { kind: "finished", winnerId, finishedAtMs: ctx.nowMs };
  emitPublic(ctx, { type: "game_finished", winnerId });
}

// ---------------------------------------------------------------------------
// The Final Tribal Council state machine
// ---------------------------------------------------------------------------

const FINAL_PHASE_AFTER: Readonly<Record<FinalCouncilPhase, FinalCouncilPhase | null>> =
  {
    opening: "statements",
    statements: "jury_questions",
    jury_questions: "jury_vote",
    jury_vote: null,
    tie_break: null,
    complete: null,
  };

export function nextFinalPhase(phase: FinalCouncilPhase): FinalCouncilPhase | null {
  return FINAL_PHASE_AFTER[phase];
}

export function enterFinalPhase(ctx: Ctx, to: FinalCouncilPhase): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final) return;
  const deadlineMs =
    to === "complete"
      ? null
      : ctx.nowMs +
        (to === "jury_vote"
          ? ctx.config.timings.juryVoteSafetyTimeout
          : ctx.config.timings.finalCouncilPhaseSafetyTimeout);
  patchFinalCouncil(ctx, {
    phase: to,
    phaseEnteredAtMs: ctx.nowMs,
    phaseDeadlineMs: deadlineMs,
  });
  emitPublic(ctx, {
    type: "final_council_phase_changed",
    from: final.phase,
    to,
    deadlineMs,
  });
}

export function revealFinalistHand(ctx: Ctx, playerId: PlayerId): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final) return;
  const player = findPlayer(ctx, playerId);
  if (!player) return;
  const cards = player.hand.map((uid) => requireCard(ctx, uid));
  patchFinalCouncil(ctx, { revealedHands: [...final.revealedHands, playerId] });
  // "They can't play any cards, but they can reveal their hands as evidence." The evidence is
  // FOR the Jury, so the record has to name the jury as its viewers — a reveal whose viewer is
  // its own owner is invisible to everyone through `PrivateView.revealedToMe`, leaving the
  // hand reachable only from the transient event (the state-that-evaporates family, #27/#59).
  const atSeq = stamp(ctx);
  for (const viewer of ctx.players) {
    if (viewer.id === playerId) continue;
    ctx.reveals.push({
      ownerId: playerId,
      viewerId: viewer.id,
      cardUids: [...player.hand],
      atSeq,
      reason: "finalist_reveal",
    });
  }
  emitPublic(ctx, { type: "finalist_hand_revealed", playerId, cards });
}

export function markJurorReady(ctx: Ctx, jurorId: PlayerId): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final) return;
  // One finger per juror. Without the dedupe one juror pressing twice reaches the threshold.
  const readyJurors = final.readyJurors.includes(jurorId)
    ? final.readyJurors
    : [...final.readyJurors, jurorId];
  patchFinalCouncil(ctx, { readyJurors });
  emitPublic(ctx, {
    type: "juror_ready",
    jurorId,
    readyCount: readyJurors.length,
    juryCount: final.jury.length,
  });
  // "When every member of the Jury has a finger in the air, the Final Tribal Council Leader will
  // say: 'The winner of Survivor is…3…2…1…'" — the ready-check OPENS the vote and can only ever
  // move the council FORWARD. A late finger raised during the tie-break used to push the state
  // machine backwards into `jury_vote`, destroying the Leader's tie-break prompt with every
  // vote already cast, so nothing at all was on offer until the jury-vote backstop fired.
  if (
    readyJurors.length >= final.jury.length &&
    !finalPhaseAtOrAfter(final.phase, "jury_vote")
  ) {
    enterFinalPhase(ctx, "jury_vote");
  }
}

export function castJuryVote(ctx: Ctx, jurorId: PlayerId, finalistId: PlayerId): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final) return;
  const vote: JuryVote = { jurorId, finalistId, atSeq: stamp(ctx) };
  const juryVotes = [...final.juryVotes, vote];
  patchFinalCouncil(ctx, { juryVotes });
  emitTo(ctx, { type: "jury_vote_cast", jurorId, finalistId }, jurorId);
  emitPublic(ctx, {
    type: "jury_vote_registered",
    jurorId,
    castCount: juryVotes.length,
    juryCount: final.jury.length,
  });
  if (juryVotes.length >= final.jury.length) revealJuryVotes(ctx);
}

/** The "3… 2… 1…": every jury vote becomes public in one event, and the game ends. */
export function revealJuryVotes(ctx: Ctx): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final) return;
  const [a, b] = final.finalists;
  const votesFor = (id: PlayerId): number =>
    final.juryVotes.filter((v) => v.finalistId === id).length;
  const aVotes = votesFor(a);
  const bVotes = votesFor(b);

  emitPublic(ctx, {
    type: "jury_votes_revealed",
    votes: [...final.juryVotes],
    tallies: [
      { finalistId: a, votes: aVotes },
      { finalistId: b, votes: bVotes },
    ],
  });

  if (aVotes === bVotes) {
    // "If both players in the final two get the same number of votes, the Final Tribal Council
    // Leader breaks the tie by choosing the winner."
    enterFinalPhase(ctx, "tie_break");
    emitPublic(ctx, {
      type: "final_tie_break_required",
      leaderId: final.leaderId,
      finalists: final.finalists,
      deadlineMs: ctx.nowMs + ctx.config.timings.finalCouncilPhaseSafetyTimeout,
    });
    return;
  }

  const winnerId = aVotes > bVotes ? a : b;
  completeFinalCouncil(ctx, winnerId, false, {
    votes: Math.max(aVotes, bVotes),
    juryCount: final.jury.length,
  });
}

export function completeFinalCouncil(
  ctx: Ctx,
  winnerId: PlayerId,
  byLeaderTieBreak: boolean,
  votes: { readonly votes: number; readonly juryCount: number },
): void {
  patchFinalCouncil(ctx, { winnerId, winnerDecidedByLeaderTieBreak: byLeaderTieBreak });
  enterFinalPhase(ctx, "complete");
  finishGame(
    ctx,
    winnerId,
    byLeaderTieBreak ? "leader_tie_break" : "jury_majority",
    votes,
  );
}

/**
 * The tie-break backstop.
 *
 * `tie_break` has no successor phase, so an expired deadline used to do literally nothing: every
 * later `tick` reported no change while `nextDeadline()` kept naming the same past timestamp, so
 * an absent Leader wedged the game forever and a caller scheduling against `nextDeadline()` spun
 * on it. "The Final Tribal Council Leader breaks the tie by choosing the winner. They DON'T have
 * to pick the player they originally voted for" — so with the Leader gone, the vote they DID
 * cast is their standing choice, and a Leader who never voted falls back to the same
 * Survivor-Character-Card count an empty jury would have used.
 */
export function forceTieBreak(ctx: Ctx): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final || final.phase !== "tie_break") return;
  const own =
    final.juryVotes.find((v) => v.jurorId === final.leaderId)?.finalistId ?? null;
  if (own && final.finalists.includes(own)) {
    completeFinalCouncil(ctx, own, true, {
      votes: final.juryVotes.filter((v) => v.finalistId === own).length,
      juryCount: final.jury.length,
    });
    return;
  }
  const [a, b] = final.finalists;
  const pa = findPlayer(ctx, a);
  const pb = findPlayer(ctx, b);
  const diff = (pa ? charactersRemaining(pa) : 0) - (pb ? charactersRemaining(pb) : 0);
  if (diff === 0) finishGame(ctx, null, null);
  else finishGame(ctx, diff > 0 ? a : b, "sole_survivor");
}

/** Force the endgame along when the jury-vote backstop expires: absent jurors simply abstain. */
export function forceJuryVoteClose(ctx: Ctx): void {
  const final = finalCouncilOf(ctx.stage);
  if (!final) return;
  if (final.juryVotes.length === 0) {
    // Nobody voted at all. Fall back to the same rule an empty jury would have used.
    const [a, b] = final.finalists;
    const pa = findPlayer(ctx, a);
    const pb = findPlayer(ctx, b);
    const diff =
      (pa ? charactersRemaining(pa) : 0) - (pb ? charactersRemaining(pb) : 0);
    if (diff === 0) finishGame(ctx, null, null);
    else finishGame(ctx, diff > 0 ? a : b, "sole_survivor");
    return;
  }
  revealJuryVotes(ctx);
}
