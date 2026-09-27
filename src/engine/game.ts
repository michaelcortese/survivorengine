/**
 * The Game aggregate: the reducer, the turn state machine, and the `Game` facade.
 *
 * `reduce(state, action, nowMs) -> Result<DispatchOutcome>` is the primary API and everything
 * else here is a thin wrapper over it. Three properties hold by construction:
 *
 *  1. VALIDATION NEVER MUTATES. Every handler validates before it touches the draft, and the
 *     draft is a deep copy anyway — a rejected action returns the caller's own state object,
 *     untouched. Audit #49: the old `checkForError()` destroyed a card on every rejection.
 *  2. TURN ORDER IS ENFORCED CENTRALLY. `requireTurn` checks the actor and the phase in one
 *     place, so a command cannot forget to (audit #22/#99: turn ownership was enforced in 1
 *     command out of 26), and eliminated or departed players are refused everywhere.
 *  3. THE ENGINE HAS NO CLOCK. Deadlines are absolute timestamps in state; `tick(nowMs)` is the
 *     only time-driven entry point, and it takes the time from its caller.
 *
 * The three-step turn — "Remember: Steal, Play (or don't), then Draw!" — is the shape of the
 * machine rather than a rule written down somewhere: `play` is unreachable until the steal
 * window closes, `draw` is unreachable until the play step is spent or skipped, and `draw` is
 * the only edge out of the turn. Drawing cannot fail, even on an empty pile, because a refused
 * draw wedges the game permanently (audit #20).
 */

import type { EngineConfig } from "../config.js";
import { colorOf, getCard, nameableKinds } from "./cards.js";
import { castawayKey, dealCastaways, isValidCastawayName } from "./castaways.js";
import {
  auditCensus,
  discardCard,
  giveCardTo,
  handHas,
  inheritanceForColor,
  isCouncilCardKind,
  kindOf,
  kindsOf,
  lookupCard,
  moveToZone,
  requireCard,
} from "./card.js";
import {
  resolveChallenge,
  startChallenge,
  submissionIsLegal,
  submitToChallenge,
} from "./challenges.js";
import { drawTop, setupDeck } from "./deck.js";
import {
  createCtx,
  emitPublic,
  emitTo,
  finalize,
  newEffectId,
  patchTurn,
  stamp,
  type Ctx,
  type DraftPlayer,
} from "./draft.js";
import {
  afterPlayerCountChanged,
  claimInheritance,
  completeFinalCouncil,
  castJuryVote,
  depart,
  enterFinalPhase,
  finishGame,
  flipCharacterCard,
  forceJuryVoteClose,
  forceTieBreak,
  forfeitInheritance,
  juryCountFor,
  markJurorReady,
  nextFinalPhase,
  revealFinalistHand,
} from "./final.js";
import {
  applyDiscardChoice,
  autoResolveDiscard,
  blockTake,
  cancelAllPendings,
  expirePending,
  findPending,
  hasOpenPendings,
  openAllianceTarget,
  openCardChoice,
  openTake,
  pendingCount,
  prunePending,
  resolveTake,
  updatePending,
  waitingOn,
  type TakeResult,
} from "./pending.js";
import {
  asPlayerCount,
  beginTurn,
  charactersRemaining,
  createPlayer,
  findPlayer,
  firstFreeColor,
  handOffTurn,
  isColorTaken,
  nextHostFromSeat,
  nextInPlayFromSeat,
  playersInPlay,
  stealTargets,
} from "./player.js";
import { createRng } from "./rng.js";
import { createSnapshot } from "./snapshot.js";
import {
  advanceCouncilPhase,
  forfeitOutstandingVotes,
  applyLeaderDecision,
  applyVoteCardTaken,
  castVote,
  finishVoting,
  leaderAdvanceableFrom,
  outstandingCasts,
  playControlTheVote,
  playGoodwillGamble,
  playIdolNullifier,
  playImTheLeaderNow,
  playImmunityIdol,
  resolveEliminations,
  startCouncil,
} from "./tribal.js";
import type { GameEvent } from "./events.js";
import {
  ALL_PLAYER_COLORS,
  CardKind,
  VOTES_PUBLIC_FROM,
  assertNever,
  councilOf,
  councilPhaseAtOrAfter,
  err,
  finalCouncilOf,
  finalPhaseAtOrAfter,
  isInPlay,
  ok,
  statusOf,
  turnOf,
  winnerIdOf,
  type Action,
  type ActionKind,
  type CardInstance,
  type CardUid,
  type CouncilView,
  type CreateGameParams,
  type DeadlineInfo,
  type DispatchOutcome,
  type FinalCouncilView,
  type Game,
  type GameSnapshot,
  type GameStage,
  type GameState,
  type GameView,
  type LegalAction,
  type Pending,
  type PendingCardChoice,
  type PendingTake,
  type PendingView,
  type PlayerId,
  type PrivateView,
  type PublicPlayerView,
  type Result,
  type TurnPhase,
  type VoteSource,
} from "./types.js";

const OK: Result<void> = ok<void>(undefined);

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

function requireLobby(ctx: Ctx): Result<void> {
  switch (ctx.stage.kind) {
    case "lobby":
      return OK;
    case "turn":
    case "council":
    case "final_council":
      return err("game_already_started", "the game is already under way");
    case "finished":
      return err("game_finished", "this game has finished");
    case "abandoned":
      return err("game_abandoned", "this game was abandoned");
    default:
      return assertNever(ctx.stage, "requireLobby");
  }
}

function requireActive(ctx: Ctx): Result<void> {
  switch (ctx.stage.kind) {
    case "turn":
    case "council":
    case "final_council":
      return OK;
    case "lobby":
      return err("game_not_started", "the game has not started yet");
    case "finished":
      return err("game_finished", "this game has finished");
    case "abandoned":
      return err("game_abandoned", "this game was abandoned");
    default:
      return assertNever(ctx.stage, "requireActive");
  }
}

/** The actor must be seated, alive and present. Every action goes through here. */
function requireActor(ctx: Ctx, id: PlayerId): Result<DraftPlayer> {
  const player = findPlayer(ctx, id);
  if (!player) return err("not_in_game", `${id} is not in this game`);
  if (player.leftAtSeq !== null)
    return err("player_left_game", `${id} has left the game`);
  if (player.eliminatedAtSeq !== null)
    return err("player_eliminated", `${id} has been voted out`);
  return ok(player);
}

/** A target that must still be at the table. Eliminated players cannot be acted on (#7). */
function requireTarget(
  ctx: Ctx,
  actor: PlayerId,
  target: PlayerId,
  allowSelf: boolean,
): Result<DraftPlayer> {
  if (!allowSelf && target === actor)
    return err("self_target_not_allowed", "you cannot target yourself with this");
  const player = findPlayer(ctx, target);
  if (!player) return err("target_not_in_game", `${target} is not in this game`);
  if (!isInPlay(player)) return err("invalid_target", `${target} is no longer in play`);
  return ok(player);
}

/** A turn steal has been declared and its take window is still open. */
const stealIsBeingAnswered = (ctx: Ctx): boolean =>
  ctx.pending.some((p) => p.kind === "take" && p.origin.kind === "turn_steal");

function requireTurn(ctx: Ctx, actor: PlayerId, phase: TurnPhase): Result<DraftPlayer> {
  const active = requireActive(ctx);
  if (!active.ok) return active;
  // Standing before position: a player who has been voted out or has left the table should be
  // told THAT, not "it is not your turn" — which is true but useless (invariant: eliminated and
  // departed players cannot act, and the renderer needs to say why).
  const player = requireActor(ctx, actor);
  if (!player.ok) return player;
  const turn = turnOf(ctx.stage);
  if (!turn) return err("wrong_turn_phase", "no turn is in progress");
  if (ctx.stage.kind === "council")
    return err("wrong_turn_phase", "a Tribal Council is in progress");
  if (turn.playerId !== actor) return err("not_your_turn", "it is not your turn");
  if (turn.phase !== phase) {
    // The dedicated codes exist so the renderer can say "steal first" — or, once the steal is
    // declared and only its Sorry For You window is still open, "wait for it to land" — rather
    // than "wrong phase". Telling a thief to steal first, twenty seconds after they stole, reads
    // as the bot having lost their move.
    if (phase !== "steal" && turn.phase === "steal")
      return stealIsBeingAnswered(ctx)
        ? err(
            "steal_being_answered",
            "your steal is waiting on its Sorry For You window",
          )
        : err("steal_step_not_done", "you must steal a card first");
    return err(
      "wrong_turn_phase",
      `this belongs to the ${phase} step, not ${turn.phase}`,
    );
  }
  return player;
}

/**
 * The one authorization check in the engine, against the one field that holds an authorization.
 *
 * There is deliberately no second list to consult. `coHostIds` used to sit beside `hostId`
 * here, checked on every host-gated action and populated by nothing at all — an authorization
 * list that could only ever answer "no" is the shape of audit #24, not a fix for it. The two
 * legitimate ways to be the host are to be given the role (`transfer_host`, or the automatic
 * pass-on when the host leaves) and, for `abandon_game` only, to be a guild moderator the
 * Discord layer vouches for with `viaModerator`.
 */
function requireHost(ctx: Ctx, actor: PlayerId): Result<void> {
  if (actor === ctx.hostId) return OK;
  return err("not_host", "only the host can do that");
}

function requireCardInHand(
  ctx: Ctx,
  player: DraftPlayer,
  cardUid: CardUid,
  kind: CardKind,
): Result<void> {
  if (!lookupCard(ctx, cardUid)) return err("card_not_in_hand", "no such card");
  if (!handHas(player, cardUid))
    return err("card_not_in_hand", "that card is not in your hand");
  if (kindOf(ctx, cardUid) !== kind)
    return err("wrong_card_kind", `that card is not a ${getCard(kind).name}`);
  return OK;
}

/** Step 2 is optional and happens at most once: "you can't play more than one". */
function requirePlayStep(
  ctx: Ctx,
  actor: PlayerId,
  cardUid: CardUid,
  kind: CardKind,
): Result<DraftPlayer> {
  const player = requireTurn(ctx, actor, "play");
  if (!player.ok) return player;
  const turn = turnOf(ctx.stage);
  if (turn?.cardPlayedThisTurn)
    return err(
      "card_already_played_this_turn",
      "you have already played a card this turn",
    );
  const inHand = requireCardInHand(ctx, player.value, cardUid, kind);
  if (!inHand.ok) return inHand;
  return player;
}

// ---------------------------------------------------------------------------
// Turn plumbing
// ---------------------------------------------------------------------------

function setTurnPhase(ctx: Ctx, to: TurnPhase): void {
  const turn = turnOf(ctx.stage);
  if (!turn || turn.phase === to) return;
  patchTurn(ctx, { phase: to });
  emitPublic(ctx, {
    type: "turn_phase_changed",
    playerId: turn.playerId,
    from: turn.phase,
    to,
  });
}

/** Place a played card face up and spend the turn's single play. */
function spendCardPlay(
  ctx: Ctx,
  player: DraftPlayer,
  cardUid: CardUid,
  keepOnTable: boolean,
): void {
  const kind = kindOf(ctx, cardUid);
  emitPublic(ctx, {
    type: "card_played",
    playerId: player.id,
    cardUid,
    kind,
    consumedTurnPlay: true,
  });
  patchTurn(ctx, { cardPlayedThisTurn: cardUid });
  // Camp Raid is the one turn-step card that does not go straight to the Discard Pile: it sits
  // face up in front of its victim until their next draw.
  if (keepOnTable) moveToZone(ctx, cardUid, "inPlay");
  else discardCard(ctx, cardUid, "played", { playerId: player.id });
}

/** The one thing `afterMutation` throws. Named so the two entry points can catch only it. */
class CascadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeError";
  }
}

/**
 * Advance whatever the last mutation unblocked.
 *
 * One place, run after every action and every tick, rather than a "and now remember to advance
 * the phase" at each of thirty call sites. Progress is detected by whether anything was emitted,
 * because every state mutation in this engine emits an event.
 */
function afterMutation(ctx: Ctx): void {
  const limit = ctx.config.limits.maxCascadeSteps;
  for (let guard = 0; guard < limit; guard += 1) {
    const before = ctx.events.length;
    stepForward(ctx);
    // Nothing was emitted, so nothing moved: the fixpoint is reached and we are done.
    if (ctx.events.length === before) return;
  }
  // Falling out of the loop is NOT the same thing, and it used to be indistinguishable from it.
  // `stepForward` is what moves steal -> play -> draw and tally -> eliminations, so a run that
  // needs one more step than the bound left the game half-advanced while `dispatch()` reported
  // a clean `changed: true`, the snapshot was written, the timer was re-armed against a
  // `nextDeadline()` that no longer matched any open window, and not one line of log said the
  // engine had given up. Both entry points below catch this and commit NOTHING (audit #49), so
  // the failure surfaces as a refusal rather than as a silently truncated game.
  throw new CascadeError(
    `afterMutation did not converge in ${String(limit)} steps (stage=${ctx.stage.kind}, events=${String(ctx.events.length)})`,
  );
}

function stepForward(ctx: Ctx): void {
  const stage = ctx.stage;
  if (stage.kind === "council") {
    const phase = stage.council.phase;
    if ((phase === "tally" || phase === "tie_break") && !hasOpenPendings(ctx)) {
      resolveEliminations(ctx);
    }
    return;
  }
  if (stage.kind !== "turn") return;
  const turn = stage.turn;
  if (turn.phase === "steal" && turn.stealResolved) {
    setTurnPhase(ctx, "play");
    return;
  }
  if (
    turn.phase === "play" &&
    turn.cardPlayedThisTurn !== null &&
    !hasOpenPendings(ctx)
  ) {
    setTurnPhase(ctx, "draw");
    return;
  }
  if (turn.phase === "ended" && !hasOpenPendings(ctx)) {
    const player = findPlayer(ctx, turn.playerId);
    const next = player
      ? nextInPlayFromSeat(ctx, player.seat)
      : (playersInPlay(ctx)[0] ?? null);
    handOffTurn(ctx, turn, next);
  }
}

// ---------------------------------------------------------------------------
// Draw and draw-pile exhaustion
// ---------------------------------------------------------------------------

function doDraw(ctx: Ctx, player: DraftPlayer): void {
  const uid = drawTop(ctx);
  if (!uid) {
    patchTurn(ctx, { phase: "ended" });
    applyExhaustionPolicy(ctx);
    return;
  }
  giveCardTo(ctx, player, uid);
  // Private to the drawer: the table sees the pile count in `turn_ended`. Camp Raid's victim
  // still looks at the card before losing it — "but only after they look at it".
  emitTo(
    ctx,
    { type: "card_drawn", playerId: player.id, cardUid: uid, kind: kindOf(ctx, uid) },
    player.id,
  );
  patchTurn(ctx, { phase: "ended" });

  const marker = player.campRaid;
  const drewCouncil = isCouncilCardKind(kindOf(ctx, uid));

  if (marker) {
    const takesCouncilCard = ctx.config.houseRules.campRaidTakesTribalCouncilCard;
    if (drewCouncil && !takesCouncilCard) {
      // "no matter what it is" versus "place it face up in front of YOU immediately" — the one
      // genuinely contradictory pair of rules in the game. This branch takes the rulebook's side.
      player.campRaid = null;
      emitPublic(ctx, {
        type: "house_rule_applied",
        rule: "campRaidTakesTribalCouncilCard",
        setting: false,
        affectedPlayerIds: [marker.raiderId, player.id],
      });
      discardCard(ctx, marker.cardUid, "played", { playerId: marker.raiderId });
      startCouncil(ctx, uid, player.id, player.id);
      return;
    }
    player.campRaid = null;
    if (ctx.config.houseRules.sorryForYouBlocksCampRaid) {
      openTake(ctx, {
        origin: {
          kind: "camp_raid",
          effectId: newEffectId(ctx),
          cardUid: marker.cardUid,
        },
        takerIds: [marker.raiderId],
        victimId: player.id,
        spec: { kind: "specific", cardUids: [uid] },
      });
      return;
    }
    // The same constructor the other branch of this `if` calls eleven lines up, with the one
    // difference the house rule actually needs: the window is already closed, so nobody is
    // offered a Sorry For You and it resolves on the spot.
    const take = openTake(ctx, {
      origin: {
        kind: "camp_raid",
        effectId: newEffectId(ctx),
        cardUid: marker.cardUid,
      },
      takerIds: [marker.raiderId],
      victimId: player.id,
      spec: { kind: "specific", cardUids: [uid] },
      unreactable: true,
    });
    finishTakeResolved(ctx, take, resolveTake(ctx, take));
    return;
  }

  if (drewCouncil) startCouncil(ctx, uid, player.id, player.id);
}

/**
 * The draw pile is empty. The rulebook never covers this — setup guarantees the bottom card is a
 * Tribal Council card, so the last draw always fires a council, but nothing covers a council
 * that ENDS with three or more players alive. `houseRules.drawPileExhaustionPolicy` decides, and
 * says so with `house_rule_applied`.
 */
function applyExhaustionPolicy(ctx: Ctx): void {
  const policy = ctx.config.houseRules.drawPileExhaustionPolicy;
  const alive = playersInPlay(ctx);
  emitPublic(ctx, {
    type: "draw_pile_exhausted",
    policy,
    playersRemaining: alive.length,
  });
  emitPublic(ctx, {
    type: "house_rule_applied",
    rule: "drawPileExhaustionPolicy",
    setting: policy,
    affectedPlayerIds: alive.map((p) => p.id),
  });

  if (policy === "draw") {
    finishGame(ctx, null, null);
    return;
  }

  if (alive.length <= 2) {
    afterPlayerCountChanged(ctx, "draw_pile_empty");
    return;
  }

  // The two players holding the most Survivor Character Cards become the finalists; everyone
  // else is FULLY eliminated so they enter the Jury through the ordinary path, which is what
  // keeps the Final Council's Leader derivable from max(eliminatedAtSeq). Ties are broken by the
  // game RNG — shuffling first and then sorting by torches makes that deterministic per seed.
  const ranked = ctx.rng
    .shuffle(alive)
    .sort((a, b) => charactersRemaining(b) - charactersRemaining(a));
  const doomed = ranked.slice(2);
  const turn = turnOf(ctx.stage);
  const fromSeat = turn ? (findPlayer(ctx, turn.playerId)?.seat ?? 0) : 0;
  // Reverse turn order from the current player, so the elimination order — and therefore the
  // Final Tribal Council Leader — is a stated rule rather than an accident of array order.
  const ordered = [...doomed].sort(
    (a, b) =>
      ((b.seat - fromSeat + ctx.players.length) % ctx.players.length) -
      ((a.seat - fromSeat + ctx.players.length) % ctx.players.length),
  );
  for (const player of ordered) {
    while (charactersRemaining(player) > 0 && isInPlay(player)) {
      flipCharacterCard(
        ctx,
        player,
        0,
        { allowInheritance: false, councilId: null },
        "draw_pile_empty",
      );
    }
  }
  afterPlayerCountChanged(ctx, "draw_pile_empty");
}

// ---------------------------------------------------------------------------
// Take follow-ups
// ---------------------------------------------------------------------------

/** What happens once a take has actually moved its cards. Exhaustive over `TakeOrigin`. */
function finishTakeResolved(ctx: Ctx, take: PendingTake, result: TakeResult): void {
  const origin = take.origin;
  switch (origin.kind) {
    case "turn_steal":
      markStealResolved(ctx);
      return;
    case "spy_shack": {
      // The take was `chosen`, so nothing moved yet: now the spy looks and picks.
      const victim = findPlayer(ctx, take.victimId);
      const spy = take.takerIds[0];
      if (!spy || !victim) return;
      if (!ctx.config.houseRules.spyShackLookHappensBeforeBlock)
        revealHandTo(ctx, spy, victim);
      if (victim.hand.length === 0) return;
      openCardChoice(ctx, {
        chooserId: spy,
        fromPlayerId: victim.id,
        reason: "spy_shack_take",
        options: victim.hand,
      });
      return;
    }
    case "alliance": {
      // "You and your partner EACH steal 1 card from any other player (for a total of 2 cards
      // stolen)." With `houseRules.allianceStealIsRandom` OFF the take's spec is `chosen`, and
      // a chosen spec moves NOTHING at resolution time — it is documented to open its own
      // `card_choice` window once it has survived Sorry For You. Only `spy_shack` ever opened
      // one, so this case was a bare `return` and the strongest steal card in the game did
      // nothing at all: the card was discarded, the partner was picked, the victim was offered
      // a block, and then zero cards changed hands. A four-copy card, blanked by a setting the
      // config file offers operators by name.
      if (take.spec.kind !== "chosen") return;
      const victim = findPlayer(ctx, take.victimId);
      if (!victim) return;
      // One window per ally, because each of them steals one card. They are opened against the
      // victim's hand as it is NOW, so the second ally cannot pick a card the first just took.
      for (const takerId of take.takerIds) {
        const current = findPlayer(ctx, take.victimId);
        if (!current || current.hand.length === 0) return;
        openCardChoice(ctx, {
          chooserId: takerId,
          fromPlayerId: current.id,
          reason: "alliance_take",
          options: current.hand,
        });
      }
      return;
    }
    case "knowledge_is_power":
    case "challenge":
      return;
    case "control_the_vote": {
      const taker = take.takerIds[0];
      const moved = taker ? (result.moved.get(taker) ?? []) : [];
      const voteCardUid = moved[0];
      if (taker && voteCardUid)
        applyVoteCardTaken(ctx, taker, take.victimId, voteCardUid);
      return;
    }
    case "camp_raid": {
      const raiderId = take.takerIds[0];
      if (!raiderId) return;
      discardCard(ctx, origin.cardUid, "played", { playerId: raiderId });
      const takenUid = (result.moved.get(raiderId) ?? [])[0];
      if (!takenUid) return;
      const takenKind = kindOf(ctx, takenUid);
      const wasCouncil = isCouncilCardKind(takenKind);
      emitTo(
        ctx,
        {
          type: "camp_raid_resolved",
          raiderId,
          victimId: take.victimId,
          markerCardUid: origin.cardUid,
          takenCardUid: takenUid,
          takenCardKind: takenKind,
          wasTribalCouncilCard: wasCouncil,
        },
        raiderId,
        take.victimId,
      );
      if (wasCouncil) {
        emitPublic(ctx, {
          type: "house_rule_applied",
          rule: "campRaidTakesTribalCouncilCard",
          setting: true,
          affectedPlayerIds: [raiderId, take.victimId],
        });
        // The raider took the card, so the raider is the Leader — the drawer is still recorded
        // as the drawer, which is what `CouncilState.drawerId` is for.
        startCouncil(ctx, takenUid, take.victimId, raiderId);
      }
      return;
    }
    default:
      assertNever(origin, "finishTakeResolved");
  }
}

/** Step 1 is spent whether the cards moved or a Sorry For You blanked them. */
function markStealResolved(ctx: Ctx): void {
  if (turnOf(ctx.stage) === null) return;
  patchTurn(ctx, { stealResolved: true });
}

/** What happens once a Sorry For You has blanked a take. */
function finishTakeBlocked(ctx: Ctx, take: PendingTake): void {
  const origin = take.origin;
  switch (origin.kind) {
    case "turn_steal":
      // "It blocks the mandatory turn-start steal… the thief still had to declare the steal, so
      // their turn's steal step is spent."
      markStealResolved(ctx);
      return;
    case "camp_raid": {
      const raiderId = take.takerIds[0];
      if (raiderId) discardCard(ctx, origin.cardUid, "played", { playerId: raiderId });
      // The victim keeps the card they drew — including, if that is what it was, the Tribal
      // Council card that starts a council with them as Leader.
      const spec = take.spec;
      const drawnUid = spec.kind === "specific" ? spec.cardUids[0] : undefined;
      if (drawnUid && isCouncilCardKind(kindOf(ctx, drawnUid))) {
        startCouncil(ctx, drawnUid, take.victimId, take.victimId);
      }
      return;
    }
    case "spy_shack":
    case "knowledge_is_power":
    case "alliance":
    case "control_the_vote":
    case "challenge":
      return;
    default:
      assertNever(origin, "finishTakeBlocked");
  }
}

function revealHandTo(ctx: Ctx, viewerId: PlayerId, owner: DraftPlayer): void {
  const cards = owner.hand.map((uid) => requireCard(ctx, uid));
  ctx.reveals.push({
    ownerId: owner.id,
    viewerId,
    cardUids: [...owner.hand],
    atSeq: stamp(ctx),
    reason: "spy_shack",
  });
  emitTo(
    ctx,
    { type: "spy_shack_peeked", spyId: viewerId, targetId: owner.id, cards },
    viewerId,
  );
}

/** Is this origin blockable at all? Four of the seven are disclosed house rules. */
function sorryForYouApplies(ctx: Ctx, take: PendingTake): boolean {
  const rules = ctx.config.houseRules;
  switch (take.origin.kind) {
    case "turn_steal":
    case "alliance":
    case "challenge":
      return true;
    case "spy_shack":
      return rules.sorryForYouBlocksSpyShack;
    case "knowledge_is_power":
      return rules.sorryForYouBlocksKnowledgeIsPower;
    case "camp_raid":
      return rules.sorryForYouBlocksCampRaid;
    case "control_the_vote":
      return rules.sorryForYouBlocksControlTheVote;
    default:
      return assertNever(take.origin, "sorryForYouApplies");
  }
}

// ---------------------------------------------------------------------------
// Card-choice follow-ups
// ---------------------------------------------------------------------------

function applyCardChoice(
  ctx: Ctx,
  pending: PendingCardChoice,
  uid: CardUid,
  autoSelected: boolean,
): void {
  switch (pending.reason) {
    case "alliance_take": {
      prunePending(ctx, pending.id);
      const ally = findPlayer(ctx, pending.chooserId);
      const victim = findPlayer(ctx, pending.fromPlayerId);
      if (!ally || !victim) return;
      // Both allies pick from the victim's hand at the same moment, so the card this one
      // pointed at may already be in the other one's hand. "Allies cannot steal from each
      // other" — so never follow the card; take whatever is still there instead, exactly as
      // two hands reaching into the same fan of cards would. `rng.pick` keeps it seeded.
      const taken = victim.hand.includes(uid) ? uid : ctx.rng.pick(victim.hand);
      if (!taken) {
        // Public, like every other `take_found_nothing`: hand SIZES are public by rule, so the
        // table already knows there was nothing to take (audit #126).
        emitPublic(ctx, {
          type: "take_found_nothing",
          pendingId: pending.id,
          takerId: ally.id,
          victimId: victim.id,
        });
        return;
      }
      giveCardTo(ctx, ally, taken);
      emitTo(
        ctx,
        {
          type: "take_resolved",
          pendingId: pending.id,
          takerId: ally.id,
          victimId: victim.id,
          cardUids: [taken],
          kinds: kindsOf(ctx, [taken]),
        },
        ally.id,
        victim.id,
      );
      emitPublic(ctx, {
        type: "cards_transferred",
        fromId: victim.id,
        toId: ally.id,
        count: 1,
        fromHandSize: victim.hand.length,
        toHandSize: ally.hand.length,
      });
      if (autoSelected) {
        emitPublic(ctx, {
          type: "pending_expired",
          pendingId: pending.id,
          pendingKind: "card_choice",
          defaultApplied: "card_choice_auto_selected",
        });
      }
      return;
    }
    case "spy_shack_take": {
      prunePending(ctx, pending.id);
      const spy = findPlayer(ctx, pending.chooserId);
      const victim = findPlayer(ctx, pending.fromPlayerId);
      if (!spy || !victim) return;
      giveCardTo(ctx, spy, uid);
      emitTo(
        ctx,
        {
          type: "take_resolved",
          pendingId: pending.id,
          takerId: spy.id,
          victimId: victim.id,
          cardUids: [uid],
          kinds: kindsOf(ctx, [uid]),
        },
        spy.id,
        victim.id,
      );
      emitPublic(ctx, {
        type: "cards_transferred",
        fromId: victim.id,
        toId: spy.id,
        count: 1,
        fromHandSize: victim.hand.length,
        toHandSize: spy.hand.length,
      });
      if (autoSelected) {
        emitPublic(ctx, {
          type: "pending_expired",
          pendingId: pending.id,
          pendingKind: "card_choice",
          defaultApplied: "card_choice_auto_selected",
        });
      }
      return;
    }
    case "do_or_die_swap": {
      // Each side picks from their OWN hand and `fromPlayerId` is who receives it. The two
      // halves wait for each other so the exchange is simultaneous, exactly as at the table.
      updatePending(ctx, { ...pending, chosen: uid });
      const sibling = ctx.pending.find(
        (p): p is PendingCardChoice =>
          p.kind === "card_choice" &&
          p.reason === "do_or_die_swap" &&
          p.chooserId === pending.fromPlayerId &&
          p.fromPlayerId === pending.chooserId,
      );
      // Recording half a swap is a state change, so it emits — and the event that says "this
      // participant has chosen, and nobody may see what" is `challenge_submission_received`.
      // The Do or Die tie swap is the second half of a Reward Challenge and has exactly the
      // simultaneity property that event exists to describe. Without it the mutation would be
      // silent, `DispatchOutcome.changed` would be false for a real change (audit #60), and a
      // renderer would have nothing to redraw from.
      const half = sibling ? (sibling.chosen === null ? 1 : 2) : 2;
      emitPublic(ctx, {
        type: "challenge_submission_received",
        pendingId: pending.id,
        playerId: pending.chooserId,
        round: 1,
        submittedCount: half,
        participantCount: sibling ? 2 : 1,
      });
      if (sibling && sibling.chosen === null) return;
      completeSwap(ctx, { ...pending, chosen: uid }, sibling ?? null);
      return;
    }
    default:
      assertNever(pending.reason, "applyCardChoice");
  }
}

function completeSwap(
  ctx: Ctx,
  a: PendingCardChoice,
  b: PendingCardChoice | null,
): void {
  prunePending(ctx, a.id);
  if (b) prunePending(ctx, b.id);
  const aPlayer = findPlayer(ctx, a.chooserId);
  const bPlayer = findPlayer(ctx, a.fromPlayerId);
  if (!aPlayer || !bPlayer) return;
  const aGave = a.chosen;
  const bGave = b?.chosen ?? null;
  if (aGave) giveCardTo(ctx, bPlayer, aGave);
  if (bGave) giveCardTo(ctx, aPlayer, bGave);

  if (aGave && bGave) {
    emitTo(
      ctx,
      {
        type: "challenge_swap_completed",
        pendingId: a.id,
        aId: aPlayer.id,
        bId: bPlayer.id,
        aGaveCardUid: aGave,
        aGaveCardKind: kindOf(ctx, aGave),
        bGaveCardUid: bGave,
        bGaveCardKind: kindOf(ctx, bGave),
      },
      aPlayer.id,
      bPlayer.id,
    );
  }
  // One-sided swaps still have to be visible as a card movement.
  if (aGave) {
    emitPublic(ctx, {
      type: "cards_transferred",
      fromId: aPlayer.id,
      toId: bPlayer.id,
      count: 1,
      fromHandSize: aPlayer.hand.length,
      toHandSize: bPlayer.hand.length,
    });
  }
  if (bGave) {
    emitPublic(ctx, {
      type: "cards_transferred",
      fromId: bPlayer.id,
      toId: aPlayer.id,
      count: 1,
      fromHandSize: bPlayer.hand.length,
      toHandSize: aPlayer.hand.length,
    });
  }
}

// ---------------------------------------------------------------------------
// The action dispatcher
// ---------------------------------------------------------------------------

function applyAction(ctx: Ctx, action: Action): Result<void> {
  switch (action.type) {
    // --- lobby ------------------------------------------------------------
    case "join_game": {
      const lobby = requireLobby(ctx);
      if (!lobby.ok) return lobby;
      if (findPlayer(ctx, action.actor))
        return err("already_joined", "you are already in");
      if (ctx.players.length >= ctx.config.limits.maxPlayers)
        return err(
          "too_many_players",
          `this game seats ${ctx.config.limits.maxPlayers}`,
        );
      let color = action.color ?? null;
      // The colour arrives as a raw Discord option, exactly as a PlayerId does, and the engine
      // validates every PlayerId it is handed. A colour off the printed six has no Survivor
      // Character Cards behind it, so `setupDeck` would seat a player with ZERO lives who can
      // never be voted out — "There are exactly 2 per player, always."
      if (color && !ALL_PLAYER_COLORS.includes(color))
        return err("invalid_target", `${color} is not a Survivor colour`);
      if (color && isColorTaken(ctx, color))
        return err("color_taken", `${color} is taken`);
      color = color ?? firstFreeColor(ctx);
      if (!color) return err("no_colors_available", "every colour is taken");
      const player = createPlayer({
        id: action.actor,
        displayName: action.displayName,
        color,
        seat: ctx.players.length,
        castawaySlots: ctx.config.limits.characterCardsPerPlayer,
      });
      ctx.players.push(player);
      emitPublic(ctx, {
        type: "player_joined",
        playerId: player.id,
        displayName: player.displayName,
        color: player.color,
        seat: player.seat,
        playerCount: ctx.players.length,
      });
      // A lobby whose host is not sitting in it cannot be begun by anybody, so the first player
      // to arrive takes the role. Normally unreachable — `/survivor start` seats the creator in
      // the same breath as it creates the game — but "the host is not at this table" is the
      // dead end this whole path exists to make impossible, and it costs three lines to close
      // it here as well as at the two exits.
      if (ctx.hostId !== player.id && !findPlayer(ctx, ctx.hostId)) {
        const previousHostId = ctx.hostId;
        ctx.hostId = player.id;
        emitPublic(ctx, {
          type: "host_changed",
          previousHostId,
          newHostId: player.id,
          reason: "host_left",
        });
      }
      return OK;
    }

    case "choose_color": {
      const lobby = requireLobby(ctx);
      if (!lobby.ok) return lobby;
      const player = findPlayer(ctx, action.actor);
      if (!player) return err("not_in_game", "join the game first");
      if (!ALL_PLAYER_COLORS.includes(action.color))
        return err("invalid_target", `${action.color} is not a Survivor colour`);
      if (player.color !== action.color && isColorTaken(ctx, action.color))
        return err("color_taken", `${action.color} is taken`);
      player.color = action.color;
      emitPublic(ctx, {
        type: "color_chosen",
        playerId: player.id,
        color: action.color,
      });
      return OK;
    }

    case "name_castaways":
      return nameCastaways(ctx, action.actor, action.castaways);

    case "leave_game": {
      const player = findPlayer(ctx, action.actor);
      if (!player) return err("not_in_game", "you are not in this game");
      if (player.leftAtSeq !== null)
        return err("player_left_game", "you have already left");
      if (ctx.stage.kind === "lobby") {
        ctx.players = ctx.players.filter((p) => p.id !== player.id);
        ctx.players.forEach((p, i) => {
          p.seat = i;
        });
        emitPublic(ctx, {
          type: "player_left",
          playerId: player.id,
          playerCount: ctx.players.length,
          wasInProgress: false,
        });
        // The host walking out of their own lobby must not take the lobby with them: the role
        // moves to the next seat, and if there is no next seat the lobby is disposed of.
        passHostOn(ctx, player, "host_left");
        if (ctx.players.length === 0) disposeEmptyLobby(ctx, player.id);
        return OK;
      }
      const active = requireActive(ctx);
      if (!active.ok) return active;
      emitPublic(ctx, {
        type: "player_left",
        playerId: player.id,
        playerCount: playersInPlay(ctx).length - 1,
        wasInProgress: true,
      });
      departAndRotate(ctx, player);
      passHostOn(ctx, player, "host_left");
      return OK;
    }

    case "start_game": {
      const lobby = requireLobby(ctx);
      if (!lobby.ok) return lobby;
      if (!findPlayer(ctx, action.actor))
        return err("not_in_game", "join the game first");
      const count = asPlayerCount(ctx.players.length);
      if (ctx.players.length < ctx.config.limits.minPlayers || !count)
        return err(
          "not_enough_players",
          `this game needs ${ctx.config.limits.minPlayers} players`,
        );
      if (ctx.players.length > ctx.config.limits.maxPlayers)
        return err(
          "too_many_players",
          `this game seats ${ctx.config.limits.maxPlayers}`,
        );
      let first = ctx.players[0];
      if (action.firstPlayer) {
        const named = findPlayer(ctx, action.firstPlayer);
        if (!named) return err("target_not_in_game", "that player is not in this game");
        first = named;
      } else {
        // "Pick a player to go first" — with nobody named, the RNG picks, deterministically.
        first = ctx.rng.pick(ctx.players) ?? first;
      }
      if (!first) return err("not_enough_players", "no players");

      ctx.playerCount = count;
      ctx.startedAtMs = ctx.nowMs;
      emitPublic(ctx, {
        type: "game_started",
        playerCount: count,
        seatOrder: ctx.players.map((p) => p.id),
        firstPlayerId: first.id,
        seed: ctx.rng.state().seed,
      });
      dealLegends(ctx);
      setupDeck(ctx, count);
      beginTurn(ctx, first, 1);
      return OK;
    }

    case "abandon_game": {
      // `viaModerator` is the Discord layer asserting it checked Manage Server — see the field's
      // own documentation on `AbandonGameAction`. The actor is still the moderator's own id, so
      // both the stage and the event attribute the ending to whoever actually did it.
      const viaModerator = action.viaModerator === true;
      if (!viaModerator) {
        const host = requireHost(ctx, action.actor);
        if (!host.ok) return host;
      }
      if (ctx.stage.kind === "abandoned")
        return err("game_abandoned", "already abandoned");
      if (ctx.stage.kind === "finished")
        return err("game_finished", "this game has finished");
      cancelAllPendings(ctx, "game_ended");
      ctx.stage = {
        kind: "abandoned",
        abandonedAtMs: ctx.nowMs,
        abandonedById: action.actor,
      };
      emitPublic(ctx, {
        type: "game_abandoned",
        byId: action.actor,
        viaModerator,
      });
      return OK;
    }

    case "remove_player": {
      const host = requireHost(ctx, action.actor);
      if (!host.ok) return host;
      const target = findPlayer(ctx, action.target);
      if (!target) return err("target_not_in_game", "that player is not in this game");
      if (target.leftAtSeq !== null)
        return err("player_left_game", "they have already left");
      emitPublic(ctx, {
        type: "player_removed",
        playerId: target.id,
        removedById: action.actor,
        wasInProgress: ctx.stage.kind !== "lobby",
      });
      if (ctx.stage.kind === "lobby") {
        ctx.players = ctx.players.filter((p) => p.id !== target.id);
        ctx.players.forEach((p, i) => {
          p.seat = i;
        });
        // A host may remove themselves, which is the same dead end as leaving: same fix.
        passHostOn(ctx, target, "host_removed");
        if (ctx.players.length === 0) disposeEmptyLobby(ctx, action.actor);
        return OK;
      }
      departAndRotate(ctx, target);
      passHostOn(ctx, target, "host_removed");
      return OK;
    }

    case "transfer_host": {
      const host = requireHost(ctx, action.actor);
      if (!host.ok) return host;
      if (ctx.stage.kind === "abandoned")
        return err("game_abandoned", "this game was abandoned");
      if (ctx.stage.kind === "finished")
        return err("game_finished", "this game has finished");
      const target = findPlayer(ctx, action.target);
      if (!target) return err("target_not_in_game", "that player is not in this game");
      if (target.id === action.actor)
        return err("self_target_not_allowed", "you are already the host");
      if (target.leftAtSeq !== null)
        return err("player_left_game", "they have left the table");
      // A juror may INHERIT the role when nobody in play is left to take it (see
      // `nextHostFromSeat`), but handing it to somebody who has been voted out on purpose puts
      // the game in the hands of a player with nothing left to lose.
      if (target.eliminatedAtSeq !== null)
        return err("player_eliminated", "they have been voted out");
      ctx.hostId = target.id;
      emitPublic(ctx, {
        type: "host_changed",
        previousHostId: action.actor,
        newHostId: target.id,
        reason: "transferred",
      });
      return OK;
    }

    // --- turn step 1: steal ----------------------------------------------
    case "steal_random": {
      const actor = requireTurn(ctx, action.actor, "steal");
      if (!actor.ok) return actor;
      const turn = turnOf(ctx.stage);
      if (turn?.stealResolved)
        return err("wrong_turn_phase", "you have already taken your steal");
      // `stealResolved` is not set until the victim's Sorry For You window CLOSES, so guarding
      // on it alone lets a second declaration arm a second independent take against a second
      // victim (audit #83). "Pick a player and steal a random card from them" — one player, one
      // card, once per turn.
      if (stealIsBeingAnswered(ctx))
        return err("steal_being_answered", "your steal is still being answered");
      const target = requireTarget(ctx, action.actor, action.target, false);
      if (!target.ok) return target;
      if (
        target.value.hand.length === 0 &&
        !ctx.config.houseRules.allowStealFromEmptyHand
      ) {
        return err("invalid_target", "that player has no cards to steal");
      }
      openTake(ctx, {
        origin: { kind: "turn_steal", effectId: newEffectId(ctx) },
        takerIds: [action.actor],
        victimId: action.target,
        spec: { kind: "random", count: 1 },
      });
      return OK;
    }

    // --- turn step 2: play ------------------------------------------------
    case "skip_play_step": {
      const actor = requireTurn(ctx, action.actor, "play");
      if (!actor.ok) return actor;
      // Skipping is not playing: a card that HAS been played cannot be un-played, and the
      // `play_step_skipped` event would be a factually false public claim. Without this,
      // `setTurnPhase(ctx, "draw")` also force-advanced the turn past a still-open window —
      // "Remember: Steal, Play (or don't), then Draw!" in the wrong order.
      const turn = turnOf(ctx.stage);
      if (turn?.cardPlayedThisTurn)
        return err(
          "card_already_played_this_turn",
          "you have already played a card this turn",
        );
      if (hasOpenPendings(ctx))
        return err("wrong_turn_phase", "something is still being answered");
      emitPublic(ctx, { type: "play_step_skipped", playerId: action.actor });
      setTurnPhase(ctx, "draw");
      return OK;
    }

    case "play_camp_raid": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.CampRaid,
      );
      if (!actor.ok) return actor;
      // "Place this card face up in front of ANY PLAYER." The only restriction the card carries
      // is the sidebar's "You can't play this card on a player who already has a Camp Raid in
      // front of them", checked two lines down; neither official PDF excludes yourself. The
      // self-raid is self-defeating — you hand yourself the card you just drew — which is
      // precisely why the printed rules did not need to forbid it, and refusing it left a
      // player with no legal way to spend a dead Camp Raid once every opponent already carried
      // a marker: `legalActionsFor` dropped the action entirely and the card was unplayable for
      // the rest of the game, with the printed text still offering a target.
      const target = requireTarget(ctx, action.actor, action.target, true);
      if (!target.ok) return target;
      if (target.value.campRaid)
        return err("camp_raid_already_present", "that player already has a Camp Raid");
      spendCardPlay(ctx, actor.value, action.cardUid, true);
      target.value.campRaid = {
        cardUid: action.cardUid,
        raiderId: action.actor,
        placedAtSeq: stamp(ctx),
      };
      emitPublic(ctx, {
        type: "camp_raid_placed",
        raiderId: action.actor,
        victimId: target.value.id,
        cardUid: action.cardUid,
      });
      return OK;
    }

    case "play_knowledge_is_power": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.KnowledgeIsPower,
      );
      if (!actor.ok) return actor;
      const target = requireTarget(ctx, action.actor, action.target, false);
      if (!target.ok) return target;
      if (!nameableKinds(ctx.config.deck).includes(action.named))
        return err(
          "unknown_card_kind",
          `${action.named} is not a card you can ask for`,
        );
      spendCardPlay(ctx, actor.value, action.cardUid, false);
      emitPublic(ctx, {
        type: "knowledge_is_power_asked",
        askerId: action.actor,
        targetId: target.value.id,
        named: action.named,
      });
      const held =
        target.value.hand.find((uid) => kindOf(ctx, uid) === action.named) ?? null;
      emitPublic(ctx, {
        type: "knowledge_is_power_answered",
        askerId: action.actor,
        targetId: target.value.id,
        named: action.named,
        hit: held !== null,
      });
      if (!held) return OK;
      const take: PendingTake = openTake(ctx, {
        origin: {
          kind: "knowledge_is_power",
          effectId: newEffectId(ctx),
          cardUid: action.cardUid,
          named: action.named,
        },
        takerIds: [action.actor],
        victimId: target.value.id,
        spec: { kind: "specific", cardUids: [held] },
      });
      // "they must GIVE you 1" against "ANY time someone tries to TAKE cards from you": if the
      // table reads it as unblockable, the card resolves at once instead of opening a window.
      if (!ctx.config.houseRules.sorryForYouBlocksKnowledgeIsPower) {
        finishTakeResolved(ctx, take, resolveTake(ctx, take));
      }
      return OK;
    }

    case "play_spy_shack": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.TheSpyShack,
      );
      if (!actor.ok) return actor;
      const target = requireTarget(ctx, action.actor, action.target, false);
      if (!target.ok) return target;
      spendCardPlay(ctx, actor.value, action.cardUid, false);
      // "Look at any player's cards and take one." The look and the take are one sentence and
      // the rules give no ordering, so which comes first is a disclosed house rule.
      if (ctx.config.houseRules.spyShackLookHappensBeforeBlock) {
        revealHandTo(ctx, action.actor, target.value);
      }
      const take = openTake(ctx, {
        origin: {
          kind: "spy_shack",
          effectId: newEffectId(ctx),
          cardUid: action.cardUid,
        },
        takerIds: [action.actor],
        victimId: target.value.id,
        spec: { kind: "chosen", count: 1 },
      });
      if (!ctx.config.houseRules.sorryForYouBlocksSpyShack) {
        finishTakeResolved(ctx, take, resolveTake(ctx, take));
      }
      return OK;
    }

    case "play_lets_form_an_alliance": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.LetsFormAnAlliance,
      );
      if (!actor.ok) return actor;
      const partner = requireTarget(ctx, action.actor, action.partner, false);
      if (!partner.ok) return partner;
      const victim = requireTarget(ctx, action.actor, action.victim, false);
      if (!victim.ok) return victim;
      // "You can steal from the same player, but you can't steal from each other."
      if (action.victim === action.partner)
        return err("duplicate_target", "you cannot steal from your own partner");
      spendCardPlay(ctx, actor.value, action.cardUid, false);
      const effectId = newEffectId(ctx);
      emitPublic(ctx, {
        type: "alliance_formed",
        initiatorId: action.actor,
        partnerId: action.partner,
        cardUid: action.cardUid,
        initiatorVictimId: action.victim,
      });
      openTake(ctx, {
        origin: {
          kind: "alliance",
          effectId,
          cardUid: action.cardUid,
          partnerId: action.partner,
        },
        takerIds: [action.actor],
        victimId: action.victim,
        spec: ctx.config.houseRules.allianceStealIsRandom
          ? { kind: "random", count: 1 }
          : { kind: "chosen", count: 1 },
      });
      openAllianceTarget(ctx, {
        cardUid: action.cardUid,
        effectId,
        initiatorId: action.actor,
        partnerId: action.partner,
        forbiddenTargets: [action.actor, action.partner],
      });
      return OK;
    }

    case "play_do_or_die": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.DoOrDie,
      );
      if (!actor.ok) return actor;
      const opponent = requireTarget(ctx, action.actor, action.opponent, false);
      if (!opponent.ok) return opponent;
      spendCardPlay(ctx, actor.value, action.cardUid, false);
      startChallenge(ctx, {
        challenge: "do_or_die",
        cardUid: action.cardUid,
        initiatorId: action.actor,
        participantIds: [action.actor, opponent.value.id],
        round: 1,
      });
      return OK;
    }

    case "play_power_pair": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.PowerPair,
      );
      if (!actor.ok) return actor;
      if (action.first === action.second)
        return err("duplicate_target", "pick two different players");
      const first = requireTarget(ctx, action.actor, action.first, false);
      if (!first.ok) return first;
      const second = requireTarget(ctx, action.actor, action.second, false);
      if (!second.ok) return second;
      spendCardPlay(ctx, actor.value, action.cardUid, false);
      startChallenge(ctx, {
        challenge: "power_pair",
        cardUid: action.cardUid,
        initiatorId: action.actor,
        participantIds: [action.actor, first.value.id, second.value.id],
        round: 1,
      });
      return OK;
    }

    case "play_its_a_numbers_game": {
      const actor = requirePlayStep(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.ItsANumbersGame,
      );
      if (!actor.ok) return actor;
      spendCardPlay(ctx, actor.value, action.cardUid, false);
      // "all players (including you)" — every player still in the game participates.
      startChallenge(ctx, {
        challenge: "its_a_numbers_game",
        cardUid: action.cardUid,
        initiatorId: action.actor,
        participantIds: playersInPlay(ctx).map((p) => p.id),
        round: 1,
      });
      return OK;
    }

    // --- turn step 3: draw -------------------------------------------------
    case "draw_card": {
      const actor = requireTurn(ctx, action.actor, "draw");
      if (!actor.ok) return actor;
      doDraw(ctx, actor.value);
      return OK;
    }

    // --- reactions ---------------------------------------------------------
    case "play_sorry_for_you": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind !== "take")
        return err("wrong_pending_kind", "Sorry For You answers a take, not that");
      if (pending.victimId !== action.actor)
        return err("not_a_participant", "nobody is taking cards from you there");
      const inHand = requireCardInHand(
        ctx,
        actor.value,
        action.cardUid,
        CardKind.SorryForYou,
      );
      if (!inHand.ok) return inHand;
      if (!sorryForYouApplies(ctx, pending))
        return err(
          "card_not_playable_now",
          "this take cannot be blocked at this table",
        );

      emitPublic(ctx, {
        type: "card_played",
        playerId: action.actor,
        cardUid: action.cardUid,
        kind: CardKind.SorryForYou,
        consumedTurnPlay: false,
      });
      discardCard(ctx, action.cardUid, "played", { playerId: action.actor });
      emitPublic(ctx, {
        type: "sorry_for_you_played",
        playerId: action.actor,
        cardUid: action.cardUid,
        pendingId: pending.id,
      });
      blockTake(ctx, pending, action.cardUid);
      finishTakeBlocked(ctx, pending);
      return OK;
    }

    case "play_inheritance": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind !== "inheritance")
        return err("wrong_pending_kind", "Inheritance answers an elimination");
      const inHand = requireCardInHand(
        ctx,
        actor.value,
        action.cardUid,
        CardKind.Inheritance,
      );
      if (!inHand.ok) return inHand;
      const color = colorOf(requireCard(ctx, action.cardUid));
      if (color !== pending.color)
        return err("invalid_target", "that Inheritance card is for a different colour");
      claimInheritance(ctx, pending, action.actor, action.cardUid);
      resumeAfterWindow(ctx);
      return OK;
    }

    case "decline_reaction": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind === "take") {
        if (pending.victimId !== action.actor)
          return err("not_a_participant", "that window is not yours to decline");
        finishTakeResolved(ctx, pending, resolveTake(ctx, pending));
        resumeAfterWindow(ctx);
        return OK;
      }
      if (pending.kind === "inheritance") {
        const actor = findPlayer(ctx, action.actor);
        if (!actor || inheritanceForColor(ctx, actor, pending.color) === null)
          return err("not_a_participant", "you do not hold that Inheritance card");
        forfeitInheritance(ctx, pending, false);
        resumeAfterWindow(ctx);
        return OK;
      }
      return err("wrong_pending_kind", "that window cannot be declined");
    }

    // --- pending resolutions ----------------------------------------------
    case "submit_challenge_choice": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that challenge is over");
      if (pending.kind !== "challenge")
        return err("wrong_pending_kind", "not a challenge");
      const slot = pending.slots.find((s) => s.playerId === action.actor);
      if (!slot) return err("not_a_participant", "you are not in this challenge");
      if (slot.submission !== null)
        return err("already_submitted", "you have already shown your hand");
      if (!submissionIsLegal(pending.challenge, action.submission))
        return err(
          "wrong_number_of_choices",
          "that is not a legal choice for this challenge",
        );
      submitToChallenge(ctx, pending, action.actor, action.submission);
      resumeAfterWindow(ctx);
      return OK;
    }

    case "choose_alliance_target": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind !== "alliance_target")
        return err("wrong_pending_kind", "not an alliance target choice");
      if (pending.partnerId !== action.actor)
        return err("not_a_participant", "you are not the partner");
      if (pending.forbiddenTargets.includes(action.target))
        return err("invalid_target", "allies cannot steal from each other");
      const target = requireTarget(ctx, action.actor, action.target, false);
      if (!target.ok) return target;
      prunePending(ctx, pending.id);
      emitPublic(ctx, {
        type: "alliance_target_chosen",
        pendingId: pending.id,
        partnerId: pending.partnerId,
        victimId: action.target,
      });
      joinOrOpenAllianceTake(
        ctx,
        pending.effectId,
        pending.cardUid,
        pending.partnerId,
        action.target,
      );
      resumeAfterWindow(ctx);
      return OK;
    }

    case "choose_card": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind !== "card_choice")
        return err("wrong_pending_kind", "not a card choice");
      if (pending.chooserId !== action.actor)
        return err("not_a_participant", "that choice is not yours");
      if (pending.chosen !== null)
        return err("already_submitted", "you have already made that choice");
      if (!pending.options.includes(action.cardUid))
        return err("invalid_target", "that card is not one of your options");
      applyCardChoice(ctx, pending, action.cardUid, false);
      resumeAfterWindow(ctx);
      return OK;
    }

    case "choose_steal_victim": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind !== "steal_victim")
        return err("wrong_pending_kind", "not a steal-victim choice");
      if (pending.chooserId !== action.actor)
        return err("not_a_participant", "that choice is not yours");
      const target = requireTarget(ctx, action.actor, action.target, false);
      if (!target.ok) return target;
      prunePending(ctx, pending.id);
      openTake(ctx, {
        origin: {
          kind: "challenge",
          effectId: pending.effectId,
          challenge: "its_a_numbers_game",
          cardUid: pending.cardUid,
        },
        takerIds: [pending.chooserId],
        victimId: action.target,
        spec: { kind: "random", count: pending.count },
      });
      resumeAfterWindow(ctx);
      return OK;
    }

    case "discard_card": {
      const active = requireActive(ctx);
      if (!active.ok) return active;
      const pending = findPending(ctx, action.pendingId);
      if (!pending) return err("pending_not_found", "that window is closed");
      if (pending.kind !== "discard")
        return err("wrong_pending_kind", "not a forced discard");
      if (pending.playerId !== action.actor)
        return err("not_a_participant", "that discard is not yours");
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      if (!handHas(actor.value, action.cardUid))
        return err("card_not_in_hand", "that card is not in your hand");
      applyDiscardChoice(ctx, pending, action.cardUid, "forced", false);
      resumeAfterWindow(ctx);
      return OK;
    }

    // --- tribal council ----------------------------------------------------
    case "advance_council": {
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      if (council.leaderId !== action.actor)
        return err("not_council_leader", "only the Tribal Council Leader can do that");
      if (council.phase !== action.from)
        return err("stale_phase", `the council has moved on to ${council.phase}`);
      if (!leaderAdvanceableFrom(council.phase))
        return err("wrong_council_phase", `${council.phase} advances on its own`);
      if (council.phase === "voting" && council.requiredCasts.length > 0)
        return err("must_cast_mandatory_vote", "some players still owe a vote");
      advanceCouncilPhase(ctx, council);
      return OK;
    }

    case "play_control_the_vote": {
      const guard = requireAdvantageWindow(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.ControlTheVote,
      );
      if (!guard.ok) return guard;
      const target = requireTarget(ctx, action.actor, action.target, false);
      if (!target.ok) return target;
      const voteCardUid = target.value.voteCards[0];
      if (!voteCardUid)
        return err("invalid_target", "that player has no Vote Card to take");
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      playControlTheVote(
        ctx,
        council,
        guard.value,
        action.cardUid,
        action.target,
        voteCardUid,
      );
      return OK;
    }

    case "play_goodwill_gamble": {
      const guard = requireAdvantageWindow(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.GoodwillGamble,
      );
      if (!guard.ok) return guard;
      const recipient = requireTarget(ctx, action.actor, action.recipient, false);
      if (!recipient.ok) return recipient;
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      playGoodwillGamble(ctx, council, guard.value, action.cardUid, recipient.value);
      return OK;
    }

    case "play_im_the_leader_now": {
      const guard = requireAdvantageWindow(
        ctx,
        action.actor,
        action.cardUid,
        CardKind.ImTheLeaderNow,
      );
      if (!guard.ok) return guard;
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      playImTheLeaderNow(ctx, council, guard.value, action.cardUid);
      return OK;
    }

    case "cast_vote": {
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      if (council.phase !== "voting")
        return err("voting_not_open", "voting is not open");
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      // "Then, pass the box to the player on your left … and close your eyes." Your ballot is
      // the moment the box is in front of you; once it has moved on you cannot add to it. Left
      // open, a player could pass the box, watch `voter_finished` name the table one by one,
      // and only then spend banked Extra Votes with strictly more information than everyone who
      // voted in turn — the exact asymmetry the rhythm-tapping ritual exists to prevent.
      if (council.finishedVoting.includes(action.actor))
        return err("already_submitted", "you have already passed the box on");
      const source = voteSourceOf(
        ctx,
        actor.value,
        action.cardUid,
        council.requiredCasts,
      );
      if (!source.ok) return source;
      const target = findPlayer(ctx, action.target);
      if (!target) return err("target_not_in_game", "that player is not in this game");
      if (!isInPlay(target) && !ctx.config.houseRules.allowVotingForEliminatedPlayer)
        return err(
          "invalid_target",
          "you must vote for a player in this Tribal Council",
        );
      if (target.id === action.actor && !ctx.config.houseRules.allowSelfVote)
        return err(
          "self_target_not_allowed",
          "you cannot vote for yourself at this table",
        );
      castVote(ctx, council, actor.value, action.cardUid, action.target, source.value);
      return OK;
    }

    case "finish_voting": {
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      if (council.phase !== "voting")
        return err("voting_not_open", "voting is not open");
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      if (council.finishedVoting.includes(action.actor))
        return err("already_submitted", "you have already passed the box on");
      if (outstandingCasts(council, action.actor).length > 0)
        return err("must_cast_mandatory_vote", "you still owe a vote this council");
      finishVoting(ctx, council, action.actor);
      return OK;
    }

    case "play_immunity_idol": {
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      if (council.phase !== "idols")
        return err(
          "card_not_playable_now",
          "idols are played after every vote, before the tally",
        );
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      const inHand = requireCardInHand(
        ctx,
        actor.value,
        action.cardUid,
        CardKind.ImmunityIdol,
      );
      if (!inHand.ok) return inHand;
      if (
        !ctx.config.houseRules.allowMultipleIdolsPerPlayerPerCouncil &&
        council.idolPlays.some((i) => i.playedBy === action.actor)
      ) {
        return err(
          "card_not_playable_now",
          "one Immunity Idol per player per council here",
        );
      }
      const protects = requireTarget(ctx, action.actor, action.protects, true);
      if (!protects.ok) return protects;
      playImmunityIdol(ctx, council, actor.value, action.cardUid, action.protects);
      return OK;
    }

    case "play_idol_nullifier": {
      if (!ctx.config.deck.includeIdolNullifier)
        return err(
          "feature_disabled",
          "the Idol Nullifier is not in play at this table",
        );
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      if (council.phase !== "nullifiers")
        return err(
          "card_not_playable_now",
          "a nullifier answers an idol, before the tally",
        );
      const actor = requireActor(ctx, action.actor);
      if (!actor.ok) return actor;
      const inHand = requireCardInHand(
        ctx,
        actor.value,
        action.cardUid,
        CardKind.IdolNullifier,
      );
      if (!inHand.ok) return inHand;
      const idol = council.idolPlays.find((i) => i.cardUid === action.targetIdolUid);
      if (!idol) return err("no_idol_to_nullify", "no such Immunity Idol was played");
      if (idol.nullifiedBy !== null)
        return err("idol_already_nullified", "that idol has already been cancelled");
      playIdolNullifier(
        ctx,
        council,
        actor.value,
        action.cardUid,
        action.targetIdolUid,
      );
      return OK;
    }

    case "leader_choose_eliminations": {
      const council = councilOf(ctx.stage);
      if (!council)
        return err("no_council_in_progress", "no Tribal Council is in progress");
      const pending = findPending(ctx, action.pendingId);
      if (!pending)
        return err("pending_not_found", "that decision has already been made");
      if (pending.kind !== "leader_decision")
        return err("wrong_pending_kind", "not a Leader decision");
      if (pending.leaderId !== action.actor)
        return err("not_council_leader", "only the Tribal Council Leader decides");
      if (action.targets.length !== pending.choose)
        return err(
          "wrong_number_of_choices",
          `name exactly ${pending.choose} player(s)`,
          { expected: pending.choose, got: action.targets.length },
        );
      if (new Set(action.targets).size !== action.targets.length)
        return err("duplicate_target", "name two different players");
      for (const target of action.targets) {
        if (!pending.candidates.includes(target))
          return err(
            "candidate_not_eligible",
            `${target} is not eligible at this tier`,
          );
      }
      applyLeaderDecision(ctx, pending, action.targets, false);
      return OK;
    }

    // --- final tribal council ---------------------------------------------
    case "advance_final_council": {
      const final = finalCouncilOf(ctx.stage);
      if (!final)
        return err("no_council_in_progress", "no Final Tribal Council is in progress");
      if (final.leaderId !== action.actor)
        return err(
          "not_council_leader",
          "only the Final Tribal Council Leader can do that",
        );
      if (final.phase !== action.from)
        return err("stale_phase", `the council has moved on to ${final.phase}`);
      const next = nextFinalPhase(final.phase);
      if (!next)
        return err("wrong_council_phase", `${final.phase} advances on its own`);
      enterFinalPhase(ctx, next);
      return OK;
    }

    case "reveal_hand": {
      const final = finalCouncilOf(ctx.stage);
      if (!final)
        return err("no_council_in_progress", "no Final Tribal Council is in progress");
      if (!final.finalists.includes(action.actor))
        return err("not_a_finalist", "only the final two may reveal a hand");
      if (final.revealedHands.includes(action.actor))
        return err("already_submitted", "your hand is already on the table");
      revealFinalistHand(ctx, action.actor);
      return OK;
    }

    case "juror_ready": {
      const final = finalCouncilOf(ctx.stage);
      if (!final)
        return err("no_council_in_progress", "no Final Tribal Council is in progress");
      if (!final.jury.includes(action.actor))
        return err("not_a_juror", "only the Jury votes at the Final Tribal Council");
      if (final.readyJurors.includes(action.actor))
        return err("already_submitted", "your finger is already in the air");
      markJurorReady(ctx, action.actor);
      return OK;
    }

    case "cast_jury_vote": {
      const final = finalCouncilOf(ctx.stage);
      if (!final)
        return err("no_council_in_progress", "no Final Tribal Council is in progress");
      if (final.phase !== "jury_vote")
        return err("voting_not_open", "the Jury vote has not opened yet");
      if (!final.jury.includes(action.actor))
        return err("not_a_juror", "only the Jury votes at the Final Tribal Council");
      if (final.juryVotes.some((v) => v.jurorId === action.actor))
        return err("jury_vote_already_cast", "you have already voted");
      if (!final.finalists.includes(action.finalist))
        return err("invalid_target", "the Jury votes FOR one of the final two");
      castJuryVote(ctx, action.actor, action.finalist);
      return OK;
    }

    case "final_leader_break_tie": {
      const final = finalCouncilOf(ctx.stage);
      if (!final)
        return err("no_council_in_progress", "no Final Tribal Council is in progress");
      if (final.phase !== "tie_break")
        return err("no_tie_to_break", "there is no tie to break");
      if (final.leaderId !== action.actor)
        return err(
          "not_council_leader",
          "the Final Tribal Council Leader breaks the tie",
        );
      if (!final.finalists.includes(action.winner))
        return err("invalid_target", "the winner must be one of the final two");
      // "They DON'T have to pick the player they originally voted for."
      completeFinalCouncil(
        ctx,
        action.winner,
        true,
        juryCountFor(final, action.winner),
      );
      return OK;
    }

    default:
      return assertNever(action, "applyAction");
  }
}

// ---------------------------------------------------------------------------
// Action helpers
// ---------------------------------------------------------------------------

/**
 * `name_castaways`: who is on each of this player's Survivor Character Cards.
 *
 * Cosmetic, but still table state, so every rule about it is checked here rather than trusted
 * from the layer that collected the names: the right number of them, each already in the form
 * `sanitizeCastawayName` produces (nothing that could ping, format or link in a channel), no
 * castaway twice at one table, no blank once the game is under way, and no rewriting a castaway
 * who has already been voted out — their card is face down on the "VOTED OUT" side.
 */
function nameCastaways(
  ctx: Ctx,
  actor: PlayerId,
  names: readonly (string | null)[],
): Result<void> {
  const player = findPlayer(ctx, actor);
  if (!player) return err("not_in_game", "join the game first");
  if (player.leftAtSeq !== null)
    return err("player_left_game", "you have left this game");
  const inLobby = ctx.stage.kind === "lobby";
  if (!inLobby) {
    const active = requireActive(ctx);
    if (!active.ok) return active;
    if (player.eliminatedAtSeq !== null)
      return err("player_eliminated", "both of your castaways have been voted out");
  }

  const slots = ctx.config.limits.characterCardsPerPlayer;
  if (names.length !== slots)
    return err("castaway_name_invalid", `name exactly ${slots} castaways`, {
      given: names.length,
    });
  for (const name of names) {
    if (name === null) {
      if (!inLobby)
        return err(
          "castaway_name_invalid",
          "every castaway needs a name once the game has begun",
        );
    } else if (!isValidCastawayName(name)) {
      return err(
        "castaway_name_invalid",
        "that is not a castaway name the table can show",
      );
    }
  }
  for (const [i, card] of player.characterCards.entries()) {
    if (card.flipped && names[i] !== player.castaways[i])
      return err("castaway_voted_out", "that castaway has already been voted out", {
        slot: i + 1,
      });
  }

  const mine = names.flatMap((name) => (name === null ? [] : [castawayKey(name)]));
  if (new Set(mine).size !== mine.length)
    return err("castaway_name_taken", "the same castaway twice");
  const elsewhere = new Set(
    ctx.players
      .filter((other) => other.id !== player.id)
      .flatMap((other) => other.castaways)
      .flatMap((name) => (name === null ? [] : [castawayKey(name)])),
  );
  if (mine.some((key) => elsewhere.has(key)))
    return err(
      "castaway_name_taken",
      "someone at this table already has that castaway",
    );

  // Re-sending what is already there is not a change, and a change with no event is a lie.
  if (names.every((name, i) => name === player.castaways[i])) return OK;
  player.castaways = [...names];
  emitPublic(ctx, {
    type: "castaways_named",
    playerId: player.id,
    castaways: [...names],
    reason: inLobby ? "picked" : "renamed",
  });
  return OK;
}

/**
 * Deal a legend into every castaway nobody picked, as the game begins.
 *
 * From its own stream (`dealCastaways`), never from `ctx.rng`, so naming castaways can never
 * change a shuffle, a steal or a Tribal Council placement. One `castaways_named` per player, so
 * the log holds every castaway at the table, not only the ones somebody typed.
 */
function dealLegends(ctx: Ctx): void {
  const dealt = dealCastaways(
    ctx.players.map((player) => player.castaways),
    ctx.rng.state().seed,
  );
  ctx.players.forEach((player, i) => {
    player.castaways = dealt[i] ?? player.castaways;
    emitPublic(ctx, {
      type: "castaways_named",
      playerId: player.id,
      castaways: [...player.castaways],
      reason: "dealt",
    });
  });
}

/**
 * Move the host role off somebody who has just left the table.
 *
 * A no-op for anyone who was not the host, so both call sites can call it unconditionally: the
 * alternative is an `if` at every departure, and the one that gets forgotten is the bug. Returns
 * the new host, or null when nobody is left to take the role.
 */
function passHostOn(
  ctx: Ctx,
  formerHost: DraftPlayer,
  reason: "host_left" | "host_removed",
): DraftPlayer | null {
  if (ctx.hostId !== formerHost.id) return null;
  // A departure can be the one that ends the game (`afterPlayerCountChanged` declares a winner
  // when one player is left). Nobody needs to be told who is running a game that is over, and
  // "the camp passes to…" printed under the winner announcement reads like the game continues.
  if (ctx.stage.kind === "finished" || ctx.stage.kind === "abandoned") return null;
  const heir = nextHostFromSeat(ctx, formerHost.seat, formerHost.id);
  if (!heir) return null;
  ctx.hostId = heir.id;
  emitPublic(ctx, {
    type: "host_changed",
    previousHostId: formerHost.id,
    newHostId: heir.id,
    reason,
  });
  return heir;
}

/**
 * The last player has left a lobby. Close it.
 *
 * An empty lobby is not a game waiting to happen: nobody can be the host, nobody can press
 * Begin, and the card the remaining players would have joined from went with the last of them.
 * Leaving the session alive would pin the channel — `/survivor start` refuses while a game
 * exists — so the engine ends it here and the Discord layer retires the session and deletes the
 * save exactly as it does for any other abandoned game. There are no pendings in a lobby, so
 * there is nothing to cancel.
 */
function disposeEmptyLobby(ctx: Ctx, lastOutId: PlayerId): void {
  ctx.stage = {
    kind: "abandoned",
    abandonedAtMs: ctx.nowMs,
    abandonedById: lastOutId,
  };
  emitPublic(ctx, { type: "game_abandoned", byId: lastOutId, emptyLobby: true });
}

/** Departure and removal both have to hand the turn on if it was the departing player's. */
function departAndRotate(ctx: Ctx, player: DraftPlayer): void {
  const turn = turnOf(ctx.stage);
  const wasTheirTurn = turn?.playerId === player.id;
  depart(ctx, player, "player_left_game");
  if (!wasTheirTurn) return;
  const stage = ctx.stage;
  if (stage.kind !== "turn") return;
  const next = nextInPlayFromSeat(ctx, player.seat);
  handOffTurn(ctx, stage.turn, next);
}

/** The three Tribal Advantages share one window: from the Leader's opening line until voting. */
function requireAdvantageWindow(
  ctx: Ctx,
  actor: PlayerId,
  cardUid: CardUid,
  kind: CardKind,
): Result<DraftPlayer> {
  const council = councilOf(ctx.stage);
  if (!council)
    return err("no_council_in_progress", "no Tribal Council is in progress");
  if (council.phase !== "advantages" && council.phase !== "discussion") {
    // "You can play as many Tribal Advantage Cards as you would like during this discussion,
    // but NOT once voting has started!"
    return err(
      "card_not_playable_now",
      "Tribal Advantages are played before voting begins",
    );
  }
  const player = requireActor(ctx, actor);
  if (!player.ok) return player;
  const inHand = requireCardInHand(ctx, player.value, cardUid, kind);
  if (!inHand.ok) return inHand;
  return player;
}

/** Which zone the card being cast came from, and therefore what kind of vote it is. */
function voteSourceOf(
  ctx: Ctx,
  player: DraftPlayer,
  cardUid: CardUid,
  obligations: readonly { readonly cardUid: CardUid; readonly source: VoteSource }[],
): Result<VoteSource> {
  if (player.voteCards.includes(cardUid)) {
    const owed = obligations.find((o) => o.cardUid === cardUid);
    return ok(owed?.source === "stolen_vote_card" ? "stolen_vote_card" : "vote_card");
  }
  if (player.grantedVotes.includes(cardUid)) return ok<VoteSource>("goodwill_gamble");
  if (player.hand.includes(cardUid)) {
    if (kindOf(ctx, cardUid) !== CardKind.ExtraVote)
      return err("wrong_card_kind", "only a Vote or Extra Vote card goes in the box");
    return ok<VoteSource>("extra_vote");
  }
  if (!lookupCard(ctx, cardUid)) return err("card_not_in_hand", "no such card");
  return err("no_vote_card", "you are not holding that card");
}

/**
 * The partner has named their victim.
 *
 * GROUPING INVARIANT: exactly one `PendingTake` per (effect instance, victim). When both allies
 * name the same player, the partner joins the take that is already open against them, so ONE
 * Sorry For You blanks both and makes EACH of them discard — the Survival Guide's canonical
 * example. When they name different players, the second take shares the same `effectId` so a
 * renderer can still narrate the two as one card play.
 */
function joinOrOpenAllianceTake(
  ctx: Ctx,
  effectId: ReturnType<typeof newEffectId>,
  cardUid: CardUid,
  partnerId: PlayerId,
  victimId: PlayerId,
): void {
  const existing = ctx.pending.find(
    (p): p is PendingTake =>
      p.kind === "take" &&
      p.origin.kind === "alliance" &&
      p.origin.effectId === effectId &&
      p.victimId === victimId,
  );
  if (existing) {
    const spec =
      existing.spec.kind === "random"
        ? { kind: "random" as const, count: existing.spec.count + 1 }
        : existing.spec.kind === "chosen"
          ? { kind: "chosen" as const, count: existing.spec.count + 1 }
          : existing.spec;
    updatePending(ctx, {
      ...existing,
      takerIds: [...existing.takerIds, partnerId],
      spec,
    });
    return;
  }
  // The initiator's own steal is unaffected: a separate pending against a separate victim, and
  // the shared `effectId` is what lets a renderer narrate the two as one card play.
  openTake(ctx, {
    origin: { kind: "alliance", effectId, cardUid, partnerId },
    takerIds: [partnerId],
    victimId,
    spec: ctx.config.houseRules.allianceStealIsRandom
      ? { kind: "random", count: 1 }
      : { kind: "chosen", count: 1 },
  });
}

/** A window closed: the council resolution or the turn may now be able to continue. */
function resumeAfterWindow(ctx: Ctx): void {
  const council = councilOf(ctx.stage);
  if (council && (council.phase === "tally" || council.phase === "tie_break")) {
    resolveEliminations(ctx);
  }
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

export const reduce = (
  state: GameState,
  action: Action,
  nowMs: number,
): Result<DispatchOutcome> => {
  const ctx = createCtx(state, nowMs);
  const result = applyAction(ctx, action);
  // A rejected action returns the caller's own state object. Nothing was mutated: the draft is a
  // deep copy, and it is discarded here (audit #49).
  if (!result.ok) return result;
  try {
    afterMutation(ctx);
  } catch (cause) {
    if (!(cause instanceof CascadeError)) throw cause;
    // The draft goes in the bin with everything on it, so a non-converging cascade costs the
    // action rather than leaving the game in a state nothing can advance.
    return err("internal_invariant_violated", cause.message);
  }
  return ok({
    events: ctx.events,
    state: finalize(ctx),
    changed: ctx.events.length > 0,
  });
};

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

function expireOne(ctx: Ctx, pending: Pending): void {
  switch (pending.kind) {
    case "take": {
      expirePending(ctx, pending, "take_resolved");
      finishTakeResolved(ctx, pending, resolveTake(ctx, pending));
      return;
    }
    case "discard":
      autoResolveDiscard(ctx, pending);
      return;
    case "challenge":
      resolveChallenge(ctx, pending, true);
      return;
    case "card_choice": {
      const uid = pending.chosen ?? ctx.rng.pick(pending.options);
      if (!uid) {
        expirePending(ctx, pending, "card_choice_auto_selected");
        return;
      }
      applyCardChoice(ctx, pending, uid, true);
      return;
    }
    case "alliance_target":
      expirePending(ctx, pending, "alliance_target_forfeited");
      return;
    case "steal_victim":
      expirePending(ctx, pending, "steal_victim_forfeited");
      return;
    case "leader_decision": {
      // "the engine picked from `candidates`, lowest seat first" — stated in `PendingDefault`
      // so the default is a rule rather than an accident of array order.
      const bySeat = [...pending.candidates].sort(
        (a, b) => (findPlayer(ctx, a)?.seat ?? 0) - (findPlayer(ctx, b)?.seat ?? 0),
      );
      applyLeaderDecision(ctx, pending, bySeat.slice(0, pending.choose), true);
      return;
    }
    case "inheritance":
      forfeitInheritance(ctx, pending, true);
      return;
    default:
      assertNever(pending, "expireOne");
  }
}

function expireTurnStep(ctx: Ctx): void {
  const stage = ctx.stage;
  if (stage.kind !== "turn") return;
  const turn = stage.turn;
  const player = findPlayer(ctx, turn.playerId);
  if (!player) return;
  // A turn whose three steps are done is waiting on the handover, not on this player: touching
  // the backstop here would be a state change with no event behind it.
  if (turn.phase === "ended") return;
  // Push the backstop out before acting, so one expiry advances one step rather than the whole
  // turn collapsing inside a single tick.
  patchTurn(ctx, { deadlineMs: ctx.nowMs + ctx.config.timings.turnSafetyTimeout });
  switch (turn.phase) {
    case "steal": {
      const targets = stealTargets(ctx, player.id);
      const victim = ctx.rng.pick(targets);
      if (!victim) {
        patchTurn(ctx, { stealResolved: true });
        return;
      }
      openTake(ctx, {
        origin: { kind: "turn_steal", effectId: newEffectId(ctx) },
        takerIds: [player.id],
        victimId: victim.id,
        spec: { kind: "random", count: 1 },
      });
      return;
    }
    case "play":
      emitPublic(ctx, { type: "play_step_skipped", playerId: player.id });
      setTurnPhase(ctx, "draw");
      return;
    case "draw":
      doDraw(ctx, player);
      return;
    default:
      assertNever(turn.phase, "expireTurnStep");
  }
}

/**
 * Expire whatever `nowMs` has passed. The only time-driven entry point in the engine — there is
 * no `setTimeout` anywhere, so a game cannot be wedged by a timer outliving its interaction
 * token (audit #29/#44), and a test fast-forwards an hour by passing a bigger number.
 */
export const advance = (state: GameState, nowMs: number): DispatchOutcome => {
  const ctx = createCtx(state, nowMs);

  for (const pending of [...ctx.pending]) {
    if (pending.deadlineMs > nowMs) continue;
    if (!ctx.pending.some((p) => p.id === pending.id)) continue;
    expireOne(ctx, pending);
  }

  const council = councilOf(ctx.stage);
  if (council && council.phaseDeadlineMs !== null && council.phaseDeadlineMs <= nowMs) {
    // "Voting is compulsory. Every player with a Vote Card must cast it, at this council, for a
    // player." So the backstop does not SKIP the vote — it FORFEITS it, out loud, naming who
    // did not cast. It used to re-arm the phase clock instead, which meant a council waiting on
    // one player who had closed Discord could never be resolved by anyone: fifty simulated
    // hours later the phase was still `voting`, `nextDeadline()` still slid forward, and the
    // only escapes were destructive (abandon the game, or remove the player — which also takes
    // them off the Jury). Every other window in the engine has a documented expiry default;
    // this one, the window that gates the rest of the game, had none. See
    // `forfeitOutstandingVotes` for why the cards are left where they are.
    if (council.phase === "voting" && council.requiredCasts.length > 0) {
      forfeitOutstandingVotes(ctx, council);
    }
    advanceCouncilPhase(ctx, council);
  }

  const final = finalCouncilOf(ctx.stage);
  if (final && final.phaseDeadlineMs !== null && final.phaseDeadlineMs <= nowMs) {
    if (final.phase === "jury_vote") forceJuryVoteClose(ctx);
    else if (final.phase === "tie_break") forceTieBreak(ctx);
    else {
      const next = nextFinalPhase(final.phase);
      if (next) enterFinalPhase(ctx, next);
    }
  }

  const turn = turnOf(ctx.stage);
  if (
    ctx.stage.kind === "turn" &&
    turn &&
    turn.deadlineMs !== null &&
    turn.deadlineMs <= nowMs &&
    !hasOpenPendings(ctx)
  ) {
    expireTurnStep(ctx);
  }

  try {
    afterMutation(ctx);
  } catch (cause) {
    if (!(cause instanceof CascadeError)) throw cause;
    // The timer path has no Result to fail into and must never throw into a `setTimeout`
    // callback, so the whole tick is discarded: the caller's own state, no events, no change.
    // The deadline is therefore still pending and the next tick will try again.
    return { events: [], state, changed: false };
  }
  return { events: ctx.events, state: finalize(ctx), changed: ctx.events.length > 0 };
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function cardIndexOf(state: GameState): Map<CardUid, CardInstance> {
  return new Map(state.cards.map((c) => [c.uid, c]));
}

function toPublicPlayer(
  state: GameState,
  player: GameState["players"][number],
): PublicPlayerView {
  const turn = turnOf(state.stage);
  const council = councilOf(state.stage);
  return {
    id: player.id,
    displayName: player.displayName,
    color: player.color,
    seat: player.seat,
    handSize: player.hand.length,
    voteCardCount: player.voteCards.length,
    grantedVoteCount: player.grantedVotes.length,
    charactersRemaining: player.characterCards.filter((c) => !c.flipped).length,
    eliminated: player.eliminatedAtSeq !== null,
    departed: player.leftAtSeq !== null,
    campRaidBy: player.campRaid?.raiderId ?? null,
    isCurrentPlayer: turn?.playerId === player.id,
    isCouncilLeader: council?.leaderId === player.id,
    isHost: state.hostId === player.id,
    connected: player.connected,
    castaways: player.castaways.map((name, i) => {
      const card = player.characterCards[i];
      return {
        name,
        cardUid: card?.uid ?? null,
        votedOut: card?.flipped ?? false,
        votedOutAtSeq: card?.flippedAtSeq ?? null,
      };
    }),
  };
}

function toPendingView(pending: Pending): PendingView {
  return {
    id: pending.id,
    kind: pending.kind,
    status: pending.status,
    waitingOnIds: waitingOn(pending),
    // THAT a player has submitted is public; WHAT they submitted is the whole point of the card.
    submittedPlayerIds:
      pending.kind === "challenge"
        ? pending.slots.filter((s) => s.submission !== null).map((s) => s.playerId)
        : [],
    count: pendingCount(pending),
    openedAtMs: pending.openedAtMs,
    deadlineMs: pending.deadlineMs,
  };
}

function toCouncilView(state: GameState): CouncilView | null {
  const council = councilOf(state.stage);
  if (!council) return null;
  const votesArePublic = councilPhaseAtOrAfter(council.phase, VOTES_PUBLIC_FROM);
  const inPlay = state.players.filter((p) => isInPlay(p));
  return {
    id: council.id,
    kind: council.kind,
    phase: council.phase,
    drawerId: council.drawerId,
    leaderId: council.leaderId,
    advantagesPlayed: council.advantagesPlayed,
    idolPlays: council.idolPlays,
    nullifierPlays: council.nullifierPlays,
    voteCount: council.votes.length,
    requiredVoterIds: [...new Set(council.requiredCasts.map((c) => c.playerId))],
    remainingVoterIds: inPlay
      .filter((p) => !council.finishedVoting.includes(p.id))
      .map((p) => p.id),
    // The single place the secret ballot becomes public: not before `tally`.
    revealedVotes: votesArePublic ? council.votes : null,
    tally: council.tally,
    flippedThisCouncil: council.flippedThisCouncil,
    eliminationsRemaining: council.eliminationsRemaining,
    phaseDeadlineMs: council.phaseDeadlineMs,
  };
}

function toFinalCouncilView(state: GameState): FinalCouncilView | null {
  const final = finalCouncilOf(state.stage);
  if (!final) return null;
  // "PRIVATE until every juror has voted" — that moment is the "3… 2… 1…" reveal.
  const allIn = final.juryVotes.length >= final.jury.length;
  return {
    phase: final.phase,
    leaderId: final.leaderId,
    finalists: final.finalists,
    jury: final.jury,
    readyJurors: final.readyJurors,
    revealedHands: final.revealedHands,
    castCount: final.juryVotes.length,
    juryVotes: allIn ? final.juryVotes : null,
    winnerId: final.winnerId,
    winnerDecidedByLeaderTieBreak: final.winnerDecidedByLeaderTieBreak,
    phaseDeadlineMs: final.phaseDeadlineMs,
  };
}

export function buildView(state: GameState): GameView {
  const index = cardIndexOf(state);
  const topOfDiscardUid = state.zones.discardPile[state.zones.discardPile.length - 1];
  const councilDistances: number[] = [];
  state.zones.drawPile.forEach((uid, i) => {
    const kind = index.get(uid)?.kind;
    if (
      kind === CardKind.TribalCouncilSingle ||
      kind === CardKind.TribalCouncilDouble
    ) {
      councilDistances.push(i + 1);
    }
  });
  return {
    gameId: state.gameId,
    status: statusOf(state.stage),
    stage: state.stage.kind,
    hostId: state.hostId,
    players: state.players.map((p) => toPublicPlayer(state, p)),
    drawPileSize: state.zones.drawPile.length,
    discardPileSize: state.zones.discardPile.length,
    topOfDiscard: topOfDiscardUid ? (index.get(topOfDiscardUid) ?? null) : null,
    drawsUntilCouncils: councilDistances,
    turn: turnOf(state.stage),
    council: toCouncilView(state),
    finalCouncil: toFinalCouncilView(state),
    openPending: state.pending.map(toPendingView),
    winnerId: winnerIdOf(state.stage),
  };
}

/**
 * What a viewer may see of a window they are a party to.
 *
 * A challenge is a SIMULTANEOUS SECRET submission — "You can discuss what you're going to do
 * before starting, but you don't have to tell the truth!" only means anything if a submission
 * cannot be observed before the reveal. `toPendingView` already redacts the public view; the
 * private view has to redact too, or every player still to show reads what everyone before them
 * threw. Once every slot is filled the round resolves in the same dispatch, so an unredacted
 * open challenge is never anything but a leak.
 */
function redactForViewer(pending: Pending, viewer: PlayerId): Pending {
  if (pending.kind !== "challenge") return pending;
  if (pending.slots.every((s) => s.submission !== null)) return pending;
  return {
    ...pending,
    slots: pending.slots.map((slot) =>
      slot.playerId === viewer
        ? slot
        : { playerId: slot.playerId, submission: null, submittedAtSeq: null },
    ),
  };
}

export function buildPrivateView(
  state: GameState,
  viewer: PlayerId,
): PrivateView | null {
  const player = state.players.find((p) => p.id === viewer);
  if (!player) return null;
  const index = cardIndexOf(state);
  const resolve = (uids: readonly CardUid[]): CardInstance[] =>
    uids.flatMap((uid) => {
      const card = index.get(uid);
      return card ? [card] : [];
    });
  const council = councilOf(state.stage);
  const holdsInheritanceFor = (color: string): boolean =>
    player.hand.some((uid) => {
      const card = index.get(uid);
      return card?.kind === CardKind.Inheritance && colorOf(card) === color;
    });
  return {
    viewer,
    hand: resolve(player.hand),
    voteCards: resolve(player.voteCards),
    grantedVotes: resolve(player.grantedVotes),
    myVotes: council ? council.votes.filter((v) => v.voterId === viewer) : [],
    myPending: state.pending
      .filter((p) => {
        if (p.kind === "inheritance") return holdsInheritanceFor(p.color);
        if (p.kind === "take")
          return p.victimId === viewer || p.takerIds.includes(viewer);
        // A participant who has already submitted drops out of `waitingOn`, but the challenge
        // is still THEIRS: it stays on their private view until it resolves.
        if (p.kind === "challenge") return p.slots.some((s) => s.playerId === viewer);
        return waitingOn(p).includes(viewer);
      })
      .map((p) => redactForViewer(p, viewer)),
    revealedToMe: state.reveals
      .filter((r) => r.viewerId === viewer)
      .map((r) => ({ ownerId: r.ownerId, atSeq: r.atSeq, cards: resolve(r.cardUids) })),
  };
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

/**
 * What this player could legally do right now, with everything a component needs.
 *
 * Bare `ActionKind`s could not build a single button (audit #88): `play_sorry_for_you` needs the
 * id of the specific window (several are open at once by design), `steal_random` needs a target
 * list, `choose_card` needs the option uids.
 */
export function legalActionsFor(
  state: GameState,
  viewer: PlayerId,
  nowMs: number,
): readonly LegalAction[] {
  void nowMs;
  const out: LegalAction[] = [];
  const player = state.players.find((p) => p.id === viewer);
  const index = cardIndexOf(state);
  const kindsInHand = (kind: CardKind): CardUid[] =>
    player ? player.hand.filter((uid) => index.get(uid)?.kind === kind) : [];
  const add = (kind: ActionKind, extra?: Omit<LegalAction, "kind">): void => {
    out.push({ kind, ...extra });
  };

  if (state.stage.kind === "lobby") {
    if (!player) add("join_game");
    else {
      add("choose_color");
      add("name_castaways");
      add("leave_game");
      if (state.players.length >= state.config.limits.minPlayers) add("start_game");
    }
    if (viewer === state.hostId) {
      add("abandon_game");
      const others = state.players.filter((p) => p.id !== viewer).map((p) => p.id);
      if (others.length > 0) add("transfer_host", { legalTargets: others });
    }
    return out;
  }
  if (!player || !isInPlay(player)) {
    // A Tribal Council Leader eliminated by their own council is STILL the Leader — the
    // rulebook never removes the role — and a Double Elimination's second `leader_decision` is
    // addressed to them. Offering them nothing left an open window nobody in the game could
    // answer, which is a hard deadlock rather than a missing button.
    for (const pending of state.pending) {
      if (pending.kind === "leader_decision" && pending.leaderId === viewer) {
        add("leader_choose_eliminations", {
          pendingId: pending.id,
          legalTargets: pending.candidates,
          chooseCount: pending.choose,
          deadlineMs: pending.deadlineMs,
        });
      }
    }
    // Jurors still act at the Final Tribal Council.
    if (state.stage.kind === "final_council" && player) {
      const final = state.stage.finalCouncil;
      if (final.jury.includes(viewer)) {
        // The ready-check is what OPENS the vote: it is meaningless once it has.
        if (
          !final.readyJurors.includes(viewer) &&
          !finalPhaseAtOrAfter(final.phase, "jury_vote")
        )
          add("juror_ready");
        if (
          final.phase === "jury_vote" &&
          !final.juryVotes.some((v) => v.jurorId === viewer)
        ) {
          add("cast_jury_vote", { legalTargets: final.finalists });
        }
        if (final.phase === "tie_break" && final.leaderId === viewer) {
          add("final_leader_break_tie", { legalTargets: final.finalists });
        }
        if (final.leaderId === viewer && nextFinalPhase(final.phase)) {
          add("advance_final_council", { fromPhase: final.phase });
        }
      }
    }
    return out;
  }
  if (viewer === state.hostId) add("abandon_game");

  const inPlayIds = state.players
    .filter((p) => isInPlay(p) && p.id !== viewer)
    .map((p) => p.id);

  // Host housekeeping, offered wherever `abandon_game` is: a host who is about to go quiet
  // mid-game should be able to hand the role over without leaving the table.
  if (viewer === state.hostId && inPlayIds.length > 0)
    add("transfer_host", { legalTargets: inPlayIds });

  // Open windows first: a reaction beats whatever else is on offer.
  for (const pending of state.pending) {
    switch (pending.kind) {
      case "take":
        if (pending.victimId === viewer) {
          const sorry = kindsInHand(CardKind.SorryForYou);
          if (sorry.length > 0) {
            add("play_sorry_for_you", {
              pendingId: pending.id,
              playableCardUids: sorry,
              deadlineMs: pending.deadlineMs,
            });
          }
          add("decline_reaction", {
            pendingId: pending.id,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "discard":
        if (pending.playerId === viewer) {
          add("discard_card", {
            pendingId: pending.id,
            playableCardUids: player.hand,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "challenge":
        if (pending.slots.some((s) => s.playerId === viewer && s.submission === null)) {
          add("submit_challenge_choice", {
            pendingId: pending.id,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "card_choice":
        if (pending.chooserId === viewer && pending.chosen === null) {
          add("choose_card", {
            pendingId: pending.id,
            optionCardUids: pending.options,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "alliance_target":
        if (pending.partnerId === viewer) {
          add("choose_alliance_target", {
            pendingId: pending.id,
            legalTargets: inPlayIds.filter(
              (id) => !pending.forbiddenTargets.includes(id),
            ),
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "steal_victim":
        if (pending.chooserId === viewer) {
          add("choose_steal_victim", {
            pendingId: pending.id,
            legalTargets: inPlayIds,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "leader_decision":
        if (pending.leaderId === viewer) {
          add("leader_choose_eliminations", {
            pendingId: pending.id,
            legalTargets: pending.candidates,
            chooseCount: pending.choose,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      case "inheritance": {
        const held = player.hand.filter((uid) => {
          const card = index.get(uid);
          return card?.kind === CardKind.Inheritance && colorOf(card) === pending.color;
        });
        if (held.length > 0) {
          add("play_inheritance", {
            pendingId: pending.id,
            playableCardUids: held,
            deadlineMs: pending.deadlineMs,
          });
          add("decline_reaction", {
            pendingId: pending.id,
            deadlineMs: pending.deadlineMs,
          });
        }
        break;
      }
      default:
        assertNever(pending, "legalActionsFor");
    }
  }

  const stage = state.stage;
  if (
    stage.kind === "turn" &&
    stage.turn.playerId === viewer &&
    state.pending.length === 0
  ) {
    const turn = stage.turn;
    if (turn.phase === "steal") {
      // With `allowStealFromEmptyHand` off, an empty-handed target is not a legal steal, so the
      // renderer must not offer the button (audit #88: dead components stayed enabled).
      const stealable = state.config.houseRules.allowStealFromEmptyHand
        ? inPlayIds
        : state.players
            .filter((p) => isInPlay(p) && p.id !== viewer && p.hand.length > 0)
            .map((p) => p.id);
      add("steal_random", { legalTargets: stealable });
    }
    if (turn.phase === "play") {
      add("skip_play_step");
      const playable: readonly [CardKind, ActionKind][] = [
        [CardKind.CampRaid, "play_camp_raid"],
        [CardKind.KnowledgeIsPower, "play_knowledge_is_power"],
        [CardKind.TheSpyShack, "play_spy_shack"],
        [CardKind.LetsFormAnAlliance, "play_lets_form_an_alliance"],
        [CardKind.DoOrDie, "play_do_or_die"],
        [CardKind.PowerPair, "play_power_pair"],
        [CardKind.ItsANumbersGame, "play_its_a_numbers_game"],
      ];
      for (const [kind, actionKind] of playable) {
        const uids = kindsInHand(kind);
        if (uids.length === 0) continue;
        if (kind === CardKind.CampRaid) {
          // "any player" — yourself included; see `play_camp_raid`.
          const targets = state.players
            .filter((p) => isInPlay(p) && p.campRaid === null)
            .map((p) => p.id);
          if (targets.length === 0) continue;
          add(actionKind, { playableCardUids: uids, legalTargets: targets });
          continue;
        }
        add(actionKind, { playableCardUids: uids, legalTargets: inPlayIds });
      }
    }
    if (turn.phase === "draw") add("draw_card");
  }

  const council = councilOf(state.stage);
  if (council) {
    // "Everyone must vote." `reduce` refuses `advance_council` out of `voting` with
    // `must_cast_mandatory_vote` while anything is outstanding, so offering it here was a
    // guaranteed dead button (audit #88) — and the identical guard is already applied to
    // `finish_voting` a few lines below.
    const votingIsBlocked =
      council.phase === "voting" && council.requiredCasts.length > 0;
    if (
      council.leaderId === viewer &&
      leaderAdvanceableFrom(council.phase) &&
      !votingIsBlocked
    ) {
      add("advance_council", {
        fromPhase: council.phase,
        deadlineMs: council.phaseDeadlineMs,
      });
    }
    if (council.phase === "advantages" || council.phase === "discussion") {
      const ctv = kindsInHand(CardKind.ControlTheVote);
      if (ctv.length > 0) {
        add("play_control_the_vote", {
          playableCardUids: ctv,
          legalTargets: state.players
            .filter((p) => isInPlay(p) && p.id !== viewer && p.voteCards.length > 0)
            .map((p) => p.id),
        });
      }
      const gg = kindsInHand(CardKind.GoodwillGamble);
      if (gg.length > 0)
        add("play_goodwill_gamble", { playableCardUids: gg, legalTargets: inPlayIds });
      const leader = kindsInHand(CardKind.ImTheLeaderNow);
      if (leader.length > 0)
        add("play_im_the_leader_now", { playableCardUids: leader });
    }
    if (council.phase === "voting" && !council.finishedVoting.includes(viewer)) {
      const owed = council.requiredCasts.filter((c) => c.playerId === viewer);
      const castable = [
        ...owed.map((o) => o.cardUid),
        ...kindsInHand(CardKind.ExtraVote),
      ];
      const targets = state.players
        .filter(
          (p) =>
            (isInPlay(p) || state.config.houseRules.allowVotingForEliminatedPlayer) &&
            (state.config.houseRules.allowSelfVote || p.id !== viewer),
        )
        .map((p) => p.id);
      if (castable.length > 0)
        add("cast_vote", { playableCardUids: castable, legalTargets: targets });
      if (owed.length === 0 && !council.finishedVoting.includes(viewer))
        add("finish_voting");
    }
    if (council.phase === "idols") {
      const idols = kindsInHand(CardKind.ImmunityIdol);
      if (idols.length > 0)
        add("play_immunity_idol", {
          playableCardUids: idols,
          legalTargets: state.players.filter((p) => isInPlay(p)).map((p) => p.id),
        });
    }
    if (council.phase === "nullifiers") {
      const nullifiers = kindsInHand(CardKind.IdolNullifier);
      if (nullifiers.length > 0)
        add("play_idol_nullifier", { playableCardUids: nullifiers });
    }
  }

  const final = finalCouncilOf(state.stage);
  if (final) {
    if (final.leaderId === viewer && nextFinalPhase(final.phase))
      add("advance_final_council", { fromPhase: final.phase });
    if (final.finalists.includes(viewer) && !final.revealedHands.includes(viewer)) {
      add("reveal_hand");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export function nextDeadlineOf(state: GameState): DeadlineInfo | null {
  let best: DeadlineInfo | null = null;
  const consider = (info: DeadlineInfo | null): void => {
    if (!info) return;
    if (!best || info.atMs < best.atMs) best = info;
  };
  for (const pending of state.pending) {
    consider({ atMs: pending.deadlineMs, reason: pending.kind, pendingId: pending.id });
  }
  // MIRROR `advance`'s own guard. `turnOf` also answers during a council, where `stage.turn` is
  // only the historical record of the interrupted turn — "a Tribal Council happens at the end of
  // your turn", so that turn has nothing left to expire. Nominating a deadline `advance` will
  // not act on puts a caller that schedules its single timer against `nextDeadline()` — the
  // documented contract — into a hot loop on an already-expired timestamp.
  const turn = turnOf(state.stage);
  if (
    state.stage.kind === "turn" &&
    turn &&
    turn.deadlineMs !== null &&
    state.pending.length === 0
  ) {
    consider({ atMs: turn.deadlineMs, reason: "turn", pendingId: null });
  }
  const council = councilOf(state.stage);
  if (council && council.phaseDeadlineMs !== null) {
    consider({
      atMs: council.phaseDeadlineMs,
      reason: "council_phase",
      pendingId: null,
    });
  }
  const final = finalCouncilOf(state.stage);
  if (final && final.phaseDeadlineMs !== null) {
    consider({
      atMs: final.phaseDeadlineMs,
      reason: "final_council_phase",
      pendingId: null,
    });
  }
  return best;
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

class GameImpl implements Game {
  #state: GameState;
  /** Events produced by creation or restore, which have no dispatch of their own to ride on. */
  #queued: GameEvent[];
  #index: Map<CardUid, CardInstance>;

  constructor(state: GameState, queued: readonly GameEvent[]) {
    this.#state = state;
    this.#queued = [...queued];
    this.#index = cardIndexOf(state);
  }

  get id(): GameState["gameId"] {
    return this.#state.gameId;
  }

  get config(): EngineConfig {
    return this.#state.config;
  }

  state(): GameState {
    return this.#state;
  }

  snapshot(): GameSnapshot {
    return createSnapshot(this.#state, this.#state.createdAtMs + this.#state.seq);
  }

  dispatch(action: Action, nowMs: number): Result<DispatchOutcome> {
    const result = reduce(this.#state, action, nowMs);
    if (!result.ok) return result;
    return ok(this.#commit(result.value));
  }

  tick(nowMs: number): Result<DispatchOutcome> {
    return ok(this.#commit(advance(this.#state, nowMs)));
  }

  view(): GameView {
    return buildView(this.#state);
  }

  privateView(viewer: PlayerId): PrivateView | null {
    return buildPrivateView(this.#state, viewer);
  }

  card(uid: CardUid): CardInstance | null {
    return this.#index.get(uid) ?? null;
  }

  cards(uids: readonly CardUid[]): readonly CardInstance[] {
    return uids.flatMap((uid) => {
      const card = this.#index.get(uid);
      return card ? [card] : [];
    });
  }

  legalActions(player: PlayerId, nowMs: number): readonly LegalAction[] {
    return legalActionsFor(this.#state, player, nowMs);
  }

  nextDeadline(): DeadlineInfo | null {
    return nextDeadlineOf(this.#state);
  }

  #commit(outcome: DispatchOutcome): DispatchOutcome {
    this.#state = outcome.state;
    if (outcome.state.cards.length !== this.#index.size) {
      this.#index = cardIndexOf(outcome.state);
    }
    if (this.#queued.length === 0) return outcome;
    const events = [...this.#queued, ...outcome.events];
    this.#queued = [];
    return { events, state: outcome.state, changed: outcome.changed };
  }
}

export const createGame = (params: CreateGameParams): Game => {
  const rng = createRng(params.seed);
  const state: GameState = {
    gameId: params.gameId,
    hostId: params.hostId,
    stage: { kind: "lobby" },
    config: params.config,
    rng: rng.state(),
    seq: 1,
    players: [],
    cards: [],
    zones: {
      drawPile: [],
      discardPile: [],
      removedFromGame: [],
      voteCardBank: [],
      votingBox: [],
      inPlay: [],
    },
    pending: [],
    reveals: [],
    playerCount: null,
    createdAtMs: params.nowMs,
    startedAtMs: null,
  };
  return new GameImpl(state, [
    {
      type: "game_created",
      gameId: params.gameId,
      seq: 1,
      atMs: params.nowMs,
      audience: { kind: "public" },
    },
  ]);
};

/**
 * Restore from a validated snapshot.
 *
 * NO config parameter, deliberately: `snapshot.state.config` is authoritative, which is the
 * entire reason `EngineConfig` is embedded in `GameState`. A game started under
 * `allowSelfVote: true` keeps allowing self-votes after a restart even if the deployment has
 * since flipped the flag.
 */
/**
 * The most recent wall-clock reading anywhere in a state: when the engine was last driven.
 *
 * `GameSnapshot.savedAtMs` cannot answer this — it is `createdAtMs + seq`, a deterministic
 * stamp chosen so a snapshot round-trips byte for byte, not a clock reading. Every value below
 * IS a real `nowMs` that was passed into a dispatch, so their maximum is the last moment the
 * game was actually touched.
 */
function lastTouchedAtMs(state: GameState): number {
  let latest = state.createdAtMs;
  for (const pending of state.pending) {
    if (pending.openedAtMs > latest) latest = pending.openedAtMs;
  }
  const stage = state.stage;
  if (stage.kind === "turn" || stage.kind === "council") {
    if (stage.turn.startedAtMs > latest) latest = stage.turn.startedAtMs;
  }
  if (stage.kind === "council" && stage.council.phaseEnteredAtMs > latest) {
    latest = stage.council.phaseEnteredAtMs;
  }
  if (stage.kind === "final_council" && stage.finalCouncil.phaseEnteredAtMs > latest) {
    latest = stage.finalCouncil.phaseEnteredAtMs;
  }
  return latest;
}

/**
 * Move every open deadline forward by however long the game was away.
 *
 * Deadlines are absolute epoch milliseconds, and a restore used to rebase NOTHING — so a deploy
 * or a crash-restart longer than the shortest window (a `take` is 20s; `challenge`, `discard`,
 * `card_choice`, `alliance_target` and `steal_victim` are 60s each) expired every open window
 * the instant the game came back, before a single player could press anything. The session arms
 * its tick timer in its constructor, `advance()` expires every overdue pending in one pass, and
 * the council then cascaded one phase per second: a player holding an Immunity Idol could watch
 * the whole council resolve in three seconds, having never been given a pressable window.
 *
 * The shift is `nowMs - lastTouchedAtMs(state)`, which makes the guarantee easy to state and
 * self-bounding: after a restore, an open window has `deadlineMs - lastTouched` milliseconds
 * left, and since `lastTouched >= openedAtMs` that is never more than the window's own
 * configured duration. No window is ever silently shortened, none is ever extended past a fresh
 * one, and the engine needs no config and no second clock reading to do it.
 *
 * A deadline already in the past relative to `lastTouched` is genuinely overdue and stays
 * overdue: the first tick after the restore should close it.
 */
function rebaseDeadlines(state: GameState, nowMs: number): GameState {
  const anchor = lastTouchedAtMs(state);
  const downtime = nowMs - anchor;
  if (downtime <= 0) return state;
  const shift = (at: number): number => at + downtime;
  const shiftOrNull = (at: number | null): number | null =>
    at === null ? null : shift(at);

  const pending = state.pending.map((p) => ({ ...p, deadlineMs: shift(p.deadlineMs) }));
  const stage = state.stage;
  let rebasedStage: GameStage = stage;
  switch (stage.kind) {
    case "turn":
      rebasedStage = {
        ...stage,
        turn: { ...stage.turn, deadlineMs: shiftOrNull(stage.turn.deadlineMs) },
      };
      break;
    case "council":
      rebasedStage = {
        ...stage,
        turn: { ...stage.turn, deadlineMs: shiftOrNull(stage.turn.deadlineMs) },
        council: {
          ...stage.council,
          phaseDeadlineMs: shiftOrNull(stage.council.phaseDeadlineMs),
        },
      };
      break;
    case "final_council":
      rebasedStage = {
        ...stage,
        finalCouncil: {
          ...stage.finalCouncil,
          phaseDeadlineMs: shiftOrNull(stage.finalCouncil.phaseDeadlineMs),
        },
      };
      break;
    case "lobby":
    case "finished":
    case "abandoned":
      break;
    default:
      assertNever(stage, "rebaseDeadlines");
  }
  return { ...state, pending, stage: rebasedStage };
}

/**
 * Bring a saved game back.
 *
 * `nowMs` is optional ONLY so the snapshot round-trip tests can restore a state byte-for-byte.
 * Every production caller passes the clock, and passing it is what rebases the open windows —
 * see `rebaseDeadlines`.
 */
export const restoreGame = (snapshot: GameSnapshot, nowMs?: number): Result<Game> => {
  const state =
    nowMs === undefined ? snapshot.state : rebaseDeadlines(snapshot.state, nowMs);
  const problems = auditCensus(
    state.cards,
    state.players.map((p) => ({
      id: p.id,
      hand: p.hand,
      voteCards: p.voteCards,
      grantedVotes: p.grantedVotes,
      characterCards: p.characterCards,
    })),
    state.zones,
  );
  if (problems.length > 0) {
    return err(
      "snapshot_card_census_mismatch",
      `restored state does not balance: ${problems.length} problem(s)`,
      { problems: problems.length },
    );
  }
  // `snapshot_restored` carries its own `seq`, which doubles as the event envelope's — the
  // restored game continues the same monotonic sequence rather than starting a new one.
  const restored: GameEvent = {
    type: "snapshot_restored",
    schemaVersion: snapshot.schemaVersion,
    seq: state.seq,
    savedAtMs: snapshot.savedAtMs,
    lastPlayedAtMs: lastTouchedAtMs(snapshot.state),
    // How far every open window was pushed out, so the table can see what the restart did to
    // their clock rather than watching a council resolve itself in three seconds.
    rebasedByMs:
      nowMs === undefined ? 0 : Math.max(0, nowMs - lastTouchedAtMs(snapshot.state)),
    atMs: snapshot.savedAtMs,
    audience: { kind: "public" },
  };
  return ok(new GameImpl(state, [restored]));
};

/** Exposed for the census test and for `/debug`. */
export const censusOf = (state: GameState): readonly unknown[] =>
  auditCensus(
    state.cards,
    state.players.map((p) => ({
      id: p.id,
      hand: p.hand,
      voteCards: p.voteCards,
      grantedVotes: p.grantedVotes,
      characterCards: p.characterCards,
    })),
    state.zones,
  );
