/**
 * Deck construction, the Tribal Council insertion, the draw pile, and the between-councils
 * recycling of Vote Cards.
 *
 * SETUP ORDER IS THE RULE, and it is encoded in `setupDeck` step by step (rulebook steps 1-5):
 * remove the 9 Tribal Council and 6 Vote Cards BEFORE the shuffle; deal one Vote Card each and
 * put the extras away; shuffle what remains and deal 3 to each player; only THEN gather the
 * Tribal Council cards for this player count, shuffle them, place one at the very bottom and
 * space the rest "evenly(ish)" through the pile.
 *
 * Audit #7: the old builder guaranteed the bottom-of-deck Tribal Council card at 6 players only,
 * and its two readers disagreed about which end of the array was the top. Here index 0 is the
 * TOP (the next card drawn) and the last index is the BOTTOM, stated once in `Zones` and obeyed
 * by `drawTop`, by the insertion routine and by `drawsUntilCouncils`.
 *
 * Audit #17/#58: the old shuffle interleaved "high-value" cards at a fixed period, so idol
 * timing was fully predictable. Every shuffle here is the seeded unbiased Fisher-Yates in
 * `rng.ts`, and there is no other source of randomness in the engine.
 */

import {
  CARD_CATALOG,
  deckCompositionFor,
  tribalCouncilAllocation,
  type DeckComposition,
} from "./cards.js";
import {
  discardCard,
  isCouncilCardKind,
  kindOf,
  moveToZone,
  registerCards,
  createMint,
  giveCardTo,
} from "./card.js";
import { emitPublic, type Ctx, type DraftPlayer } from "./draft.js";
import { charactersRemaining, newCharacterCard, playersInPlay } from "./player.js";
import type { Rng } from "./rng.js";
import {
  ALL_PLAYER_COLORS,
  CardKind,
  type CardInstance,
  type CardUid,
  type CouncilId,
  type CouncilState,
  type PlayerCount,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tribal Council insertion
// ---------------------------------------------------------------------------

/**
 * Choose the slots the Tribal Council cards occupy in the finished draw pile.
 *
 * `bottomCount` slots are reserved at the very bottom (setup step 5's "place 1 face down at the
 * bottom", generalised by `limits.tribalCouncilCardsAtDeckBottom` so the guarantee holds at
 * every player count). The rest are spaced evenly and then jittered by
 * `deck.tribalCouncilSpacingJitter` — the printed rule is "evenly(ish)", so perfectly even would
 * be wrong (fully predictable) and uniformly random would be wrong too (clumps).
 *
 * Returns strictly ascending, distinct indices, always exactly `count` of them.
 */
export function councilSlots(
  rng: Rng,
  deckSize: number,
  count: number,
  bottomCount: number,
  jitter: number,
): number[] {
  if (count <= 0) return [];
  const reserved = Math.min(Math.max(bottomCount, 0), count);
  const slots: number[] = [];
  for (let i = 0; i < reserved; i += 1) slots.push(deckSize - 1 - i);

  const spaced = count - reserved;
  if (spaced > 0) {
    // The region above the reserved bottom cards, which the remaining councils share.
    const ceiling = deckSize - reserved - 1;
    const segment = (ceiling + 1) / (spaced + 1);
    const raw: number[] = [];
    for (let i = 1; i <= spaced; i += 1) {
      const ideal = Math.round(i * segment) - 1;
      const wobble = Math.round(jitter * segment * (rng.next() * 2 - 1));
      raw.push(ideal + wobble);
    }
    raw.sort((a, b) => a - b);
    // Two passes make the result legal no matter how the jitter landed: push forwards to keep
    // them distinct, then pull backwards off the ceiling. A collision here would silently drop
    // a Tribal Council card out of the game.
    for (let i = 0; i < raw.length; i += 1) {
      const floor = i === 0 ? 0 : (raw[i - 1] ?? 0) + 1;
      raw[i] = Math.max(raw[i] ?? 0, floor);
    }
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      const cap = i === raw.length - 1 ? ceiling : (raw[i + 1] ?? ceiling) - 1;
      raw[i] = Math.min(raw[i] ?? 0, cap);
    }
    for (const slot of raw) slots.push(Math.max(slot, 0));
  }

  const unique = [...new Set(slots)].sort((a, b) => a - b);
  if (unique.length !== count) {
    throw new Error(
      `councilSlots: produced ${unique.length} slots for ${count} council cards in a deck of ${deckSize}`,
    );
  }
  return unique;
}

/** Weave the council cards into the body at the chosen slots. Index 0 is the top of the pile. */
export function weaveCouncilCards(
  body: readonly CardUid[],
  councils: readonly CardUid[],
  slots: readonly number[],
): CardUid[] {
  const deck: CardUid[] = [];
  const slotSet = new Set(slots);
  let bodyAt = 0;
  let councilAt = 0;
  const total = body.length + councils.length;
  for (let i = 0; i < total; i += 1) {
    if (slotSet.has(i)) {
      const uid = councils[councilAt];
      councilAt += 1;
      if (uid === undefined)
        throw new Error("weaveCouncilCards: ran out of council cards");
      deck.push(uid);
    } else {
      const uid = body[bodyAt];
      bodyAt += 1;
      if (uid === undefined)
        throw new Error("weaveCouncilCards: ran out of body cards");
      deck.push(uid);
    }
  }
  return deck;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Build the whole physical game: mint every card, hand out the Survivor Character Cards and
 * Vote Cards, shuffle and deal, then insert the Tribal Council cards.
 *
 * Every one of the 67 Action Cards, all 12 Survivor Character Cards and the hidden 68th are
 * minted whether or not this player count uses them; the ones that are not used go to
 * `removedFromGame` ("put the extras away — you won't need them") rather than being skipped, so
 * the card census is a complete account of the box rather than of the subset we happened to deal.
 */
export function setupDeck(ctx: Ctx, playerCount: PlayerCount): DeckComposition {
  const limits = ctx.config.limits;
  const mint = createMint();

  // 1. Survivor Character Cards: 2 per colour, all six colours.
  const charactersByColor = new Map<string, CardInstance[]>();
  for (const color of ALL_PLAYER_COLORS) {
    const pair: CardInstance[] = [];
    for (let i = 0; i < limits.characterCardsPerPlayer; i += 1) {
      pair.push(mint.colored(CardKind.SurvivorCharacter, color));
    }
    charactersByColor.set(color, pair);
  }

  // 2. Vote Cards: all 6, dealt one per player, the rest put away.
  const voteCards: CardInstance[] = [];
  for (let i = 0; i < CARD_CATALOG[CardKind.Vote].quantityInBox; i += 1) {
    voteCards.push(mint.plain(CardKind.Vote));
  }

  // 3. Tribal Council cards: all 9 minted, only this player count's allocation used.
  const singles: CardInstance[] = [];
  for (
    let i = 0;
    i < CARD_CATALOG[CardKind.TribalCouncilSingle].quantityInBox;
    i += 1
  ) {
    singles.push(mint.plain(CardKind.TribalCouncilSingle));
  }
  const doubles: CardInstance[] = [];
  for (
    let i = 0;
    i < CARD_CATALOG[CardKind.TribalCouncilDouble].quantityInBox;
    i += 1
  ) {
    doubles.push(mint.plain(CardKind.TribalCouncilDouble));
  }

  // 4. The 52 shuffled Action Cards (+ the Idol Nullifier when it is enabled).
  const composition = deckCompositionFor(playerCount, ctx.config);
  const pool: CardInstance[] = [];
  for (const entry of composition.shuffled) {
    for (let i = 0; i < entry.count; i += 1) {
      if (entry.kind === CardKind.Inheritance) {
        // One per colour: the colour is printed on the card and is what makes an Inheritance
        // claimable (audit #100 — the old snapshot linked it to a Player object instead).
        const color = ALL_PLAYER_COLORS[i % ALL_PLAYER_COLORS.length];
        if (!color) throw new Error("setupDeck: colour table exhausted");
        pool.push(mint.colored(CardKind.Inheritance, color));
      } else if (entry.kind === CardKind.SurvivorCharacter) {
        throw new Error("setupDeck: character cards are not part of the shuffled deck");
      } else {
        pool.push(mint.plain(entry.kind));
      }
    }
  }

  registerCards(ctx, mint.minted());

  // --- Place everything ----------------------------------------------------

  for (const [color, pair] of charactersByColor) {
    const owner = ctx.players.find((p) => p.color === color);
    if (owner) {
      owner.characterCards = pair.map((card) => newCharacterCard(card.uid));
    } else {
      for (const card of pair) moveToZone(ctx, card.uid, "removedFromGame");
    }
  }

  let voteAt = 0;
  for (const player of ctx.players) {
    for (let i = 0; i < limits.voteCardsPerPlayerAtSetup; i += 1) {
      const card = voteCards[voteAt];
      voteAt += 1;
      if (!card)
        throw new Error("setupDeck: not enough Vote Cards for this player count");
      player.voteCards.push(card.uid);
    }
  }
  const surplusVotes = voteCards.slice(voteAt);
  for (const card of surplusVotes) moveToZone(ctx, card.uid, "removedFromGame");
  emitPublic(ctx, {
    type: "vote_cards_dealt",
    perPlayer: limits.voteCardsPerPlayerAtSetup,
    removedCount: surplusVotes.length,
  });

  const alloc = tribalCouncilAllocation(playerCount);
  const usedCouncils = [
    ...singles.slice(0, alloc.single),
    ...doubles.slice(0, alloc.double),
  ];
  for (const card of [...singles.slice(alloc.single), ...doubles.slice(alloc.double)]) {
    moveToZone(ctx, card.uid, "removedFromGame");
  }

  // Shuffle, then deal 3 face down to each player.
  const shuffled = ctx.rng.shuffle(pool.map((c) => c.uid));
  let dealAt = 0;
  for (const player of ctx.players) {
    for (let i = 0; i < limits.startingHandSize; i += 1) {
      const uid = shuffled[dealAt];
      dealAt += 1;
      if (!uid)
        throw new Error("setupDeck: draw pile exhausted while dealing opening hands");
      giveCardTo(ctx, player, uid);
    }
  }
  emitPublic(ctx, {
    type: "hands_dealt",
    handSize: limits.startingHandSize,
    playerIds: ctx.players.map((p) => p.id),
  });

  const body = shuffled.slice(dealAt);
  const councilUids = ctx.rng.shuffle(usedCouncils.map((c) => c.uid));
  const deckSize = body.length + councilUids.length;
  const slots = councilSlots(
    ctx.rng,
    deckSize,
    councilUids.length,
    limits.tribalCouncilCardsAtDeckBottom,
    ctx.config.deck.tribalCouncilSpacingJitter,
  );
  ctx.zones.drawPile = weaveCouncilCards(body, councilUids, slots);

  emitPublic(ctx, {
    type: "deck_built",
    drawPileSize: ctx.zones.drawPile.length,
    composition: composition.shuffled,
    singleCouncilCards: alloc.single,
    doubleCouncilCards: alloc.double,
    // Distance from the top, ascending. The last entry equals the pile size, because setup
    // step 5 puts a Tribal Council card at the very bottom (audit #7).
    councilPositions: slots.map((slot) => slot + 1),
    removedFromGame: ctx.zones.removedFromGame.length,
    idolNullifierIncluded: composition.idolNullifierIncluded,
  });

  return composition;
}

// ---------------------------------------------------------------------------
// The draw pile
// ---------------------------------------------------------------------------

/** Take the top card, or null when the pile is empty. NEVER reshuffles: there is no such rule. */
export function drawTop(ctx: Ctx): CardUid | null {
  return ctx.zones.drawPile.shift() ?? null;
}

/**
 * Distance from the top of the draw pile to each remaining Tribal Council card, ascending.
 * Public by rule: the cards are oversized "so you always know when the next Tribal Council is
 * coming", and a Discord port has to say so explicitly.
 */
export function drawsUntilCouncils(ctx: Ctx): number[] {
  const out: number[] = [];
  ctx.zones.drawPile.forEach((uid, i) => {
    if (isCouncilCardKind(kindOf(ctx, uid))) out.push(i + 1);
  });
  return out;
}

export function councilCardsLeftInDeck(ctx: Ctx): number {
  return ctx.zones.drawPile.filter((uid) => isCouncilCardKind(kindOf(ctx, uid))).length;
}

// ---------------------------------------------------------------------------
// Council cleanup (shared by the normal path and by a council interrupted by the endgame)
// ---------------------------------------------------------------------------

/**
 * "Discard all other cards used during the Tribal Council (including the Tribal Council Card)
 * face up in the Discard Pile."
 *
 * Vote Cards are the exception: they are recycled, not spent, so they leave the Voting Box for
 * the bank and `redistributeVoteCards` deals them out again. Camp Raid markers also sit in
 * `inPlay` but belong to a turn rather than to this council, so they are deliberately NOT swept.
 */
export function sweepCouncilCards(ctx: Ctx, council: CouncilState): void {
  for (const uid of [...ctx.zones.votingBox]) {
    if (kindOf(ctx, uid) === CardKind.Vote) moveToZone(ctx, uid, "voteCardBank");
    else discardCard(ctx, uid, "council_cleanup", { playerId: council.leaderId });
  }
  const spent: CardUid[] = [
    council.cardUid,
    ...council.advantagesPlayed.map((a) => a.cardUid),
    ...council.idolPlays.map((i) => i.cardUid),
    ...council.nullifierPlays.map((n) => n.cardUid),
  ];
  for (const uid of spent) {
    if (ctx.zones.discardPile.includes(uid)) continue;
    discardCard(ctx, uid, "council_cleanup", { playerId: council.leaderId });
  }
  // A Goodwill Gamble that was handed over but never cast is spent all the same: "MUST be used
  // during the Tribal Council at which it is played".
  for (const player of ctx.players) {
    for (const uid of [...player.grantedVotes]) {
      discardCard(ctx, uid, "council_cleanup", { playerId: player.id });
    }
  }
}

/**
 * "After voting has ended, return 1 Vote Card to every player who still has at least one
 * Survivor Character Card left in the game."
 *
 * Every Vote Card in the game is collected first — including a second one taken with Control the
 * Vote — so the theft lasts exactly one council and every survivor is reset to exactly one.
 * The leftovers stay in `voteCardBank`, which is the zone the contract defines for exactly this
 * ("Vote Cards not currently held by anyone: recycled between councils"); they are not destroyed,
 * because the number of survivors only ever falls and the bank is where the spares belong.
 */
export function redistributeVoteCards(ctx: Ctx, councilId: CouncilId): void {
  for (const player of ctx.players) {
    for (const uid of [...player.voteCards]) moveToZone(ctx, uid, "voteCardBank");
  }
  const recipients = playersInPlay(ctx).filter(
    (p) => charactersRemaining(p) > 0 || p.characterCards.length === 0,
  );
  for (const player of recipients) {
    const uid = ctx.zones.voteCardBank.shift();
    if (!uid) break;
    player.voteCards.push(uid);
  }
  emitPublic(ctx, {
    type: "vote_cards_returned",
    councilId,
    playerIds: recipients.map((p) => p.id),
    surplusDiscarded: ctx.zones.voteCardBank.length,
  });
}

/** Vote Cards held by a player who is leaving play go back to the bank, never to a hand. */
export function returnVoteCardsToBank(ctx: Ctx, player: DraftPlayer): number {
  const count = player.voteCards.length;
  for (const uid of [...player.voteCards]) moveToZone(ctx, uid, "voteCardBank");
  return count;
}
