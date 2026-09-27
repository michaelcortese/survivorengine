/**
 * The mutation context every rule module writes through.
 *
 * WHY THIS FILE EXISTS (it is not named in the contract): `reduce` must be able to reject an
 * action without leaving a fingerprint — audit #49, "checkForError() mutated player hands while
 * validating, so every rejected command permanently destroyed a card". The mechanism here is
 * structural rather than disciplinary: `createCtx` deep-copies every mutable part of
 * `GameState`, every rule module mutates only the copy, and a rejected action simply throws the
 * copy away and hands the caller back the state object it already had. Nothing in the engine
 * can mutate a `GameState`, because `GameState` is readonly all the way down and the draft is a
 * different object.
 *
 * The second job is event emission. `emitPublic` / `emitTo` are the ONLY way to append an event,
 * and each one asserts the event's audience against `EVENT_AUDIENCE_POLICY` — so audit
 * #119/#126 ("visibility decided ad hoc at 26 call sites") cannot come back through a typo at an
 * emit site. `seq` is stamped here too, once, so every event and every ordering field in state
 * comes from one monotonic counter.
 */

import type { EngineConfig } from "../config.js";
import {
  EVENT_AUDIENCE_POLICY,
  PUBLIC,
  onlyFor,
  type EventMeta,
  type GameEvent,
  type GameEventBody,
} from "./events.js";
import { restoreRng, type Rng } from "./rng.js";
import {
  asCouncilId,
  asEffectId,
  asPendingId,
  type CampRaidMarker,
  type CardInstance,
  type CardUid,
  type CharacterCard,
  type CouncilId,
  type CouncilState,
  type EffectId,
  type FinalCouncilState,
  type GameId,
  type GameStage,
  type GameState,
  type Pending,
  type PendingId,
  type Player,
  type PlayerColor,
  type PlayerCount,
  type PlayerId,
  type RevealRecord,
  type TurnState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Draft shapes
// ---------------------------------------------------------------------------

/**
 * A player, mutable. Structurally assignable to `Player` (a mutable array satisfies a
 * `readonly` one), so `finalize` needs no copy pass and no cast.
 */
export interface DraftPlayer {
  id: PlayerId;
  displayName: string;
  color: PlayerColor;
  seat: number;
  characterCards: CharacterCard[];
  hand: CardUid[];
  voteCards: CardUid[];
  grantedVotes: CardUid[];
  campRaid: CampRaidMarker | null;
  eliminatedAtSeq: number | null;
  leftAtSeq: number | null;
  connected: boolean;
  castaways: (string | null)[];
}

/** The six zones, mutable. Same assignability trick as `DraftPlayer`. */
export interface DraftZones {
  drawPile: CardUid[];
  discardPile: CardUid[];
  removedFromGame: CardUid[];
  voteCardBank: CardUid[];
  votingBox: CardUid[];
  inPlay: CardUid[];
}

export type ZoneKey = keyof DraftZones;

export const ALL_ZONE_KEYS: readonly ZoneKey[] = [
  "drawPile",
  "discardPile",
  "removedFromGame",
  "voteCardBank",
  "votingBox",
  "inPlay",
];

export interface Ctx {
  readonly nowMs: number;
  readonly config: EngineConfig;
  readonly gameId: GameId;
  hostId: PlayerId;
  stage: GameStage;
  players: DraftPlayer[];
  cards: CardInstance[];
  /** uid -> instance. Rebuilt only when cards are minted, which happens once, at setup. */
  index: Map<CardUid, CardInstance>;
  zones: DraftZones;
  pending: Pending[];
  reveals: RevealRecord[];
  rng: Rng;
  seq: number;
  playerCount: PlayerCount | null;
  readonly createdAtMs: number;
  startedAtMs: number | null;
  readonly events: GameEvent[];
}

const clonePlayer = (p: Player): DraftPlayer => ({
  id: p.id,
  displayName: p.displayName,
  color: p.color,
  seat: p.seat,
  characterCards: [...p.characterCards],
  hand: [...p.hand],
  voteCards: [...p.voteCards],
  grantedVotes: [...p.grantedVotes],
  campRaid: p.campRaid,
  eliminatedAtSeq: p.eliminatedAtSeq,
  leftAtSeq: p.leftAtSeq,
  connected: p.connected,
  castaways: [...p.castaways],
});

/**
 * Deep-copy the mutable spine of a state. Card instances, pendings, council/turn/final-council
 * records and reveal records are treated as immutable values and replaced wholesale rather than
 * edited in place, so a shallow array copy is enough for those.
 */
export function createCtx(state: GameState, nowMs: number): Ctx {
  return {
    nowMs,
    config: state.config,
    gameId: state.gameId,
    hostId: state.hostId,
    stage: state.stage,
    players: state.players.map(clonePlayer),
    cards: [...state.cards],
    index: new Map(state.cards.map((c) => [c.uid, c])),
    zones: {
      drawPile: [...state.zones.drawPile],
      discardPile: [...state.zones.discardPile],
      removedFromGame: [...state.zones.removedFromGame],
      voteCardBank: [...state.zones.voteCardBank],
      votingBox: [...state.zones.votingBox],
      inPlay: [...state.zones.inPlay],
    },
    pending: [...state.pending],
    reveals: [...state.reveals],
    rng: restoreRng(state.rng),
    seq: state.seq,
    playerCount: state.playerCount,
    createdAtMs: state.createdAtMs,
    startedAtMs: state.startedAtMs,
    events: [],
  };
}

/** Assemble the readonly state the caller receives. */
export function finalize(ctx: Ctx): GameState {
  return {
    gameId: ctx.gameId,
    hostId: ctx.hostId,
    stage: ctx.stage,
    config: ctx.config,
    rng: ctx.rng.state(),
    seq: ctx.seq,
    players: ctx.players,
    cards: ctx.cards,
    zones: ctx.zones,
    pending: ctx.pending,
    reveals: ctx.reveals,
    playerCount: ctx.playerCount,
    createdAtMs: ctx.createdAtMs,
    startedAtMs: ctx.startedAtMs,
  };
}

// ---------------------------------------------------------------------------
// Sequence stamps and identifiers
// ---------------------------------------------------------------------------

/** The one monotonic counter. Every event seq and every `*AtSeq` field comes from here. */
export function stamp(ctx: Ctx): number {
  ctx.seq += 1;
  return ctx.seq;
}

export const newPendingId = (ctx: Ctx): PendingId => asPendingId(`pnd-${stamp(ctx)}`);
export const newEffectId = (ctx: Ctx): EffectId => asEffectId(`eff-${stamp(ctx)}`);
export const newCouncilId = (ctx: Ctx): CouncilId => asCouncilId(`tc-${stamp(ctx)}`);

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

/**
 * `GameEvent` is `WithMeta<GameEventBody>`, a union distributed member by member. Stamping the
 * envelope onto a body happens HERE and nowhere else, which is why every emit site can stay
 * cast-free — and why `emitPublic`/`emitTo` are the only two doors into `ctx.events`.
 */
function withMeta<T extends GameEventBody>(body: T, meta: EventMeta): GameEvent {
  return { ...meta, ...body };
}

/**
 * Emit a table-visible event. Throws if the type is declared private in
 * `EVENT_AUDIENCE_POLICY` — an emit-site typo is an invariant break, not a rule violation.
 */
export function emitPublic<T extends GameEventBody>(ctx: Ctx, body: T): void {
  if (EVENT_AUDIENCE_POLICY[body.type] !== "public") {
    throw new Error(
      `emitPublic: ${body.type} is declared private by EVENT_AUDIENCE_POLICY`,
    );
  }
  ctx.events.push(
    withMeta(body, { seq: stamp(ctx), atMs: ctx.nowMs, audience: PUBLIC }),
  );
}

/** Emit an event only these players may see. Throws if the type is declared public. */
export function emitTo<T extends GameEventBody>(
  ctx: Ctx,
  body: T,
  ...playerIds: readonly PlayerId[]
): void {
  if (EVENT_AUDIENCE_POLICY[body.type] !== "private") {
    throw new Error(`emitTo: ${body.type} is declared public by EVENT_AUDIENCE_POLICY`);
  }
  ctx.events.push(
    withMeta(body, {
      seq: stamp(ctx),
      atMs: ctx.nowMs,
      audience: onlyFor(...playerIds),
    }),
  );
}

// ---------------------------------------------------------------------------
// Stage patching
// ---------------------------------------------------------------------------

export function patchTurn(ctx: Ctx, patch: Partial<TurnState>): void {
  const stage = ctx.stage;
  if (stage.kind === "turn") {
    ctx.stage = { kind: "turn", turn: { ...stage.turn, ...patch } };
    return;
  }
  if (stage.kind === "council") {
    ctx.stage = {
      kind: "council",
      turn: { ...stage.turn, ...patch },
      council: stage.council,
    };
    return;
  }
  throw new Error(`patchTurn: stage ${stage.kind} holds no turn`);
}

export function patchCouncil(ctx: Ctx, patch: Partial<CouncilState>): void {
  const stage = ctx.stage;
  if (stage.kind !== "council") {
    throw new Error(`patchCouncil: stage ${stage.kind} holds no council`);
  }
  ctx.stage = {
    kind: "council",
    turn: stage.turn,
    council: { ...stage.council, ...patch },
  };
}

export function patchFinalCouncil(ctx: Ctx, patch: Partial<FinalCouncilState>): void {
  const stage = ctx.stage;
  if (stage.kind !== "final_council") {
    throw new Error(`patchFinalCouncil: stage ${stage.kind} holds no final council`);
  }
  ctx.stage = {
    kind: "final_council",
    finalCouncil: { ...stage.finalCouncil, ...patch },
  };
}
