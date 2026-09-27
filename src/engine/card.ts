/**
 * Card identity, the card registry, and every legal way a card can move.
 *
 * Audit #121: "Deck's constructor pushes the SAME Card object for every copy of a card, so no
 * card in the game has an identity — which is the root cause of every index-based selection
 * bug." Every physical card is minted exactly once here, with a uid that is unique for the life
 * of the game, and after that NOTHING in the engine identifies a card by name, by array index or
 * by object reference. Zones and hands hold uids; this module owns the registry that turns a uid
 * back into a `CardInstance`.
 *
 * The movement helpers exist for the same reason `Zones` documents a card census: a card must be
 * in exactly one place. `moveToZone` removes before it adds, and `locateCard` can prove where any
 * uid is at any moment — which is what makes the census a real test rather than an aspiration.
 */

import {
  emitPublic,
  type Ctx,
  type DraftPlayer,
  type DraftZones,
  type ZoneKey,
} from "./draft.js";
import { ALL_ZONE_KEYS } from "./draft.js";
import {
  CardKind,
  asCardUid,
  type CardInstance,
  type CardUid,
  type ColoredCardKind,
  type PlayerColor,
  type PlayerId,
} from "./types.js";

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * A card factory. `ordinal` is a plain counter, so uids are stable, readable in a bug report
 * ("c07:sorry_for_you") and provably unique — two cards cannot collide because two calls cannot
 * return the same ordinal.
 */
export interface CardMint {
  plain(kind: Exclude<CardKind, ColoredCardKind>): CardInstance;
  colored(kind: ColoredCardKind, color: PlayerColor): CardInstance;
  minted(): readonly CardInstance[];
}

export function createMint(): CardMint {
  let ordinal = 0;
  const all: CardInstance[] = [];
  const nextUid = (suffix: string): CardUid => {
    ordinal += 1;
    return asCardUid(`c${String(ordinal).padStart(3, "0")}:${suffix}`);
  };
  return {
    plain(kind) {
      const card: CardInstance = { uid: nextUid(kind), kind };
      all.push(card);
      return card;
    },
    colored(kind, color) {
      const card: CardInstance = { uid: nextUid(`${kind}:${color}`), kind, color };
      all.push(card);
      return card;
    },
    minted: () => all,
  };
}

// ---------------------------------------------------------------------------
// Registry lookups
// ---------------------------------------------------------------------------

export function registerCards(ctx: Ctx, cards: readonly CardInstance[]): void {
  for (const card of cards) {
    if (ctx.index.has(card.uid)) {
      throw new Error(`registerCards: duplicate card uid ${card.uid}`);
    }
    ctx.cards.push(card);
    ctx.index.set(card.uid, card);
  }
}

export function lookupCard(ctx: Ctx, uid: CardUid): CardInstance | null {
  return ctx.index.get(uid) ?? null;
}

/** A uid that is not in the registry is an engine bug, never a player mistake. */
export function requireCard(ctx: Ctx, uid: CardUid): CardInstance {
  const card = ctx.index.get(uid);
  if (!card) throw new Error(`requireCard: unknown card uid ${uid}`);
  return card;
}

export function kindOf(ctx: Ctx, uid: CardUid): CardKind {
  return requireCard(ctx, uid).kind;
}

export function kindsOf(ctx: Ctx, uids: readonly CardUid[]): CardKind[] {
  return uids.map((uid) => kindOf(ctx, uid));
}

export const isCouncilCardKind = (kind: CardKind): boolean =>
  kind === CardKind.TribalCouncilSingle || kind === CardKind.TribalCouncilDouble;

// ---------------------------------------------------------------------------
// Locating a card
// ---------------------------------------------------------------------------

export type CardLocation =
  | { readonly where: "zone"; readonly zone: ZoneKey }
  | {
      readonly where: "player";
      readonly playerId: PlayerId;
      readonly slot: "hand" | "voteCards" | "grantedVotes" | "characterCards";
    }
  | { readonly where: "missing" };

/** Where is this uid right now? The census invariant says the answer is never ambiguous. */
export function locateCard(ctx: Ctx, uid: CardUid): CardLocation {
  for (const zone of ALL_ZONE_KEYS) {
    if (ctx.zones[zone].includes(uid)) return { where: "zone", zone };
  }
  for (const player of ctx.players) {
    if (player.hand.includes(uid))
      return { where: "player", playerId: player.id, slot: "hand" };
    if (player.voteCards.includes(uid))
      return { where: "player", playerId: player.id, slot: "voteCards" };
    if (player.grantedVotes.includes(uid))
      return { where: "player", playerId: player.id, slot: "grantedVotes" };
    if (player.characterCards.some((c) => c.uid === uid))
      return { where: "player", playerId: player.id, slot: "characterCards" };
  }
  return { where: "missing" };
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function pull(list: CardUid[], uid: CardUid): boolean {
  const at = list.indexOf(uid);
  if (at < 0) return false;
  list.splice(at, 1);
  return true;
}

/** Detach a uid from wherever it is. Character cards never move and are refused. */
export function detach(ctx: Ctx, uid: CardUid): CardLocation {
  const at = locateCard(ctx, uid);
  switch (at.where) {
    case "zone":
      pull(ctx.zones[at.zone], uid);
      return at;
    case "player": {
      const player = ctx.players.find((p) => p.id === at.playerId);
      if (!player) throw new Error(`detach: card ${uid} located on an unknown player`);
      if (at.slot === "characterCards") {
        throw new Error(`detach: character card ${uid} may not leave its owner`);
      }
      pull(player[at.slot], uid);
      return at;
    }
    case "missing":
      return at;
    default:
      return at;
  }
}

export function moveToZone(ctx: Ctx, uid: CardUid, zone: ZoneKey): void {
  detach(ctx, uid);
  ctx.zones[zone].push(uid);
}

/**
 * Hand a card to a player. Vote Cards land in `voteCards` and never in the hand: they are dealt
 * at setup, recycled between councils and taken only by Control the Vote, which is why they have
 * a zone of their own (see `Player.voteCards`).
 */
export function giveCardTo(ctx: Ctx, player: DraftPlayer, uid: CardUid): void {
  detach(ctx, uid);
  if (kindOf(ctx, uid) === CardKind.Vote) player.voteCards.push(uid);
  else player.hand.push(uid);
}

export function handHas(player: DraftPlayer, uid: CardUid): boolean {
  return player.hand.includes(uid);
}

/** The Inheritance card for a colour, in this player's hand. */
export function inheritanceForColor(
  ctx: Ctx,
  player: DraftPlayer,
  color: PlayerColor,
): CardUid | null {
  return (
    player.hand.find((uid) => {
      const card = requireCard(ctx, uid);
      return card.kind === CardKind.Inheritance && card.color === color;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Discarding
// ---------------------------------------------------------------------------

export type DiscardReason =
  "played" | "forced" | "council_cleanup" | "elimination" | "surplus_vote";

/**
 * The one route to the Discard Pile, and it always emits.
 *
 * Audit #75: "the old code had no discard pile at all — every played card was deleted from the
 * game with no record", and audit #128: "Discard Privately lets a card leave the game with
 * nobody knowing". A discard is a public, face-up act; making the event part of the movement is
 * what stops a future call site from quietly skipping it.
 */
export function discardCard(
  ctx: Ctx,
  uid: CardUid,
  reason: DiscardReason,
  options?: { readonly playerId?: PlayerId; readonly autoSelected?: boolean },
): void {
  const at = locateCard(ctx, uid);
  const owner =
    options?.playerId ?? (at.where === "player" ? at.playerId : ctx.players[0]?.id);
  if (!owner) throw new Error(`discardCard: no player context for ${uid}`);
  const kind = kindOf(ctx, uid);
  moveToZone(ctx, uid, "discardPile");
  emitPublic(ctx, {
    type: "card_discarded",
    playerId: owner,
    cardUid: uid,
    kind,
    reason,
    autoSelected: options?.autoSelected ?? false,
  });
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

export interface CensusProblem {
  readonly uid: CardUid;
  readonly problem: "missing" | "duplicated" | "unregistered";
  readonly places: readonly string[];
}

/**
 * Every uid in the registry is in exactly one place, and every uid in a zone or a hand is in the
 * registry. Cheap enough (68 cards) to run in a test after every action.
 *
 * `council.votes[].cardUid` and `idolPlays[].cardUid` are REFERENCES into `votingBox` / `inPlay`,
 * never a second location, so a mid-council census still balances (audit #75/#121).
 */
export function auditCensus(
  cards: readonly CardInstance[],
  players: readonly {
    readonly id: PlayerId;
    readonly hand: readonly CardUid[];
    readonly voteCards: readonly CardUid[];
    readonly grantedVotes: readonly CardUid[];
    readonly characterCards: readonly { readonly uid: CardUid }[];
  }[],
  zones: DraftZones | Readonly<Record<ZoneKey, readonly CardUid[]>>,
): readonly CensusProblem[] {
  const places = new Map<CardUid, string[]>();
  const record = (uid: CardUid, place: string): void => {
    const existing = places.get(uid);
    if (existing) existing.push(place);
    else places.set(uid, [place]);
  };

  for (const zone of ALL_ZONE_KEYS) {
    for (const uid of zones[zone]) record(uid, zone);
  }
  for (const player of players) {
    for (const uid of player.hand) record(uid, `${player.id}.hand`);
    for (const uid of player.voteCards) record(uid, `${player.id}.voteCards`);
    for (const uid of player.grantedVotes) record(uid, `${player.id}.grantedVotes`);
    for (const card of player.characterCards)
      record(card.uid, `${player.id}.characterCards`);
  }

  const problems: CensusProblem[] = [];
  const registry = new Set(cards.map((c) => c.uid));
  for (const card of cards) {
    const found = places.get(card.uid);
    if (!found) problems.push({ uid: card.uid, problem: "missing", places: [] });
    else if (found.length > 1)
      problems.push({ uid: card.uid, problem: "duplicated", places: found });
  }
  for (const [uid, found] of places) {
    if (!registry.has(uid))
      problems.push({ uid, problem: "unregistered", places: found });
  }
  return problems;
}
