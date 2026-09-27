/**
 * Players: construction, the liveness predicates, and turn order.
 *
 * Everything here is a QUERY or a constructor. The effectful side of a player's life — flipping
 * a Survivor Character Card, full elimination, leaving the table — lives in `final.ts`, next to
 * the single `afterPlayerCountChanged()` predicate it has to call, because audit #14 is exactly
 * "the Final Tribal Council trigger fires on only one of four elimination paths" and the fix is
 * to keep the flip and the check in one file rather than to remember four call sites.
 *
 * Turn order is seat order and play proceeds to the LEFT (ascending seat), skipping anyone not
 * `isInPlay` — audit #10/#23/#24: eliminated and departed players were still dealt turns, still
 * legal steal targets, and still blocked a council from closing.
 */

import type { PlayerCount } from "../config.js";
import { emitPublic, type Ctx, type DraftPlayer } from "./draft.js";
import {
  ALL_PLAYER_COLORS,
  isInPlay,
  isJuror,
  type CharacterCard,
  type PlayerColor,
  type PlayerId,
  type TurnState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createPlayer(params: {
  readonly id: PlayerId;
  readonly displayName: string;
  readonly color: PlayerColor;
  readonly seat: number;
  /** `limits.characterCardsPerPlayer`: one castaway per Survivor Character Card. */
  readonly castawaySlots: number;
}): DraftPlayer {
  return {
    id: params.id,
    displayName: params.displayName,
    color: params.color,
    seat: params.seat,
    // Filled at `start_game`: the two Survivor Character Cards of that colour do not exist as
    // instances until the deck is built.
    characterCards: [],
    hand: [],
    voteCards: [],
    grantedVotes: [],
    campRaid: null,
    eliminatedAtSeq: null,
    leftAtSeq: null,
    connected: true,
    // Unpicked until the player names them; `start_game` deals a legend into every blank.
    castaways: Array.from({ length: params.castawaySlots }, () => null),
  };
}

export const newCharacterCard = (uid: CharacterCard["uid"]): CharacterCard => ({
  uid,
  flipped: false,
  flippedAtSeq: null,
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findPlayer(ctx: Ctx, id: PlayerId): DraftPlayer | null {
  return ctx.players.find((p) => p.id === id) ?? null;
}

export function requirePlayer(ctx: Ctx, id: PlayerId): DraftPlayer {
  const player = findPlayer(ctx, id);
  if (!player) throw new Error(`requirePlayer: ${id} is not in this game`);
  return player;
}

export function playersInPlay(ctx: Ctx): DraftPlayer[] {
  return ctx.players.filter((p) => isInPlay(p)).sort((a, b) => a.seat - b.seat);
}

export function jurors(ctx: Ctx): DraftPlayer[] {
  return ctx.players
    .filter((p) => isJuror(p))
    .sort((a, b) => (a.eliminatedAtSeq ?? 0) - (b.eliminatedAtSeq ?? 0));
}

export function isColorTaken(ctx: Ctx, color: PlayerColor): boolean {
  return ctx.players.some((p) => p.color === color);
}

export function firstFreeColor(ctx: Ctx): PlayerColor | null {
  return ALL_PLAYER_COLORS.find((c) => !isColorTaken(ctx, c)) ?? null;
}

// ---------------------------------------------------------------------------
// Character cards
// ---------------------------------------------------------------------------

export const charactersRemaining = (player: DraftPlayer): number =>
  player.characterCards.filter((c) => !c.flipped).length;

export const nextUnflippedCharacter = (player: DraftPlayer): CharacterCard | null =>
  player.characterCards.find((c) => !c.flipped) ?? null;

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/**
 * The next player clockwise from a seat, skipping everyone not in play.
 *
 * `fromSeat` is a SEAT, not a player, so this still answers correctly when the player who used
 * to sit there has just been eliminated — which is the case "I'm the Leader Now" hits when its
 * player is voted out at the very council they seized ("or the player after you if you are
 * eliminated").
 */
export function nextInPlayFromSeat(ctx: Ctx, fromSeat: number): DraftPlayer | null {
  const alive = playersInPlay(ctx);
  if (alive.length === 0) return null;
  const ahead = alive.find((p) => p.seat > fromSeat);
  return ahead ?? alive[0] ?? null;
}

/**
 * Who the host role passes to when the host is no longer at the table.
 *
 * The next seat round from theirs, by the same clockwise rule the turn uses, so "who is running
 * this now" has the same obvious answer as "who plays next". Someone still IN PLAY first — the
 * person who may press Begin, remove a player or end the game should be somebody still in the
 * game — then anyone still seated, because a table of jurors at a wedged Final Tribal Council
 * still needs one of them able to end it. `null` only when the last player has just left, which
 * is a lobby the caller then disposes of.
 *
 * `fromSeat` is a SEAT, and the outgoing host is excluded by id, so this answers correctly both
 * in a lobby (where leaving re-seats everyone, and the successor now HOLDS `fromSeat`) and
 * mid-game (where a departed player keeps their seat forever).
 */
export function nextHostFromSeat(
  ctx: Ctx,
  fromSeat: number,
  excludeId: PlayerId,
): DraftPlayer | null {
  const candidates = ctx.players
    .filter((p) => p.id !== excludeId)
    .sort((a, b) => a.seat - b.seat);
  const clockwise = (pool: readonly DraftPlayer[]): DraftPlayer | null =>
    pool.find((p) => p.seat >= fromSeat) ?? pool[0] ?? null;
  return (
    clockwise(candidates.filter((p) => isInPlay(p))) ??
    clockwise(candidates.filter((p) => p.leftAtSeq === null))
  );
}

export function nextInPlayAfter(ctx: Ctx, playerId: PlayerId): DraftPlayer | null {
  const player = findPlayer(ctx, playerId);
  if (!player) return null;
  return nextInPlayFromSeat(ctx, player.seat);
}

/**
 * Legal targets for the turn steal: in play, not the actor, and — when the table has
 * `allowStealFromEmptyHand` off — actually holding something.
 *
 * The house rule is consulted HERE so the reducer, `legalActionsFor` and the turn backstop
 * cannot give three different answers to one disclosed setting (RULES.md:313).
 */
export function stealTargets(ctx: Ctx, actor: PlayerId): DraftPlayer[] {
  const allowEmpty = ctx.config.houseRules.allowStealFromEmptyHand;
  return playersInPlay(ctx).filter(
    (p) => p.id !== actor && (allowEmpty || p.hand.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Turn handover
// ---------------------------------------------------------------------------

/**
 * Start a turn at step 1. `phase: "steal"` with `stealResolved: false` is what makes the
 * mandatory steal mandatory: `play` is simply unreachable until the steal window closes
 * (rulebook: "Remember: Steal, Play (or don't), then Draw!", audit #9).
 *
 * Lives here rather than in `game.ts` because the Tribal Council cleanup also hands off a turn,
 * and `tribal.ts` cannot import `game.ts` without a cycle.
 */
export function beginTurn(ctx: Ctx, player: DraftPlayer, turnNumber: number): void {
  const deadlineMs = ctx.nowMs + ctx.config.timings.turnSafetyTimeout;
  ctx.stage = {
    kind: "turn",
    turn: {
      playerId: player.id,
      phase: "steal",
      stealResolved: false,
      cardPlayedThisTurn: null,
      startedAtMs: ctx.nowMs,
      deadlineMs,
      turnNumber,
    },
  };
  emitPublic(ctx, {
    type: "turn_started",
    playerId: player.id,
    turnNumber,
    deadlineMs,
  });
}

export function handOffTurn(ctx: Ctx, from: TurnState, next: DraftPlayer | null): void {
  emitPublic(ctx, {
    type: "turn_ended",
    playerId: from.playerId,
    drawPileRemaining: ctx.zones.drawPile.length,
    nextPlayerId: next?.id ?? null,
  });
  if (next) beginTurn(ctx, next, from.turnNumber + 1);
}

// ---------------------------------------------------------------------------
// Player count
// ---------------------------------------------------------------------------

export function asPlayerCount(n: number): PlayerCount | null {
  return n === 3 || n === 4 || n === 5 || n === 6 ? n : null;
}
