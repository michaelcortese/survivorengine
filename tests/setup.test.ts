/**
 * SETUP & DECK CONSTRUCTION
 *
 * Every assertion here is traceable to docs/RULES.md "Setup", steps 1-7:
 *
 *  1. "Each player chooses a color and the 2 Survivor Character Cards of that color... Put any
 *     extra Survivor Character Cards away, you won't need them."
 *  2. "Gather all 67 Action Cards and remove the 9 Tribal Council and 6 Vote Cards. Give each
 *     player 1 Vote Card, and put the extras away - you won't need them."
 *  3. "Shuffle the remaining Action Cards, then deal 3 of them face down to each player."
 *  4. The Tribal Council table: 3p 4/0, 4p 2/2, 5p 2/3, 6p 0/5. "Put away any unused Tribal
 *     Council Cards - you won't need them."
 *  5. "Shuffle the Tribal Council Cards you gathered, then place 1 face down at the bottom of
 *     the Action Card deck. Insert the remaining Tribal Council Cards face down into the deck,
 *     spacing them evenly(ish) throughout."
 *  7. "Pick a player to go first."
 *
 * Plus "PLAYER COUNT: 3-6" and the engine's own determinism contract (CreateGameParams.seed).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, withOverrides, type EngineConfig } from "../src/config.js";
import { censusOf, createGame } from "../src/engine/game.js";
import { TRIBAL_COUNCIL_TABLE, deckCompositionFor } from "../src/engine/cards.js";
import {
  ALL_PLAYER_COLORS,
  CardKind,
  asGameId,
  asPlayerId,
  isOk,
  type Action,
  type CardKind as CardKindType,
  type CardUid,
  type DispatchOutcome,
  type Game,
  type GameErrorCode,
  type PlayerColor,
  type PlayerCount,
  type PlayerId,
  type Result,
} from "../src/engine/types.js";
import { audienceMatchesPolicy, type GameEvent } from "../src/engine/events.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** One fixed seed for every deterministic assertion in the file. */
const SEED = 20250909;
const NOW = 1_700_000_000_000;

const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eve", "Fay"] as const;

const pid = (i: number): PlayerId => asPlayerId(`p${i}`);

const ENGINE: EngineConfig = DEFAULT_CONFIG.engine;

const PLAYER_COUNTS: readonly PlayerCount[] = [3, 4, 5, 6];

function newGame(seed = SEED, config: EngineConfig = ENGINE): Game {
  return createGame({
    gameId: asGameId("chan-1"),
    hostId: pid(0),
    config,
    nowMs: NOW,
    seed,
  });
}

function expectOk(r: Result<DispatchOutcome>): DispatchOutcome {
  if (!isOk(r)) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function expectErr(r: Result<DispatchOutcome>): GameErrorCode {
  if (isOk(r)) throw new Error("expected an error, got ok");
  return r.error.code;
}

function join(g: Game, i: number, color?: PlayerColor): Result<DispatchOutcome> {
  const action: Action = color
    ? { type: "join_game", actor: pid(i), displayName: NAMES[i] ?? `P${i}`, color }
    : { type: "join_game", actor: pid(i), displayName: NAMES[i] ?? `P${i}` };
  return g.dispatch(action, NOW);
}

/** A lobby with `n` players joined (no colours named: the engine assigns them). */
function lobbyOf(n: number, seed = SEED, config: EngineConfig = ENGINE): Game {
  const g = newGame(seed, config);
  for (let i = 0; i < n; i += 1) expectOk(join(g, i));
  return g;
}

/** A started game with `n` players. Returns the game and the events `start_game` emitted. */
function startedOf(
  n: number,
  seed = SEED,
  config: EngineConfig = ENGINE,
): { game: Game; events: readonly GameEvent[] } {
  const g = lobbyOf(n, seed, config);
  const outcome = expectOk(g.dispatch({ type: "start_game", actor: pid(0) }, NOW));
  return { game: g, events: outcome.events };
}

function eventOfType<T extends GameEvent["type"]>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }> {
  const found = events.find(
    (e): e is Extract<GameEvent, { type: T }> => e.type === type,
  );
  if (!found)
    throw new Error(`no ${type} event in [${events.map((e) => e.type).join(", ")}]`);
  return found;
}

function kindOf(g: Game, uid: CardUid): CardKindType {
  const card = g.card(uid);
  if (!card) throw new Error(`unknown card uid ${uid}`);
  return card.kind;
}

const isCouncil = (kind: CardKindType): boolean =>
  kind === CardKind.TribalCouncilSingle || kind === CardKind.TribalCouncilDouble;

function countKinds(g: Game, uids: readonly CardUid[]): Map<CardKindType, number> {
  const out = new Map<CardKindType, number>();
  for (const uid of uids) {
    const k = kindOf(g, uid);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** 1-indexed distances from the top of the pile to each Tribal Council card, ascending. */
function councilPositions(g: Game): number[] {
  const pile = g.state().zones.drawPile;
  const out: number[] = [];
  pile.forEach((uid, i) => {
    if (isCouncil(kindOf(g, uid))) out.push(i + 1);
  });
  return out;
}

/**
 * The total number of physical cards the engine mints: 67 Action Cards (52 shuffled + 9 Tribal
 * Council + 6 Vote) + 12 Survivor Character Cards + the hidden 68th Idol Nullifier.
 */
const TOTAL_CARD_INSTANCES = 67 + 12 + 1;

// ---------------------------------------------------------------------------
// Lobby: joining, colours, player-count limits
// ---------------------------------------------------------------------------

describe("lobby: joining and colour choice", () => {
  it("gives every player who joins without naming a colour a distinct Survivor colour", () => {
    const g = lobbyOf(6);
    const colors = g.state().players.map((p) => p.color);
    expect(new Set(colors).size).toBe(6);
    for (const c of colors) expect(ALL_PLAYER_COLORS).toContain(c);
  });

  it("seats players in join order, and seat order is the clockwise turn order", () => {
    const g = lobbyOf(5);
    expect(g.state().players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4]);
    expect(g.state().players.map((p) => p.id)).toEqual([0, 1, 2, 3, 4].map(pid));
  });

  it("lets a player claim a specific colour, and refuses a colour another player already holds", () => {
    const g = newGame();
    expectOk(join(g, 0, "teal"));
    expect(g.state().players[0]?.color).toBe("teal");
    expect(expectErr(join(g, 1, "teal"))).toBe("color_taken");
    expectOk(join(g, 1, "yellow"));
    expect(g.state().players[1]?.color).toBe("yellow");
  });

  it("refuses a second join from the same player", () => {
    const g = lobbyOf(3);
    expect(expectErr(join(g, 0))).toBe("already_joined");
    expect(g.state().players).toHaveLength(3);
  });

  it("lets a seated player change to a free colour and refuses one that is taken", () => {
    const g = newGame();
    expectOk(join(g, 0, "red"));
    expectOk(join(g, 1, "green"));
    expect(
      expectErr(g.dispatch({ type: "choose_color", actor: pid(1), color: "red" }, NOW)),
    ).toBe("color_taken");
    expectOk(
      g.dispatch({ type: "choose_color", actor: pid(1), color: "magenta" }, NOW),
    );
    expect(g.state().players[1]?.color).toBe("magenta");
  });

  it("lets a player re-pick the colour they already hold", () => {
    const g = newGame();
    expectOk(join(g, 0, "orange"));
    expectOk(g.dispatch({ type: "choose_color", actor: pid(0), color: "orange" }, NOW));
    expect(g.state().players[0]?.color).toBe("orange");
  });

  it("refuses a colour choice from someone who has not joined", () => {
    const g = lobbyOf(3);
    expect(
      expectErr(g.dispatch({ type: "choose_color", actor: pid(5), color: "red" }, NOW)),
    ).toBe("not_in_game");
  });

  it("auto-assigned colours never collide with a colour someone claimed explicitly", () => {
    const g = newGame();
    expectOk(join(g, 0, "yellow"));
    expectOk(join(g, 1));
    expectOk(join(g, 2, "green"));
    expectOk(join(g, 3));
    const colors = g.state().players.map((p) => p.color);
    expect(new Set(colors).size).toBe(4);
    expect(colors).toContain("yellow");
    expect(colors).toContain("green");
  });

  it("a player who leaves the lobby frees their colour and their seat", () => {
    const g = lobbyOf(6);
    const freed = g.state().players[2]?.color as PlayerColor;
    expectOk(g.dispatch({ type: "leave_game", actor: pid(2) }, NOW));
    expect(g.state().players).toHaveLength(5);
    expect(g.state().players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4]);
    expectOk(join(g, 6, freed));
    expect(g.state().players).toHaveLength(6);
    expect(new Set(g.state().players.map((p) => p.color)).size).toBe(6);
  });

  it("the six colours are enough for the six seats: a full lobby still starts", () => {
    const g = lobbyOf(6);
    expect(new Set(g.state().players.map((p) => p.color)).size).toBe(
      ALL_PLAYER_COLORS.length,
    );
    expectOk(g.dispatch({ type: "start_game", actor: pid(0) }, NOW));
    expect(g.state().playerCount).toBe(6);
  });

  it("a rejected lobby action changes nothing (validation never mutates)", () => {
    const g = lobbyOf(3);
    const before = JSON.stringify(g.state());
    const r = join(g, 0);
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.code).toBe("already_joined");
    expect(JSON.stringify(g.state())).toBe(before);
  });
});

describe("player-count limits: the rulebook's Tribal Council table is defined only for 3-6", () => {
  it("seats a seventh player nowhere: the table is 3-6 players", () => {
    const g = lobbyOf(6);
    expect(expectErr(join(g, 6))).toBe("too_many_players");
    expect(g.state().players).toHaveLength(6);
  });

  it("refuses to start with fewer than 3 players", () => {
    for (const n of [0, 1, 2]) {
      const g = lobbyOf(n);
      const actor = n === 0 ? pid(0) : pid(0);
      const code = expectErr(g.dispatch({ type: "start_game", actor }, NOW));
      // With nobody seated the actor is not in the game at all; with 1-2 seated it is a count.
      expect(code).toBe(n === 0 ? "not_in_game" : "not_enough_players");
      expect(g.state().stage.kind).toBe("lobby");
    }
  });

  it("refuses to start once departures drop the lobby below 3", () => {
    const g = lobbyOf(3);
    expectOk(g.dispatch({ type: "leave_game", actor: pid(2) }, NOW));
    expect(expectErr(g.dispatch({ type: "start_game", actor: pid(0) }, NOW))).toBe(
      "not_enough_players",
    );
    expect(g.state().stage.kind).toBe("lobby");
  });

  it("refuses to join or start a lobby the host has abandoned", () => {
    const g = lobbyOf(4);
    expectOk(g.dispatch({ type: "abandon_game", actor: pid(0) }, NOW));
    expect(expectErr(join(g, 4))).toBe("game_abandoned");
    expect(expectErr(g.dispatch({ type: "start_game", actor: pid(0) }, NOW))).toBe(
      "game_abandoned",
    );
  });

  it.each(PLAYER_COUNTS)("starts a game at %i players", (n) => {
    const { game } = startedOf(n);
    expect(game.state().stage.kind).toBe("turn");
    expect(game.state().playerCount).toBe(n);
    expect(game.state().startedAtMs).toBe(NOW);
  });

  it("refuses to start a game that is already under way", () => {
    const { game } = startedOf(4);
    expect(expectErr(game.dispatch({ type: "start_game", actor: pid(0) }, NOW))).toBe(
      "game_already_started",
    );
  });

  it("refuses to join or re-colour a game that is already under way", () => {
    const { game } = startedOf(4);
    expect(expectErr(join(game, 4))).toBe("game_already_started");
    expect(
      expectErr(
        game.dispatch({ type: "choose_color", actor: pid(0), color: "yellow" }, NOW),
      ),
    ).toBe("game_already_started");
  });

  it("refuses to start a game from someone who never joined", () => {
    const g = lobbyOf(4);
    expect(expectErr(g.dispatch({ type: "start_game", actor: pid(5) }, NOW))).toBe(
      "not_in_game",
    );
  });

  it("setup step 7 'pick a player to go first' honours an explicitly named first player", () => {
    const g = lobbyOf(5);
    expectOk(
      g.dispatch({ type: "start_game", actor: pid(0), firstPlayer: pid(3) }, NOW),
    );
    const turn = g.view().turn;
    expect(turn?.playerId).toBe(pid(3));
    expect(turn?.turnNumber).toBe(1);
    expect(turn?.phase).toBe("steal");
  });

  it("refuses a first player who is not in the game", () => {
    const g = lobbyOf(4);
    expect(
      expectErr(
        g.dispatch({ type: "start_game", actor: pid(0), firstPlayer: pid(9) }, NOW),
      ),
    ).toBe("target_not_in_game");
    expect(g.state().stage.kind).toBe("lobby");
  });

  it("picks the first player deterministically from the seed when none is named", () => {
    const a = startedOf(5, 4242);
    const b = startedOf(5, 4242);
    expect(a.game.view().turn?.playerId).toBe(b.game.view().turn?.playerId);
  });
});

// ---------------------------------------------------------------------------
// Setup steps 1-3: what every player holds
// ---------------------------------------------------------------------------

describe("setup steps 1-3: what each player holds when the game begins", () => {
  it.each(PLAYER_COUNTS)(
    "at %i players every player holds exactly 2 Survivor Character Cards, 1 Vote Card and 3 Action Cards",
    (n) => {
      const { game } = startedOf(n);
      const state = game.state();
      expect(state.players).toHaveLength(n);
      for (const p of state.players) {
        expect(p.characterCards).toHaveLength(ENGINE.limits.characterCardsPerPlayer);
        expect(p.characterCards.every((c) => !c.flipped)).toBe(true);
        expect(p.characterCards.every((c) => c.flippedAtSeq === null)).toBe(true);
        expect(p.voteCards).toHaveLength(ENGINE.limits.voteCardsPerPlayerAtSetup);
        expect(p.hand).toHaveLength(ENGINE.limits.startingHandSize);
        expect(p.grantedVotes).toHaveLength(0);
        expect(p.eliminatedAtSeq).toBeNull();
        expect(p.leftAtSeq).toBeNull();
      }
    },
  );

  /**
   * Rulebook setup step 1: "Each player chooses a color and the 2 Survivor Character Cards of
   * that color." The colour arrives at `join_game` as a raw Discord string option, exactly as a
   * `PlayerId` does — and the engine validates every `PlayerId` it is handed (`target_not_in_game`)
   * while accepting any string at all as a colour. A colour that is not one of the six printed
   * Survivor colours has no Survivor Character Cards behind it, so `setupDeck` seats a player
   * with ZERO lives who can never be voted out and who the sidebar says is already "out".
   */
  it("a player may never be seated on a colour that has no Survivor Character Cards behind it", () => {
    const g = newGame();
    const bogus = "blue" as PlayerColor;
    const joined = join(g, 0, bogus);
    if (isOk(joined)) {
      expectOk(join(g, 1));
      expectOk(join(g, 2));
      expectOk(g.dispatch({ type: "start_game", actor: pid(0) }, NOW));
      for (const p of g.state().players) {
        expect(`${p.id}:${p.characterCards.length}`).toBe(`${p.id}:2`);
      }
    }
  });

  it.each(PLAYER_COUNTS)(
    "at %i players every character card carries that player's own colour",
    (n) => {
      const { game } = startedOf(n);
      for (const p of game.state().players) {
        for (const cc of p.characterCards) {
          const card = game.card(cc.uid);
          expect(card?.kind).toBe(CardKind.SurvivorCharacter);
          expect(card && "color" in card ? card.color : null).toBe(p.color);
        }
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the card dealt to each vote zone really is a Vote Card",
    (n) => {
      const { game } = startedOf(n);
      for (const p of game.state().players) {
        for (const uid of p.voteCards) expect(kindOf(game, uid)).toBe(CardKind.Vote);
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players no opening hand contains a Vote, Tribal Council or Character card (step 2 removes them before the shuffle)",
    (n) => {
      const { game } = startedOf(n);
      for (const p of game.state().players) {
        for (const uid of p.hand) {
          const k = kindOf(game, uid);
          expect(isCouncil(k)).toBe(false);
          expect(k).not.toBe(CardKind.Vote);
          expect(k).not.toBe(CardKind.SurvivorCharacter);
        }
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the public view reports hand SIZE for everyone (hand size is public, contents are not)",
    (n) => {
      const { game } = startedOf(n);
      for (const pv of game.view().players) {
        expect(pv.handSize).toBe(3);
        expect(pv.voteCardCount).toBe(1);
        expect(pv.charactersRemaining).toBe(2);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Setup steps 2 and 4: what is put away
// ---------------------------------------------------------------------------

describe("setup: surplus Vote Cards, unused colours and unused Tribal Council cards leave the game", () => {
  it.each(PLAYER_COUNTS)(
    "at %i players exactly the surplus Vote Cards, unused Character Cards and unused Tribal Council cards are out of play",
    (n) => {
      const { game } = startedOf(n);
      const state = game.state();
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      const removed = countKinds(game, state.zones.removedFromGame);

      // Step 2: "Give each player 1 Vote Card, and put the extras away."
      expect(removed.get(CardKind.Vote) ?? 0).toBe(6 - n);
      // Step 1: "Put any extra Survivor Character Cards away."
      expect(removed.get(CardKind.SurvivorCharacter) ?? 0).toBe(12 - 2 * n);
      // Step 4: "Put away any unused Tribal Council Cards."
      expect(removed.get(CardKind.TribalCouncilSingle) ?? 0).toBe(4 - alloc.single);
      expect(removed.get(CardKind.TribalCouncilDouble) ?? 0).toBe(5 - alloc.double);
      // Nothing else is ever put away at setup.
      expect(state.zones.removedFromGame).toHaveLength(
        6 - n + (12 - 2 * n) + (9 - alloc.single - alloc.double),
      );
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players no removed card is also in a hand, a vote zone or the draw pile",
    (n) => {
      const { game } = startedOf(n);
      const state = game.state();
      const removed = new Set<CardUid>(state.zones.removedFromGame);
      for (const uid of state.zones.drawPile) expect(removed.has(uid)).toBe(false);
      for (const p of state.players) {
        for (const uid of [...p.hand, ...p.voteCards])
          expect(removed.has(uid)).toBe(false);
        for (const cc of p.characterCards) expect(removed.has(cc.uid)).toBe(false);
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the discard pile, voting box, in-play zone and vote bank all start empty",
    (n) => {
      const { game } = startedOf(n);
      const z = game.state().zones;
      expect(z.discardPile).toHaveLength(0);
      expect(z.votingBox).toHaveLength(0);
      expect(z.inPlay).toHaveLength(0);
      expect(z.voteCardBank).toHaveLength(0);
    },
  );

  it("an unused colour's two Survivor Character Cards are the ones put away", () => {
    const { game } = startedOf(3);
    const state = game.state();
    const inUse = new Set(state.players.map((p) => p.color));
    for (const uid of state.zones.removedFromGame) {
      const card = game.card(uid);
      if (card?.kind !== CardKind.SurvivorCharacter) continue;
      expect(inUse.has(card.color)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Setup step 4: the Tribal Council allocation table
// ---------------------------------------------------------------------------

describe("setup step 4: the printed Tribal Council table (3p 4/0, 4p 2/2, 5p 2/3, 6p 0/5)", () => {
  const EXPECTED: Readonly<Record<PlayerCount, { single: number; double: number }>> = {
    3: { single: 4, double: 0 },
    4: { single: 2, double: 2 },
    5: { single: 2, double: 3 },
    6: { single: 0, double: 5 },
  };

  it.each(PLAYER_COUNTS)(
    "at %i players the draw pile holds exactly the printed number of Single and Double Elimination cards",
    (n) => {
      const expected = EXPECTED[n];
      const { game, events } = startedOf(n);
      const pile = game.state().zones.drawPile;
      const counts = countKinds(game, pile);

      expect(counts.get(CardKind.TribalCouncilSingle) ?? 0).toBe(expected.single);
      expect(counts.get(CardKind.TribalCouncilDouble) ?? 0).toBe(expected.double);

      const built = eventOfType(events, "deck_built");
      expect(built.singleCouncilCards).toBe(expected.single);
      expect(built.doubleCouncilCards).toBe(expected.double);
      expect(built.councilPositions).toHaveLength(expected.single + expected.double);
    },
  );

  it("the engine's own table matches the printed rulebook table", () => {
    for (const n of PLAYER_COUNTS) {
      expect(TRIBAL_COUNCIL_TABLE[n]).toEqual(EXPECTED[n]);
    }
  });

  it.each(PLAYER_COUNTS)(
    "at %i players no Tribal Council card is in anyone's hand or in any other zone",
    (n) => {
      const { game } = startedOf(n);
      const state = game.state();
      for (const p of state.players) {
        for (const uid of [...p.hand, ...p.voteCards, ...p.grantedVotes]) {
          expect(isCouncil(kindOf(game, uid))).toBe(false);
        }
      }
      for (const uid of [
        ...state.zones.discardPile,
        ...state.zones.votingBox,
        ...state.zones.inPlay,
        ...state.zones.voteCardBank,
      ]) {
        expect(isCouncil(kindOf(game, uid))).toBe(false);
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the draw pile is exactly the size setup implies",
    (n) => {
      const { game, events } = startedOf(n);
      const composition = deckCompositionFor(n, ENGINE);
      expect(game.state().zones.drawPile).toHaveLength(composition.drawPileAtStart);
      expect(eventOfType(events, "deck_built").drawPileSize).toBe(
        composition.drawPileAtStart,
      );
      // 52 shuffled + 1 nullifier, minus 3 per player, plus this count's council cards.
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      expect(composition.drawPileAtStart).toBe(
        53 - 3 * n + alloc.single + alloc.double,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Setup step 5: the bottom card, and the spacing
// ---------------------------------------------------------------------------

describe("setup step 5: one Tribal Council card is the literal bottom card of the draw pile", () => {
  it.each(PLAYER_COUNTS)(
    "at %i players the last card that will ever be drawn is a Tribal Council card",
    (n) => {
      const { game } = startedOf(n);
      const pile = game.state().zones.drawPile;
      const bottom = pile[pile.length - 1];
      expect(bottom).toBeDefined();
      expect(isCouncil(kindOf(game, bottom as CardUid))).toBe(true);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players EXACTLY one Tribal Council card sits at the bottom (config: tribalCouncilCardsAtDeckBottom = 1)",
    (n) => {
      const { game } = startedOf(n);
      const pile = game.state().zones.drawPile;
      const secondFromBottom = pile[pile.length - 2];
      expect(secondFromBottom).toBeDefined();
      expect(isCouncil(kindOf(game, secondFromBottom as CardUid))).toBe(false);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the bottom-of-deck guarantee holds for every seed, not just one",
    (n) => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const { game } = startedOf(n, seed);
        const pile = game.state().zones.drawPile;
        const bottomIsCouncil = isCouncil(
          kindOf(game, pile[pile.length - 1] as CardUid),
        );
        const nextIsCouncil = isCouncil(kindOf(game, pile[pile.length - 2] as CardUid));
        expect(`${seed}:${String(bottomIsCouncil)}:${String(nextIsCouncil)}`).toBe(
          `${seed}:true:false`,
        );
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the deck_built event's last council position always equals the pile size",
    (n) => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const { events } = startedOf(n, seed);
        const built = eventOfType(events, "deck_built");
        const positions = built.councilPositions;
        expect(positions[positions.length - 1]).toBe(built.drawPileSize);
        // ascending and distinct
        for (let i = 1; i < positions.length; i += 1) {
          expect((positions[i] as number) > (positions[i - 1] as number)).toBe(true);
        }
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players deck_built's reported council positions match the real pile",
    (n) => {
      const { game, events } = startedOf(n);
      expect(eventOfType(events, "deck_built").councilPositions).toEqual(
        councilPositions(game),
      );
    },
  );
});

describe("setup step 5: the remaining Tribal Council cards are spaced evenly(ish), not clustered", () => {
  const jitter = ENGINE.deck.tribalCouncilSpacingJitter;
  const reserved = ENGINE.limits.tribalCouncilCardsAtDeckBottom;

  it.each(PLAYER_COUNTS)(
    "at %i players every non-bottom council card lands within the configured jitter of its evenly-spaced ideal slot",
    (n) => {
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      const count = alloc.single + alloc.double;
      const spaced = count - reserved;

      for (let seed = 1; seed <= 40; seed += 1) {
        const { game } = startedOf(n, seed);
        const deckSize = game.state().zones.drawPile.length;
        const positions = councilPositions(game);
        expect(positions).toHaveLength(count);

        // "spacing them evenly(ish) throughout": the region above the reserved bottom card is
        // divided into `spaced + 1` even segments; each council card sits on a boundary, plus
        // at most `jitter` of one segment of slop (config.deck.tribalCouncilSpacingJitter).
        const segment = (deckSize - reserved) / (spaced + 1);
        const tolerance = Math.ceil(jitter * segment) + 1;
        for (let i = 1; i <= spaced; i += 1) {
          const ideal = Math.round(i * segment);
          const actual = positions[i - 1] as number;
          expect(
            `n=${n} seed=${seed} i=${i} actual=${actual} ideal=${ideal} tol=${tolerance}`,
          ).toBe(
            Math.abs(actual - ideal) <= tolerance
              ? `n=${n} seed=${seed} i=${i} actual=${actual} ideal=${ideal} tol=${tolerance}`
              : `OUT OF TOLERANCE`,
          );
        }
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players no two Tribal Council cards are ever adjacent in the pile",
    (n) => {
      for (let seed = 1; seed <= 60; seed += 1) {
        const { game } = startedOf(n, seed);
        const positions = councilPositions(game);
        for (let i = 1; i < positions.length; i += 1) {
          const gap = (positions[i] as number) - (positions[i - 1] as number);
          expect(`seed=${seed} gap=${gap}`).toBe(
            gap >= 2 ? `seed=${seed} gap=${gap}` : "ADJACENT",
          );
        }
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the councils are dispersed: no gap shrinks below a third of an even share",
    (n) => {
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      const count = alloc.single + alloc.double;
      for (let seed = 1; seed <= 60; seed += 1) {
        const { game } = startedOf(n, seed);
        const deckSize = game.state().zones.drawPile.length;
        const evenShare = deckSize / count;
        // "spacing them evenly(ish) throughout" — clustering is the failure mode this rules out.
        // Perfect even spacing is 1.0 of an even share; the configured jitter can only pull two
        // neighbours together by half a segment, so anything under a third is a clump.
        const floorGap = evenShare / 3;
        const positions = [0, ...councilPositions(game)];
        for (let i = 1; i < positions.length; i += 1) {
          const gap = (positions[i] as number) - (positions[i - 1] as number);
          expect(`seed=${seed} i=${i} gap=${gap} floor=${floorGap.toFixed(2)}`).toBe(
            gap >= floorGap
              ? `seed=${seed} i=${i} gap=${gap} floor=${floorGap.toFixed(2)}`
              : "CLUSTERED",
          );
        }
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the spacing is not fully predictable: the positions differ across seeds",
    (n) => {
      const seen = new Set<string>();
      for (let seed = 1; seed <= 25; seed += 1) {
        const { game } = startedOf(n, seed);
        seen.add(councilPositions(game).join(","));
      }
      expect(seen.size).toBeGreaterThan(1);
    },
  );

  it("drawsUntilCouncils on the public view reports the same positions (the cards are oversized on purpose)", () => {
    const { game } = startedOf(5);
    expect(game.view().drawsUntilCouncils).toEqual(councilPositions(game));
  });
});

// ---------------------------------------------------------------------------
// Card identity: every instance is unique, and the census balances
// ---------------------------------------------------------------------------

describe("card identity: every physical card in the box has its own uid", () => {
  it.each(PLAYER_COUNTS)("at %i players every registered card uid is unique", (n) => {
    const { game } = startedOf(n);
    const uids = game.state().cards.map((c) => c.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it.each(PLAYER_COUNTS)(
    "at %i players the whole box is accounted for: 67 Action + 12 Character + 1 hidden Nullifier",
    (n) => {
      const { game } = startedOf(n);
      const cards = game.state().cards;
      expect(cards).toHaveLength(TOTAL_CARD_INSTANCES);
      const counts = countKinds(
        game,
        cards.map((c) => c.uid),
      );
      expect(counts.get(CardKind.SurvivorCharacter) ?? 0).toBe(12);
      expect(counts.get(CardKind.Vote) ?? 0).toBe(6);
      expect(counts.get(CardKind.TribalCouncilSingle) ?? 0).toBe(4);
      expect(counts.get(CardKind.TribalCouncilDouble) ?? 0).toBe(5);
      expect(counts.get(CardKind.IdolNullifier) ?? 0).toBe(1);
      expect(counts.get(CardKind.Inheritance) ?? 0).toBe(6);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players each of the 6 Inheritance cards carries a distinct colour",
    (n) => {
      const { game } = startedOf(n);
      const colors = game
        .state()
        .cards.filter((c) => c.kind === CardKind.Inheritance)
        .map((c) => ("color" in c ? c.color : null));
      expect(colors).toHaveLength(6);
      expect(new Set(colors).size).toBe(6);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players every shuffled kind is minted in exactly its printed box quantity",
    (n) => {
      const { game, events } = startedOf(n);
      const composition = eventOfType(events, "deck_built").composition;
      const minted = countKinds(
        game,
        game.state().cards.map((c) => c.uid),
      );
      for (const entry of composition) {
        expect(`${entry.kind}=${String(minted.get(entry.kind) ?? 0)}`).toBe(
          `${entry.kind}=${entry.count}`,
        );
      }
      // Step 3's shuffled pile is the 52 remaining Action Cards plus the hidden 68th.
      expect(composition.reduce((s, e) => s + e.count, 0)).toBe(53);
      for (const entry of composition) {
        expect(isCouncil(entry.kind)).toBe(false);
        expect(entry.kind).not.toBe(CardKind.Vote);
        expect(entry.kind).not.toBe(CardKind.SurvivorCharacter);
      }
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players every shuffled card is either in the draw pile or in an opening hand - nowhere else",
    (n) => {
      const { game, events } = startedOf(n);
      const shuffledKinds = new Set(
        eventOfType(events, "deck_built").composition.map((e) => e.kind),
      );
      const state = game.state();
      const inPlayable = new Set<CardUid>([
        ...state.zones.drawPile,
        ...state.players.flatMap((p) => [...p.hand]),
      ]);
      let seen = 0;
      for (const card of state.cards) {
        if (!shuffledKinds.has(card.kind)) continue;
        seen += 1;
        expect(`${card.uid} placed=${String(inPlayable.has(card.uid))}`).toBe(
          `${card.uid} placed=true`,
        );
      }
      expect(seen).toBe(53);
      // The draw pile also holds this player count's Tribal Council cards, and nothing else.
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      expect(inPlayable.size).toBe(53 + alloc.single + alloc.double);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players every card is in exactly one place (the card census balances)",
    (n) => {
      const { game } = startedOf(n);
      expect(censusOf(game.state())).toEqual([]);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the zones plus hands sum to exactly the number of minted cards",
    (n) => {
      const { game } = startedOf(n);
      const s = game.state();
      const inZones =
        s.zones.drawPile.length +
        s.zones.discardPile.length +
        s.zones.removedFromGame.length +
        s.zones.voteCardBank.length +
        s.zones.votingBox.length +
        s.zones.inPlay.length;
      const held = s.players.reduce(
        (sum, p) =>
          sum +
          p.hand.length +
          p.voteCards.length +
          p.grantedVotes.length +
          p.characterCards.length,
        0,
      );
      expect(inZones + held).toBe(TOTAL_CARD_INSTANCES);
    },
  );
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism: the shuffle is a pure function of the seed", () => {
  it.each(PLAYER_COUNTS)(
    "at %i players the same seed produces a byte-identical draw pile and identical hands",
    (n) => {
      const a = startedOf(n, 987654);
      const b = startedOf(n, 987654);
      expect(a.game.state().zones.drawPile).toEqual(b.game.state().zones.drawPile);
      expect(a.game.state().players.map((p) => p.hand)).toEqual(
        b.game.state().players.map((p) => p.hand),
      );
      expect(a.game.state().zones.removedFromGame).toEqual(
        b.game.state().zones.removedFromGame,
      );
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players the whole started state replays identically",
    (n) => {
      const a = startedOf(n, 555);
      const b = startedOf(n, 555);
      expect(JSON.stringify(a.game.state())).toBe(JSON.stringify(b.game.state()));
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players a different seed produces a different draw pile",
    (n) => {
      const orders = new Set<string>();
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        orders.add(startedOf(n, seed).game.state().zones.drawPile.join("|"));
      }
      expect(orders.size).toBe(8);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players a different seed deals different opening hands",
    (n) => {
      const hands = new Set<string>();
      for (const seed of [11, 22, 33, 44, 55, 66]) {
        hands.add(
          startedOf(n, seed)
            .game.state()
            .players.map((p) => p.hand.join(","))
            .join("|"),
        );
      }
      expect(hands.size).toBe(6);
    },
  );

  it("the shuffle is not the identity: the draw pile is not in minted order", () => {
    const { game } = startedOf(4);
    const pile = game.state().zones.drawPile;
    const mintedOrder = game
      .state()
      .cards.map((c) => c.uid)
      .filter((uid) => pile.includes(uid));
    expect(pile).not.toEqual(mintedOrder);
  });

  it("the deck_built event reports the seed's own deterministic council positions", () => {
    const first = eventOfType(startedOf(4, 20250909).events, "deck_built");
    const again = eventOfType(startedOf(4, 20250909).events, "deck_built");
    expect(first.councilPositions).toEqual(again.councilPositions);
  });
});

// ---------------------------------------------------------------------------
// The Idol Nullifier deck option
// ---------------------------------------------------------------------------

describe("the hidden 68th card is a documented deck option, not a printed rule", () => {
  const withoutNullifier = withOverrides(DEFAULT_CONFIG, {
    engine: { deck: { includeIdolNullifier: false } },
  }).engine;

  it.each(PLAYER_COUNTS)(
    "at %i players disabling the Idol Nullifier removes exactly one card from the draw pile",
    (n) => {
      const withIt = startedOf(n, SEED, ENGINE).game.state().zones.drawPile.length;
      const without = startedOf(n, SEED, withoutNullifier).game.state().zones.drawPile
        .length;
      expect(withIt - without).toBe(1);
    },
  );

  it("with the Idol Nullifier disabled, no Idol Nullifier exists anywhere in the game", () => {
    const { game, events } = startedOf(4, SEED, withoutNullifier);
    expect(game.state().cards.some((c) => c.kind === CardKind.IdolNullifier)).toBe(
      false,
    );
    expect(eventOfType(events, "deck_built").idolNullifierIncluded).toBe(false);
    expect(game.state().cards).toHaveLength(TOTAL_CARD_INSTANCES - 1);
    expect(censusOf(game.state())).toEqual([]);
  });

  it("with the Idol Nullifier enabled (the default) it is shuffled into the deck like any card", () => {
    const { events } = startedOf(4);
    expect(eventOfType(events, "deck_built").idolNullifierIncluded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Setup events
// ---------------------------------------------------------------------------

describe("setup emits the events a table needs to see its own setup", () => {
  it.each(PLAYER_COUNTS)(
    "at %i players start_game narrates the whole setup in order",
    (n) => {
      const { events } = startedOf(n);
      const types = events.map((e) => e.type);
      expect(types).toContain("game_started");
      expect(types).toContain("vote_cards_dealt");
      expect(types).toContain("hands_dealt");
      expect(types).toContain("deck_built");
      expect(types.indexOf("game_started")).toBeLessThan(
        types.indexOf("vote_cards_dealt"),
      );
      expect(types.indexOf("vote_cards_dealt")).toBeLessThan(
        types.indexOf("hands_dealt"),
      );
      expect(types.indexOf("hands_dealt")).toBeLessThan(types.indexOf("deck_built"));
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players vote_cards_dealt reports 1 each and the surplus",
    (n) => {
      const { events } = startedOf(n);
      const dealt = eventOfType(events, "vote_cards_dealt");
      expect(dealt.perPlayer).toBe(1);
      expect(dealt.removedCount).toBe(6 - n);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players hands_dealt reports 3 cards to every seated player",
    (n) => {
      const { events } = startedOf(n);
      const dealt = eventOfType(events, "hands_dealt");
      expect(dealt.handSize).toBe(3);
      expect(dealt.playerIds).toHaveLength(n);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players game_started reports the seat order and the seed",
    (n) => {
      const { events } = startedOf(n);
      const started = eventOfType(events, "game_started");
      expect(started.playerCount).toBe(n);
      expect(started.seatOrder).toEqual(Array.from({ length: n }, (_, i) => pid(i)));
      expect(started.seed).toBe(SEED);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players deck_built's removedFromGame count matches the zone it describes",
    (n) => {
      const { game, events } = startedOf(n);
      expect(eventOfType(events, "deck_built").removedFromGame).toBe(
        game.state().zones.removedFromGame.length,
      );
    },
  );

  it("every setup event is public and matches the engine's own audience policy", () => {
    const { events } = startedOf(4);
    expect(events.length).toBeGreaterThan(3);
    for (const e of events) {
      expect(`${e.type}:${String(audienceMatchesPolicy(e))}`).toBe(`${e.type}:true`);
      // Nothing about setup is secret: who joined, how big the deck is, where the councils are.
      expect(`${e.type}:${e.audience.kind}`).toBe(`${e.type}:public`);
    }
  });

  it("no setup event leaks the contents of anyone's opening hand", () => {
    const { game, events } = startedOf(4);
    const handUids = new Set<string>(game.state().players.flatMap((p) => [...p.hand]));
    const serialized = JSON.stringify(events);
    for (const uid of handUids) expect(serialized).not.toContain(uid);
  });
});

// ---------------------------------------------------------------------------
// The spacing jitter is a knob, and the bottom guarantee survives both extremes
// ---------------------------------------------------------------------------

describe("the bottom-of-deck guarantee survives every spacing jitter setting", () => {
  const withJitter = (j: number): EngineConfig =>
    withOverrides(DEFAULT_CONFIG, {
      engine: { deck: { tribalCouncilSpacingJitter: j } },
    }).engine;

  it.each(PLAYER_COUNTS)(
    "at %i players jitter 0 spaces the councils perfectly evenly and still bottoms one out",
    (n) => {
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      const count = alloc.single + alloc.double;
      const layouts = new Set<string>();
      for (let seed = 1; seed <= 15; seed += 1) {
        const { game } = startedOf(n, seed, withJitter(0));
        const positions = councilPositions(game);
        expect(positions).toHaveLength(count);
        expect(positions[positions.length - 1]).toBe(
          game.state().zones.drawPile.length,
        );
        layouts.add(positions.join(","));
      }
      // Zero jitter means fully predictable, which is exactly why the default is not zero.
      expect(layouts.size).toBe(1);
    },
  );

  it.each(PLAYER_COUNTS)(
    "at %i players jitter 1 never loses, duplicates or un-bottoms a Tribal Council card",
    (n) => {
      const alloc = TRIBAL_COUNCIL_TABLE[n];
      const count = alloc.single + alloc.double;
      for (let seed = 1; seed <= 60; seed += 1) {
        const { game } = startedOf(n, seed, withJitter(1));
        const pile = game.state().zones.drawPile;
        const positions = councilPositions(game);
        expect(`seed=${seed} count=${positions.length}`).toBe(
          `seed=${seed} count=${count}`,
        );
        expect(`seed=${seed} bottom=${String(positions[positions.length - 1])}`).toBe(
          `seed=${seed} bottom=${pile.length}`,
        );
        expect(censusOf(game.state())).toEqual([]);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The host role
// ---------------------------------------------------------------------------

/**
 * THE HOST IS ALWAYS AT THE TABLE.
 *
 * `hostId` gates `abandon_game`, `remove_player` and `transfer_host`, and the Discord layer
 * mints **Begin** for it. A host who walks out used to take all of that with them: the role
 * stayed pointed at somebody who was gone, so nobody could begin the game and nobody but a
 * server moderator could end it. There is no second authorization list to fall back on —
 * `coHostIds` was checked by `requireHost` and populated by nothing, which is audit #24's own
 * shape — so the role has to MOVE.
 */
describe("the host role moves rather than dead-ending", () => {
  const hostOf = (g: Game): PlayerId => g.state().hostId;

  it("passes to the next seat when the host leaves the lobby, and says so publicly", () => {
    const g = lobbyOf(4);
    expect(hostOf(g)).toBe(pid(0));

    const events = expectOk(
      g.dispatch({ type: "leave_game", actor: pid(0) }, NOW),
    ).events;

    expect(hostOf(g)).toBe(pid(1));
    const changed = eventOfType(events, "host_changed");
    expect(changed.previousHostId).toBe(pid(0));
    expect(changed.newHostId).toBe(pid(1));
    expect(changed.reason).toBe("host_left");
    expect(changed.audience.kind).toBe("public");
    for (const event of events) expect(audienceMatchesPolicy(event)).toBe(true);
  });

  it("lets the new host begin the game — the lobby is not stuck", () => {
    const g = lobbyOf(4);
    expectOk(g.dispatch({ type: "leave_game", actor: pid(0) }, NOW));

    expect(g.legalActions(pid(1), NOW).map((a) => a.kind)).toContain("start_game");
    expect(g.legalActions(pid(1), NOW).map((a) => a.kind)).toContain("abandon_game");
    expectOk(g.dispatch({ type: "start_game", actor: pid(1) }, NOW));
    expect(g.state().playerCount).toBe(3);
  });

  it("wraps to the lowest seat when the host was sitting in the last one", () => {
    const g = lobbyOf(3);
    expectOk(g.dispatch({ type: "transfer_host", actor: pid(0), target: pid(2) }, NOW));
    expect(hostOf(g)).toBe(pid(2));

    expectOk(g.dispatch({ type: "leave_game", actor: pid(2) }, NOW));
    expect(hostOf(g)).toBe(pid(0));
  });

  it("passes the role on when the host removes themselves", () => {
    const g = lobbyOf(3);
    const events = expectOk(
      g.dispatch({ type: "remove_player", actor: pid(0), target: pid(0) }, NOW),
    ).events;
    expect(hostOf(g)).toBe(pid(1));
    expect(eventOfType(events, "host_changed").reason).toBe("host_removed");
  });

  it("disposes of a lobby the last player walks out of, without blaming them for ending it", () => {
    const g = lobbyOf(2);
    expectOk(g.dispatch({ type: "leave_game", actor: pid(0) }, NOW));
    expect(g.state().stage.kind).toBe("lobby");

    const events = expectOk(
      g.dispatch({ type: "leave_game", actor: pid(1) }, NOW),
    ).events;

    expect(g.view().status).toBe("abandoned");
    const abandoned = eventOfType(events, "game_abandoned");
    expect(abandoned.emptyLobby).toBe(true);
    expect(abandoned.byId).toBe(pid(1));
    expect(expectErr(join(g, 0))).toBe("game_abandoned");
  });

  it("passes the role to the next player still IN PLAY when the host leaves mid-game", () => {
    const { game } = startedOf(4);
    expect(hostOf(game)).toBe(pid(0));

    const events = expectOk(
      game.dispatch({ type: "leave_game", actor: pid(0) }, NOW),
    ).events;

    expect(hostOf(game)).toBe(pid(1));
    expect(eventOfType(events, "host_changed").reason).toBe("host_left");
    // The departed player keeps their seat (nothing may re-index a started game) and is still
    // not the host.
    expect(game.state().players[0]?.seat).toBe(0);
    expect(game.state().players[0]?.leftAtSeq).not.toBeNull();
  });

  it("hands the role over deliberately, and only the host may do it", () => {
    const g = lobbyOf(4);
    expect(
      expectErr(
        g.dispatch({ type: "transfer_host", actor: pid(2), target: pid(3) }, NOW),
      ),
    ).toBe("not_host");

    const events = expectOk(
      g.dispatch({ type: "transfer_host", actor: pid(0), target: pid(2) }, NOW),
    ).events;
    expect(hostOf(g)).toBe(pid(2));
    expect(eventOfType(events, "host_changed").reason).toBe("transferred");

    // …and the old host is now just a player.
    expect(expectErr(g.dispatch({ type: "abandon_game", actor: pid(0) }, NOW))).toBe(
      "not_host",
    );
    expect(g.legalActions(pid(0), NOW).map((a) => a.kind)).not.toContain(
      "transfer_host",
    );
  });

  it("refuses a transfer to yourself, to a stranger and to somebody who has left", () => {
    const g = lobbyOf(4);
    expect(
      expectErr(
        g.dispatch({ type: "transfer_host", actor: pid(0), target: pid(0) }, NOW),
      ),
    ).toBe("self_target_not_allowed");
    expect(
      expectErr(
        g.dispatch({ type: "transfer_host", actor: pid(0), target: pid(9) }, NOW),
      ),
    ).toBe("target_not_in_game");

    const started = startedOf(4).game;
    expectOk(started.dispatch({ type: "leave_game", actor: pid(3) }, NOW));
    expect(
      expectErr(
        started.dispatch({ type: "transfer_host", actor: pid(0), target: pid(3) }, NOW),
      ),
    ).toBe("player_left_game");
  });

  it("offers the host a transfer with the table as its targets, and nobody else one at all", () => {
    const g = lobbyOf(4);
    const offered = g.legalActions(pid(0), NOW).find((a) => a.kind === "transfer_host");
    expect(offered?.legalTargets).toEqual([pid(1), pid(2), pid(3)]);
    expect(g.legalActions(pid(1), NOW).map((a) => a.kind)).not.toContain(
      "transfer_host",
    );
  });

  it("attributes a moderator's abandon to the MODERATOR, with no co-host list involved", () => {
    const g = lobbyOf(3);
    const outsider = asPlayerId("mod-1");
    expect(expectErr(g.dispatch({ type: "abandon_game", actor: outsider }, NOW))).toBe(
      "not_host",
    );

    const events = expectOk(
      g.dispatch({ type: "abandon_game", actor: outsider, viaModerator: true }, NOW),
    ).events;
    const abandoned = eventOfType(events, "game_abandoned");
    expect(abandoned.byId).toBe(outsider);
    expect(abandoned.viaModerator).toBe(true);
    expect(abandoned.emptyLobby).toBeUndefined();
    const stage = g.state().stage;
    expect(stage.kind === "abandoned" && stage.abandonedById).toBe(outsider);
  });
});
