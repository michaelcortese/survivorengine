/**
 * THE custom_id PROTOCOL — `src/discord/ui.ts`.
 *
 * This file exists because the protocol had zero tests and hid a total failure: `encode()`
 * wrote the raw `ActionKind` into the wire format while `parseCustomId()` resolved that field
 * through `ACTION_BY_CODE` (keyed by the two-character CODE), so every button
 * `componentsForLegalActions()` minted decoded as "unknown step" and came back to the player
 * as "That button is no longer valid". Nothing failed; a human caught it by reading the file.
 *
 * The rule here, therefore: the encoder is never asserted against a hand-written string. Every
 * claim is a ROUND TRIP — encode, parse, and compare against what was asked for — and the last
 * section drives a real game and holds every button it mints to that same round trip plus
 * "and the router could actually act on this press".
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type DiscordConfig } from "../src/config.js";
import cardCommand from "../src/commands/card.js";
import councilCommand from "../src/commands/council.js";
import drawCommand from "../src/commands/draw.js";
import handCommand from "../src/commands/hand.js";
import helpCommand from "../src/commands/help.js";
import playCommand from "../src/commands/play.js";
import skipCommand from "../src/commands/skip.js";
import statusCommand from "../src/commands/status.js";
import stealCommand from "../src/commands/steal.js";
import survivorCommand from "../src/commands/survivor.js";
import voteCommand from "../src/commands/vote.js";
import {
  ANY_PLAYER,
  actionFromComponent,
  mayPress,
  routeKeysFor,
  type Command,
} from "../src/discord/interactions.js";
import type { GameSession } from "../src/discord/registry.js";
import {
  ACTION_CODE,
  ACTION_LABEL,
  UI_INTENT,
  assertIntentCodesAreDisjoint,
  button,
  cardArg,
  componentsForLegalActions,
  encode,
  encodeOrThrow,
  packPlayerArg,
  parseCustomId,
  pendingArg,
  playerArg,
  select,
  type CustomIdParts,
  type ParsedCustomId,
  type Row,
  type UiIntent,
} from "../src/discord/ui.js";
import { createGame } from "../src/engine/game.js";
import {
  asCardUid,
  asGameId,
  asPendingId,
  asPlayerId,
  isOk,
  type Action,
  type ActionKind,
  type CardUid,
  type DispatchOutcome,
  type Game,
  type LegalAction,
  type PlayerId,
  type Result,
} from "../src/engine/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DISCORD: DiscordConfig = DEFAULT_CONFIG.discord;
const ENGINE = DEFAULT_CONFIG.engine;

/** One fixed seed for every deterministic assertion in the file. */
const SEED = 20250909;
const NOW = 1_700_000_000_000;

/** Real Discord snowflakes: 19 decimal digits, which is the worst case for the length budget. */
const CHANNEL = asGameId("1287654321098765432");
const SNOWFLAKES = [
  "9876543210987654321",
  "1234567890123456789",
  "1111111111111111111",
  "8888888888888888888",
  "7777777777777777777",
  "6666666666666666666",
] as const;

const pid = (i: number): PlayerId =>
  asPlayerId(SNOWFLAKES[i] ?? `999999999999999999${i}`);

const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eve", "Fay"] as const;

const ALL_ACTIONS = Object.keys(ACTION_CODE) as readonly ActionKind[];
const ALL_UI_INTENTS = Object.values(UI_INTENT) as readonly UiIntent[];

const baseParts = (overrides: Partial<CustomIdParts> = {}): CustomIdParts => ({
  gameId: CHANNEL,
  intent: "draw_card",
  actor: pid(0),
  incarnation: NOW,
  seq: 7,
  ...overrides,
});

function expectEncoded(parts: CustomIdParts, discord: DiscordConfig = DISCORD): string {
  const result = encode(parts, discord);
  if (!result.ok) {
    throw new Error(`encode refused: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function expectParsed(raw: string, discord: DiscordConfig = DISCORD): ParsedCustomId {
  const result = parseCustomId(raw, discord);
  if (!result.ok) {
    throw new Error(
      `parseCustomId refused ${JSON.stringify(raw)}: ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** The wire field an id actually carries, so a test can say "the CODE, not the name". */
const fieldAt = (raw: string, index: number): string | undefined =>
  raw.split("|")[index];

// ---------------------------------------------------------------------------
// The code table
// ---------------------------------------------------------------------------

describe("the intent code table", () => {
  it("reports no collisions between action codes and UI intent codes", () => {
    expect(assertIntentCodesAreDisjoint()).toEqual([]);
  });

  it("gives every action a distinct code that no UI intent can shadow", () => {
    const codes = Object.values(ACTION_CODE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code.startsWith("u")).toBe(false);
    for (const ui of ALL_UI_INTENTS) expect(codes).not.toContain(ui);
    expect(new Set(ALL_UI_INTENTS).size).toBe(ALL_UI_INTENTS.length);
  });

  it("keeps every code inside the 2-3 characters the length budget assumes", () => {
    for (const [action, code] of Object.entries(ACTION_CODE)) {
      expect(
        code.length,
        `${action} is coded as ${JSON.stringify(code)}`,
      ).toBeLessThanOrEqual(3);
      expect(code.length).toBeGreaterThanOrEqual(2);
    }
    for (const ui of ALL_UI_INTENTS) expect(ui.length).toBe(2);
  });

  it("labels exactly the actions it codes", () => {
    expect(Object.keys(ACTION_LABEL).sort()).toEqual([...ALL_ACTIONS].sort());
    for (const [action, label] of Object.entries(ACTION_LABEL)) {
      expect(label.trim(), `${action} has a blank label`).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

describe("encode/parse round trips", () => {
  it("decodes every ActionKind back to that same action", () => {
    const failures: string[] = [];
    for (const action of ALL_ACTIONS) {
      const raw = expectEncoded(baseParts({ intent: action }));
      const parsed = parseCustomId(raw, DISCORD);
      if (!parsed.ok) {
        failures.push(`${action}: ${parsed.error.message}`);
        continue;
      }
      if (parsed.value.intent.kind !== "action") {
        failures.push(`${action}: decoded as a UI step, not an action`);
        continue;
      }
      if (parsed.value.intent.action !== action) {
        failures.push(`${action}: decoded as ${parsed.value.intent.action}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("writes the two-character code on the wire, never the ActionKind name", () => {
    for (const action of ALL_ACTIONS) {
      const raw = expectEncoded(baseParts({ intent: action }));
      expect(fieldAt(raw, 2)).toBe(ACTION_CODE[action]);
    }
  });

  it("decodes every UiIntent back to that same UI step", () => {
    for (const ui of ALL_UI_INTENTS) {
      const parsed = expectParsed(expectEncoded(baseParts({ intent: ui })));
      expect(parsed.intent).toEqual({ kind: "ui", ui });
    }
  });

  it("carries the game, the actor, the incarnation and the sequence through unchanged", () => {
    for (const action of ALL_ACTIONS) {
      const parts = baseParts({
        intent: action,
        gameId: CHANNEL,
        actor: pid(3),
        incarnation: NOW,
        seq: 41,
      });
      const parsed = expectParsed(expectEncoded(parts));
      expect(parsed.gameId).toBe(CHANNEL);
      expect(parsed.actor).toBe(pid(3));
      expect(parsed.incarnation).toBe(NOW);
      expect(parsed.seq).toBe(41);
    }
  });

  it("carries arguments through in the order they were minted in", () => {
    const args = ["pnd-1234", "c007:sorry_for_you", packPlayerArg(pid(2)), "voting"];
    const parsed = expectParsed(
      expectEncoded(baseParts({ intent: "play_sorry_for_you", args })),
    );
    expect(parsed.args).toEqual(args);
    expect(pendingArg(parsed, 0)).toBe(asPendingId("pnd-1234"));
    expect(cardArg(parsed, 1)).toBe(asCardUid("c007:sorry_for_you"));
    expect(playerArg(parsed, 2)).toBe(pid(2));
  });

  it("decodes a component minted with no arguments as an empty argument list", () => {
    const parsed = expectParsed(expectEncoded(baseParts({ intent: "draw_card" })));
    expect(parsed.args).toEqual([]);
    expect(cardArg(parsed, 0)).toBeNull();
    expect(playerArg(parsed, 0)).toBeNull();
    expect(pendingArg(parsed, 0)).toBeNull();
  });

  it("packs a player id into an argument and unpacks the very same id", () => {
    for (let i = 0; i < SNOWFLAKES.length; i += 1) {
      const player = pid(i);
      const parsed = expectParsed(
        expectEncoded(
          baseParts({ intent: "steal_random", args: [packPlayerArg(player)] }),
        ),
      );
      expect(playerArg(parsed, 0)).toBe(player);
      expect(parsed.actor).toBe(pid(0));
    }
  });

  it("leaves the lobby's ANY_PLAYER actor pressable by everybody after a round trip", () => {
    const parsed = expectParsed(
      expectEncoded(baseParts({ intent: "join_game", actor: ANY_PLAYER })),
    );
    expect(parsed.actor).toBe(ANY_PLAYER);
    expect(mayPress(parsed, pid(4))).toBe(true);
  });

  it("names exactly one presser on every non-lobby component", () => {
    const parsed = expectParsed(
      expectEncoded(baseParts({ intent: "cast_vote", actor: pid(1) })),
    );
    expect(mayPress(parsed, pid(1))).toBe(true);
    expect(mayPress(parsed, pid(2))).toBe(false);
  });

  it("survives a card uid whose kind carries a colour suffix", () => {
    const uid = asCardUid("c067:survivor_character:purple");
    const parsed = expectParsed(
      expectEncoded(baseParts({ intent: "choose_card", args: [uid] })),
    );
    expect(cardArg(parsed, 0)).toBe(uid);
  });

  it("round-trips an incarnation and a sequence at both ends of their range", () => {
    for (const [incarnation, seq] of [
      [0, 0],
      [1, 1],
      [NOW, 0],
      [NOW, 1],
      [NOW + 999, 123_456],
      [Number.MAX_SAFE_INTEGER, 35],
    ] as const) {
      const parsed = expectParsed(
        expectEncoded(baseParts({ intent: "draw_card", incarnation, seq })),
      );
      expect(parsed.incarnation).toBe(incarnation);
      expect(parsed.seq).toBe(seq);
    }
  });

  it("refuses to mint an argument that would forge a protocol separator", () => {
    for (const hostile of ["sv|1|jg|1||0-0", "a~b", "|", "~"]) {
      const result = encode(
        baseParts({ intent: "draw_card", args: [hostile] }),
        DISCORD,
      );
      expect(result.ok, `encode accepted ${JSON.stringify(hostile)}`).toBe(false);
    }
  });

  it("passes an id that is not a snowflake through unchanged, as packId promises", () => {
    // packId: "test ids and anything unexpected pass through". The decoder has to honour the
    // same promise or the actor a component names is not the actor it comes back as.
    const oddball = asPlayerId("p1");
    const parsed = expectParsed(
      expectEncoded(
        baseParts({
          intent: "steal_random",
          actor: oddball,
          args: [packPlayerArg(oddball)],
        }),
      ),
    );
    expect(parsed.actor).toBe(oddball);
    expect(playerArg(parsed, 0)).toBe(oddball);
  });
});

// ---------------------------------------------------------------------------
// The 100-character budget
// ---------------------------------------------------------------------------

describe("Discord's 100-character custom_id limit", () => {
  /** The longest uid the real deck can mint, taken from a real deck rather than guessed. */
  const longestUid = (): CardUid => {
    const game = startedGame(6);
    let longest = asCardUid("c001:x");
    for (const card of game.state().cards) {
      if (card.uid.length > longest.length) longest = card.uid;
    }
    return longest;
  };

  it("keeps every action inside the limit with the worst realistic payload", () => {
    const uid = longestUid();
    const over: string[] = [];
    for (const action of ALL_ACTIONS) {
      const parts = baseParts({
        intent: action,
        gameId: CHANNEL,
        actor: pid(0),
        // The three argument shapes `componentsForLegalActions` can stack at once, at their
        // longest: a pending id, the phase an advance is from, and a card uid.
        args: ["pnd-999999", "final_words", uid],
        incarnation: NOW,
        seq: 9_999,
      });
      const result = encode(parts, DISCORD);
      if (!result.ok) {
        over.push(`${action}: ${result.error.message}`);
        continue;
      }
      if (result.value.length > DISCORD.maxCustomIdLength) {
        over.push(`${action}: ${result.value.length} chars`);
      }
    }
    expect(over).toEqual([]);
  });

  it("keeps a two-target component inside the limit", () => {
    const parts = baseParts({
      intent: "play_power_pair",
      args: [
        "c067:lets_form_an_alliance",
        packPlayerArg(pid(1)),
        packPlayerArg(pid(2)),
      ],
      incarnation: NOW,
      seq: 1_000_000,
    });
    const raw = expectEncoded(parts);
    expect(raw.length).toBeLessThanOrEqual(DISCORD.maxCustomIdLength);
    expect(expectParsed(raw).args).toHaveLength(3);
  });

  it("refuses to mint an over-length id rather than letting Discord reject the message", () => {
    const result = encode(
      baseParts({ intent: "play_camp_raid", args: ["c001:" + "x".repeat(200)] }),
      DISCORD,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("internal_invariant_violated");
      expect(result.error.message).toContain("100");
    }
  });

  it("turns an unmintable button into a disabled inert one that still decodes", () => {
    const built = button(
      {
        parts: baseParts({
          intent: "play_camp_raid",
          args: ["c001:" + "x".repeat(200)],
        }),
        label: "Camp Raid",
      },
      DISCORD,
    ).toJSON();
    expect(built.disabled).toBe(true);
    if (!("custom_id" in built)) throw new Error("a button minted with no custom_id");
    const parsed = expectParsed(built.custom_id);
    expect(parsed.intent).toEqual({ kind: "ui", ui: UI_INTENT.Inert });
  });

  it("turns an unmintable select into a disabled inert one that still decodes", () => {
    const row = select(
      {
        parts: baseParts({ intent: "choose_card", args: ["c001:" + "x".repeat(200)] }),
        placeholder: "Take a card",
        options: [{ value: "c001:sorry_for_you", label: "Sorry For You!" }],
      },
      DISCORD,
    ).toJSON();
    const menu = row.components[0];
    if (menu === undefined || !("custom_id" in menu))
      throw new Error("no select minted");
    expect(menu.disabled).toBe(true);
    expect(expectParsed(menu.custom_id).intent).toEqual({
      kind: "ui",
      ui: UI_INTENT.Inert,
    });
  });

  it("mints inside a tighter limit too, so the ceiling is config and not a literal", () => {
    const tight: DiscordConfig = { ...DISCORD, maxCustomIdLength: 30 };
    const result = encode(baseParts({ intent: "draw_card" }), tight);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The nonce: which game, and how old
// ---------------------------------------------------------------------------

describe("the nonce", () => {
  it("rejects a button minted for a previous game in the same channel", () => {
    const first = createGame({
      gameId: CHANNEL,
      hostId: pid(0),
      config: ENGINE,
      nowMs: NOW,
      seed: SEED,
    });
    const second = createGame({
      gameId: CHANNEL,
      hostId: pid(0),
      config: ENGINE,
      nowMs: NOW + 60_000,
      seed: SEED,
    });
    expect(second.state().createdAtMs).not.toBe(first.state().createdAtMs);

    const oldButton = expectEncoded(
      baseParts({
        intent: "join_game",
        incarnation: first.state().createdAtMs,
        seq: 1,
      }),
    );
    const parsed = expectParsed(oldButton);

    // The router's rule, verbatim from `validateComponent`: the game id says which channel,
    // the incarnation says WHICH GAME in that channel.
    expect(parsed.gameId).toBe(second.id);
    expect(parsed.incarnation).not.toBe(second.state().createdAtMs);
    expect(parsed.incarnation).toBe(first.state().createdAtMs);
  });

  it("rejects a button minted for the same incarnation in a different channel", () => {
    const parsed = expectParsed(
      expectEncoded(baseParts({ gameId: asGameId("1010101010101010101") })),
    );
    expect(parsed.gameId).not.toBe(CHANNEL);
  });

  it("reports a stale sequence as a number rather than throwing", () => {
    const stale = expectParsed(expectEncoded(baseParts({ seq: 3 })));
    const fresh = expectParsed(expectEncoded(baseParts({ seq: 9 })));
    expect(stale.seq).toBe(3);
    expect(fresh.seq).toBe(9);
    // `ComponentContext.stale` is exactly this comparison.
    expect(stale.seq !== 9).toBe(true);
    expect(fresh.seq !== 9).toBe(false);
  });

  it("keeps a sequence that has run past base36's first digits", () => {
    for (const seq of [35, 36, 37, 1295, 1296, 46_655, 46_656]) {
      expect(expectParsed(expectEncoded(baseParts({ seq }))).seq).toBe(seq);
    }
  });
});

// ---------------------------------------------------------------------------
// Hostile and malformed input
// ---------------------------------------------------------------------------

describe("decoding input that arrived from the network", () => {
  const REJECTED: readonly (readonly [string, string])[] = [
    ["", "empty"],
    ["sv", "the prefix alone"],
    ["sv|", "one separator"],
    ["sv|1|dr|1|", "one field short"],
    ["sv|1|dr|1||0-0|extra", "one field long"],
    ["xx|1|dr|1||0-0", "another application's prefix"],
    ["|1|dr|1||0-0", "no prefix"],
    ["sv|1|zz|1||0-0", "an unknown step code"],
    ["sv|1|draw_card|1||0-0", "an ActionKind where a code belongs"],
    ["sv|1|dr|1||", "an empty nonce"],
    ["sv|1|dr|1||-", "a nonce with neither half"],
    ["sv|1|dr|1||abc", "a nonce with no sequence"],
    ["sv|1|dr|1||-5", "a nonce with no incarnation"],
    ["sv|1|dr|1||!-!", "a nonce that is not base36"],
    ["sv|1|DR|1||0-0", "a code in the wrong case"],
    ["sv|1|u9|1||0-0", "a UI code that does not exist"],
    ["sv|1|\u0000|1||0-0", "a NUL byte where a code belongs"],
    ["sv|1|dr|1||\n-\n", "a nonce made of whitespace"],
  ];

  for (const [raw, why] of REJECTED) {
    it(`rejects ${why} cleanly`, () => {
      const result = parseCustomId(raw, DISCORD);
      expect(result.ok, `accepted ${JSON.stringify(raw)}`).toBe(false);
    });
  }

  it("never throws, whatever it is handed", () => {
    const hostile = [
      "",
      " ",
      "sv",
      "|||||",
      "sv|||||",
      "sv|1|dr|1||0-0|||||",
      "\u0000",
      "sv|1|dr|1||0-0\u0000",
      "sv|" + "9".repeat(5000) + "|dr|1||0-0",
      "sv|1|dr|1|" + "~".repeat(500) + "|0-0",
      "sv|1|dr|1||" + "-".repeat(500),
      "sv|1|dr|1||Infinity-Infinity",
      "sv|1|dr|1||NaN-NaN",
      "sv|1|dr|1||-1--1",
      "sv|1|dr|1||1e309-0",
      "sv|__proto__|dr|constructor||0-0",
      "sv|1|dr|1|__proto__|0-0",
      "sv|1|dr|1|<script>|0-0",
      "sv|1|dr|1|'; DROP TABLE players; --|0-0",
      "sv|1|dr|1|🔥|0-0",
      "modal:something:else",
      "another-bot-button",
    ];
    for (const raw of hostile) {
      expect(() => parseCustomId(raw, DISCORD)).not.toThrow();
      const result = parseCustomId(raw, DISCORD);
      if (result.ok) {
        // Anything it DOES accept must still be structurally complete.
        expect(Number.isFinite(result.value.incarnation)).toBe(true);
        expect(Number.isFinite(result.value.seq)).toBe(true);
        expect(typeof result.value.actor).toBe("string");
      }
    }
  });

  it("never lets a fabricated id name a step that does not exist", () => {
    for (const code of ["", "q", "qq", "zzz", "uu", "u9", "join_game", "0", "-"]) {
      const result = parseCustomId(`sv|1|${code}|1||0-0`, DISCORD);
      expect(result.ok, `accepted the code ${JSON.stringify(code)}`).toBe(false);
    }
  });

  it("rejects an id whose prefix belongs to another deployment", () => {
    const raw = expectEncoded(baseParts({ intent: "draw_card" }));
    const other: DiscordConfig = { ...DISCORD, customIdPrefix: "sv2" };
    expect(parseCustomId(raw, other).ok).toBe(false);
    expect(parseCustomId(expectEncoded(baseParts(), other), DISCORD).ok).toBe(false);
  });

  it("does not throw when encodeOrThrow can mint, and does when it cannot", () => {
    expect(() =>
      encodeOrThrow(baseParts({ intent: "draw_card" }), DISCORD),
    ).not.toThrow();
    expect(() =>
      encodeOrThrow(
        baseParts({ intent: "draw_card", args: ["c001:" + "x".repeat(200)] }),
        DISCORD,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A real game
// ---------------------------------------------------------------------------

const COMMANDS: readonly Command[] = [
  cardCommand,
  councilCommand,
  drawCommand,
  handCommand,
  helpCommand,
  playCommand,
  skipCommand,
  statusCommand,
  stealCommand,
  survivorCommand,
  voteCommand,
];

/** Every component route key the bot actually registers, exactly as `index.ts` collects them. */
const REGISTERED_ROUTES: ReadonlySet<string> = new Set(
  COMMANDS.flatMap((command) => Object.keys(command.components ?? {})),
);

function expectOk(result: Result<DispatchOutcome>): DispatchOutcome {
  if (!isOk(result)) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function startedGame(playerCount: number): Game {
  const game = createGame({
    gameId: CHANNEL,
    hostId: pid(0),
    config: ENGINE,
    nowMs: NOW,
    seed: SEED,
  });
  for (let i = 0; i < playerCount; i += 1) {
    expectOk(
      game.dispatch(
        { type: "join_game", actor: pid(i), displayName: NAMES[i] ?? `P${i}` },
        NOW,
      ),
    );
  }
  expectOk(game.dispatch({ type: "start_game", actor: pid(0) }, NOW));
  return game;
}

/** Whose turn it is. */
function mover(game: Game): PlayerId {
  const turn = game.view().turn;
  if (turn === null) throw new Error("no turn in progress");
  return turn.playerId;
}

/** `actionFromComponent` reads exactly one thing off a session: the public view. */
const sessionFor = (game: Game): GameSession =>
  ({ view: () => game.view() }) as unknown as GameSession;

interface MintedButton {
  readonly customId: string;
  readonly disabled: boolean;
  readonly kind: ActionKind;
}

function mintedButtons(
  rows: readonly Row[],
  kinds: readonly ActionKind[],
): MintedButton[] {
  const flat = rows.flatMap((row) => row.toJSON().components);
  return flat.map((component, index) => {
    if (!("custom_id" in component) || component.custom_id === undefined) {
      throw new Error("a minted component carries no custom_id");
    }
    const kind = kinds[index];
    if (kind === undefined) throw new Error("more buttons than actions asked for");
    return {
      customId: component.custom_id,
      disabled: component.disabled === true,
      kind,
    };
  });
}

/**
 * The whole point of the file: everything a press has to survive between the mint and the
 * router. Returns the parsed id so a caller can go on to rebuild the action.
 */
function assertDecodesToItsOwnAction(
  minted: MintedButton,
  expected: { actor: PlayerId; incarnation: number; seq: number },
): ParsedCustomId {
  expect(
    minted.customId.length,
    `${minted.kind} minted a ${minted.customId.length}-character id`,
  ).toBeLessThanOrEqual(DISCORD.maxCustomIdLength);

  const parsed = parseCustomId(minted.customId, DISCORD);
  expect(parsed.ok, `${minted.kind} minted an id that does not decode`).toBe(true);
  if (!parsed.ok) throw new Error("unreachable");

  expect(parsed.value.intent).toEqual({ kind: "action", action: minted.kind });
  expect(parsed.value.gameId).toBe(CHANNEL);
  expect(parsed.value.actor).toBe(expected.actor);
  expect(parsed.value.incarnation).toBe(expected.incarnation);
  expect(parsed.value.seq).toBe(expected.seq);
  expect(mayPress(parsed.value, expected.actor)).toBe(true);
  return parsed.value;
}

/**
 * An enabled button must be actionable: either the router can rebuild the engine action from
 * the id alone, or a command has registered a handler that opens the picker it needs. A button
 * that is neither is the defect this file exists for, wearing a different hat.
 */
function reasonUnactionable(
  parsed: ParsedCustomId,
  kind: ActionKind,
  game: Game,
  actor: PlayerId,
): string | null {
  const built = actionFromComponent(parsed, [], sessionFor(game), {
    actor,
    displayName: "Tester",
  });
  if (built.ok) {
    if (built.value.type !== kind) {
      return `rebuilt as ${built.value.type} instead of ${kind}`;
    }
    if (built.value.actor !== actor) return `rebuilt for the wrong actor`;
    return null;
  }
  const routed = routeKeysFor(parsed).some((key) => REGISTERED_ROUTES.has(key));
  if (routed) return null;
  return `cannot be rebuilt (${built.error.code}: ${built.error.message}) and no command claims ${routeKeysFor(
    parsed,
  ).join(" or ")}`;
}

interface Audit {
  /** One line per DISTINCT problem: the same defect on 300 buttons is still one defect. */
  readonly problems: Set<string>;
  readonly seen: Set<ActionKind>;
  /** How many buttons carried the pending window / phase / card the engine handed out. */
  counts: { pendings: number; phases: number; cards: number; buttons: number };
}

const newAudit = (): Audit => ({
  problems: new Set<string>(),
  seen: new Set<ActionKind>(),
  counts: { pendings: 0, phases: 0, cards: 0, buttons: 0 },
});

/**
 * One button per KIND, first occurrence wins — the same rule `componentsForLegalActions` uses,
 * so a player with two windows open at once still zips button-to-action correctly.
 */
function firstPerKind(actions: readonly LegalAction[]): LegalAction[] {
  const byKind = new Map<ActionKind, LegalAction>();
  for (const action of actions) {
    if (!byKind.has(action.kind)) byKind.set(action.kind, action);
  }
  return [...byKind.values()];
}

/** Mint every legal action for one player and hold each button to the whole contract. */
function auditPlayer(game: Game, actor: PlayerId, nowMs: number, audit: Audit): void {
  const legal = firstPerKind(game.legalActions(actor, nowMs));
  if (legal.length === 0) return;
  const kinds = legal.map((action: LegalAction) => action.kind);
  const incarnation = game.state().createdAtMs;
  const seq = game.state().seq;
  const rows = componentsForLegalActions(
    legal,
    { gameId: CHANNEL, actor, incarnation, seq },
    DISCORD,
  );
  const minted = mintedButtons(rows, kinds);
  for (let i = 0; i < minted.length; i += 1) {
    const one = minted[i];
    const source = legal[i];
    if (one === undefined || source === undefined)
      throw new Error("button/action mismatch");
    expect(one.kind).toBe(source.kind);
    audit.seen.add(one.kind);
    audit.counts.buttons += 1;
    const parsed = assertDecodesToItsOwnAction(one, { actor, incarnation, seq });

    // Everything the engine said this action needs, and the button could carry, is carried.
    if (source.pendingId !== undefined) {
      expect(parsed.args, `${one.kind} lost its pending window`).toContain(
        source.pendingId,
      );
      audit.counts.pendings += 1;
    }
    if (source.fromPhase !== undefined) {
      expect(parsed.args, `${one.kind} lost the phase it advances from`).toContain(
        source.fromPhase,
      );
      audit.counts.phases += 1;
    }
    if (source.playableCardUids !== undefined && source.legalTargets === undefined) {
      const first = source.playableCardUids[0];
      if (first !== undefined) {
        expect(parsed.args, `${one.kind} lost the card it plays`).toContain(first);
        audit.counts.cards += 1;
      }
    }

    if (one.disabled) continue;
    const problem = reasonUnactionable(parsed, one.kind, game, actor);
    if (problem !== null) audit.problems.add(`${one.kind}: ${problem}`);
  }
}

/**
 * Drive a real game far enough to mint buttons for a lot of different states.
 *
 * The mover is the protocol itself: wherever a button can be rebuilt into an action it is
 * dispatched, so the loop is also a test that the round trip produces MOVES rather than only
 * decodable strings. Where a button deliberately opens a picker instead, the action is built
 * from the `LegalAction` the engine handed out.
 */
function driveGame(): Audit {
  const game = startedGame(4);
  const audit = newAudit();
  const players = [pid(0), pid(1), pid(2), pid(3)];
  let now = NOW;

  for (let step = 0; step < 400; step += 1) {
    const stage = game.state().stage.kind;
    if (stage === "finished" || stage === "abandoned") break;
    for (const player of players) auditPlayer(game, player, now, audit);

    const moved = players.some((player) => tryMove(game, player, now));
    now += 1_000;
    if (!moved) {
      const deadline = game.nextDeadline();
      now = deadline === null ? now + 60_000 : Math.max(now, deadline.atMs + 1);
      game.tick(now);
    }
  }
  return audit;
}

/** Play the first thing this player can legally do, preferring the custom_id round trip. */
function tryMove(game: Game, actor: PlayerId, nowMs: number): boolean {
  const legal = game.legalActions(actor, nowMs);
  for (const action of legal) {
    if (SKIP_WHEN_DRIVING.has(action.kind)) continue;
    const built = buildMove(game, actor, action);
    if (built === null) continue;
    const outcome = game.dispatch(built, nowMs);
    if (isOk(outcome)) return true;
  }
  return false;
}

/** Actions that would end or unwind the game before it has been explored. */
const SKIP_WHEN_DRIVING: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "abandon_game",
  "leave_game",
  "remove_player",
  "transfer_host",
  "start_game",
  "join_game",
  "choose_color",
]);

function buildMove(game: Game, actor: PlayerId, legal: LegalAction): Action | null {
  const args: string[] = [];
  if (legal.pendingId !== undefined) args.push(legal.pendingId);
  if (legal.fromPhase !== undefined) args.push(legal.fromPhase);
  const card = legal.playableCardUids?.[0] ?? legal.optionCardUids?.[0];
  if (card !== undefined) args.push(card);
  const targets = legal.legalTargets ?? [];
  for (const target of targets.slice(0, legal.chooseCount ?? 1)) {
    args.push(packPlayerArg(target));
  }
  const raw = encode(
    {
      gameId: CHANNEL,
      intent: legal.kind,
      actor,
      args,
      incarnation: game.state().createdAtMs,
      seq: game.state().seq,
    },
    DISCORD,
  );
  if (!raw.ok) return null;
  const parsed = parseCustomId(raw.value, DISCORD);
  if (!parsed.ok) return null;
  const values = legal.kind === "submit_challenge_choice" ? ["rock"] : [];
  const built = actionFromComponent(parsed.value, values, sessionFor(game), {
    actor,
    displayName: "Tester",
  });
  return built.ok && built.value.type === legal.kind ? built.value : null;
}

/** The host's lobby, where the host-only affordances live. */
function lobbyAudit(): Audit {
  const game = createGame({
    gameId: CHANNEL,
    hostId: pid(0),
    config: ENGINE,
    nowMs: NOW,
    seed: SEED,
  });
  for (let i = 0; i < 3; i += 1) {
    expectOk(
      game.dispatch(
        { type: "join_game", actor: pid(i), displayName: NAMES[i] ?? `P${i}` },
        NOW,
      ),
    );
  }
  const audit = newAudit();
  auditPlayer(game, pid(0), NOW, audit);
  return audit;
}

describe("componentsForLegalActions, against a real game", () => {
  it("mints a lobby whose every button decodes to the action it was minted for", () => {
    const audit = lobbyAudit();
    expect(audit.seen.has("start_game")).toBe(true);
    expect(audit.seen.has("leave_game")).toBe(true);
    expect(audit.counts.buttons).toBeGreaterThan(0);
  });

  it("mints no enabled button that nothing can act on", () => {
    // The whole contract of an enabled button: the router must be able to DO something with
    // the press. Either `actionFromComponent` rebuilds the action from the id alone, or a
    // command has claimed the intent and opens the picker the action needs. A button that is
    // neither reaches the player as an internal error, which is audit #88 in a new hat.
    const problems = new Set([...lobbyAudit().problems, ...driveGame().problems]);
    expect([...problems]).toEqual([]);
  });

  it("mints every button of a whole played-out game decodable and fully specified", () => {
    const audit = driveGame();
    // A green run against three states would prove nothing, so the coverage is asserted too.
    // The seeded drive reaches 28 kinds and ~650 buttons, through a council, an elimination
    // and a Final Tribal Council with a jury vote.
    expect(
      audit.seen.size,
      `only exercised: ${[...audit.seen].sort().join(", ")}`,
    ).toBeGreaterThanOrEqual(20);
    expect(audit.counts.buttons).toBeGreaterThan(100);
    for (const milestone of [
      "steal_random",
      "draw_card",
      "cast_vote",
      "advance_council",
      "advance_final_council",
      "cast_jury_vote",
    ] as const) {
      expect([...audit.seen], `the drive never reached ${milestone}`).toContain(
        milestone,
      );
    }
  });

  it("packs the pending window, the phase and the card the engine named into the id", () => {
    const audit = driveGame();
    // The three argument shapes, each actually exercised rather than asserted in the abstract.
    expect(audit.counts.pendings, "no button carried a pending window").toBeGreaterThan(
      0,
    );
    expect(audit.counts.phases, "no advance button carried its phase").toBeGreaterThan(
      0,
    );
    expect(audit.counts.cards, "no button carried the card it plays").toBeGreaterThan(
      0,
    );
  });

  it("keeps a disabled button decodable, so a press on a dead affordance is explainable", () => {
    const game = startedGame(4);
    const actor = pid(1); // not the player to move: everything is unavailable
    const rows = componentsForLegalActions(
      game.legalActions(actor, NOW),
      {
        gameId: CHANNEL,
        actor,
        incarnation: game.state().createdAtMs,
        seq: game.state().seq,
        only: [],
        showUnavailable: ["draw_card", "steal_random", "skip_play_step"],
      },
      DISCORD,
    );
    const minted = mintedButtons(rows, ["draw_card", "steal_random", "skip_play_step"]);
    expect(minted).toHaveLength(3);
    for (const one of minted) {
      expect(one.disabled, `${one.kind} should be dead for a player out of turn`).toBe(
        true,
      );
      assertDecodesToItsOwnAction(one, {
        actor,
        incarnation: game.state().createdAtMs,
        seq: game.state().seq,
      });
    }
  });

  it("puts a card a player holds two of into the button, not a bare button", () => {
    // Audit, in the fixer's words: "a player holding two Sorry For You cards got a button that
    // decoded to target_required". One copy of an interchangeable card is a complete answer.
    const game = startedGame(4);
    const actor = mover(game);
    const legal: LegalAction = {
      kind: "play_sorry_for_you",
      pendingId: asPendingId("pnd-12"),
      playableCardUids: [
        asCardUid("c007:sorry_for_you"),
        asCardUid("c008:sorry_for_you"),
      ],
    };
    const rows = componentsForLegalActions(
      [legal],
      {
        gameId: CHANNEL,
        actor,
        incarnation: game.state().createdAtMs,
        seq: game.state().seq,
      },
      DISCORD,
    );
    const [minted] = mintedButtons(rows, ["play_sorry_for_you"]);
    if (minted === undefined) throw new Error("no button minted");
    expect(minted.disabled).toBe(false);
    const parsed = expectParsed(minted.customId);
    expect(parsed.args).toEqual(["pnd-12", "c007:sorry_for_you"]);
    const built = actionFromComponent(parsed, [], sessionFor(game), {
      actor,
      displayName: "Tester",
    });
    expect(built.ok, built.ok ? "" : built.error.message).toBe(true);
    if (built.ok) expect(built.value.type).toBe("play_sorry_for_you");
  });

  it("mints a button for a game that has since been replaced, and it decodes as the old one", () => {
    const first = startedGame(4);
    const actor = mover(first);
    const rows = componentsForLegalActions(
      first.legalActions(actor, NOW),
      {
        gameId: CHANNEL,
        actor,
        incarnation: first.state().createdAtMs,
        seq: first.state().seq,
      },
      DISCORD,
    );
    const [minted] = mintedButtons(
      rows,
      first.legalActions(actor, NOW).map((action) => action.kind),
    );
    if (minted === undefined) throw new Error("the mover has no legal action");

    const replacement = createGame({
      gameId: CHANNEL,
      hostId: pid(0),
      config: ENGINE,
      nowMs: NOW + 5_000,
      seed: SEED,
    });
    const parsed = expectParsed(minted.customId);
    expect(parsed.gameId).toBe(replacement.id);
    expect(parsed.incarnation).not.toBe(replacement.state().createdAtMs);
  });
});
