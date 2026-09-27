/**
 * THE TRIBE BOARD
 *
 * Everyone's two castaways, lit while they are in the game and grayed out once they have been
 * voted out. What is held here:
 *
 *  - the model is built from the PUBLIC view alone, in seat order, with each player's standing
 *    (playing, on the Jury, gone, finalist, winner) and the castaways just voted out picked out;
 *  - the text form strikes a voted-out castaway through, so the board reads without the picture;
 *  - an uploaded photo is sized from its HEADER before anything is decoded, so a small file that
 *    declares an enormous image is refused without ever being decoded;
 *  - what is kept of a photo is a small JPEG this code drew, never the upload;
 *  - the session posts the picture when the game begins and when a castaway is voted out, and
 *    never when `discord.boardImages` is off.
 *
 * The drawing itself needs `@napi-rs/canvas`. Every test that draws checks it can first, so on a
 * platform with no prebuilt binary they are skipped rather than failed — which is also what the
 * bot does there: it posts the text board.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { Client, GuildTextBasedChannel } from "discord.js";

import { DEFAULT_CONFIG, withOverrides, type SurvivorConfig } from "../src/config.js";
import { BOARD_FILE, boardText, boardView, flippedIn } from "../src/discord/board.js";
import {
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
  boardImagesAvailable,
  imageDimensions,
  initials,
  preparePortrait,
  renderBoardImage,
} from "../src/discord/board-image.js";
import { SessionRegistry, type GameSession } from "../src/discord/registry.js";
import { createGame } from "../src/engine/game.js";
import type { GameEvent } from "../src/engine/events.js";
import {
  asCardUid,
  asGameId,
  asPlayerId,
  isOk,
  type Action,
  type Game,
  type PlayerId,
} from "../src/engine/types.js";
import type { Logger } from "../src/logger.js";
import { SaveStore } from "../src/persistence/store.js";

const SEED = 20250909;
const NOW = 1_700_000_000_000;
const P: readonly PlayerId[] = [
  asPlayerId("9876543210987654321"),
  asPlayerId("1234567890123456789"),
  asPlayerId("1111111111111111111"),
];

let canDraw = false;
beforeAll(async () => {
  canDraw = await boardImagesAvailable();
});

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

function must(game: Game, action: Action): readonly GameEvent[] {
  const out = game.dispatch(action, NOW);
  if (!out.ok) throw new Error(`${action.type}: ${out.error.code}`);
  return out.value.events;
}

function startedGame(): Game {
  const game = createGame({
    gameId: asGameId("board-suite"),
    hostId: P[0]!,
    config: DEFAULT_CONFIG.engine,
    nowMs: NOW,
    seed: SEED,
  });
  for (const [i, id] of P.entries()) {
    must(game, { type: "join_game", actor: id, displayName: `Player ${i}` });
  }
  must(game, {
    type: "name_castaways",
    actor: P[1]!,
    castaways: ["Sandra Diaz-Twine", "Tony Vlachos"],
  });
  must(game, { type: "start_game", actor: P[0]!, firstPlayer: P[0]! });
  return game;
}

// ---------------------------------------------------------------------------
// Reading an image's size from its header
// ---------------------------------------------------------------------------

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("an image's size, from its header alone", () => {
  it("reads PNG, GIF, JPEG and WebP", () => {
    expect(imageDimensions(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });

    const gif = Buffer.alloc(13);
    gif.write("GIF89a", 0, "latin1");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 200 });

    // SOI, an APP0 segment, then a baseline frame header.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x01, 0xe0, 0x02, 0x80, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 });

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8X", 12, "latin1");
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(imageDimensions(webp)).toEqual({ width: 800, height: 600 });
  });

  it("knows nothing about anything that is not one of those", () => {
    expect(imageDimensions(Buffer.from("definitely not an image"))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe("a castaway's initials", () => {
  it("takes the first and last word", () => {
    expect(initials("Boston Rob Mariano")).toBe("BM");
    expect(initials("Sandra Diaz-Twine")).toBe("ST");
    expect(initials("Q")).toBe("Q");
    expect(initials("J.T. Thomas")).toBe("JT");
    expect(initials("!!!")).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// Portraits
// ---------------------------------------------------------------------------

describe("turning an upload into a portrait", () => {
  it("refuses an image that DECLARES too many pixels, without decoding it", async () => {
    if (!canDraw) return;
    const bomb = await preparePortrait(pngHeader(30_000, 30_000));
    expect(bomb).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses something that is not an image at all", async () => {
    if (!canDraw) return;
    expect(await preparePortrait(Buffer.from("<html>not a photo</html>"))).toEqual({
      ok: false,
      reason: "not_an_image",
    });
    // A header that parses but a body that does not.
    expect(await preparePortrait(pngHeader(64, 64))).toEqual({
      ok: false,
      reason: "not_an_image",
    });
  });

  it("keeps a small JPEG of its own, cropped to the card's shape", async () => {
    if (!canDraw) return;
    const { createCanvas } = await import("@napi-rs/canvas");
    const photo = createCanvas(800, 400);
    const ctx = photo.getContext("2d");
    ctx.fillStyle = "#3a7";
    ctx.fillRect(0, 0, 800, 400);
    const upload = await photo.encode("png");

    const portrait = await preparePortrait(upload);
    if (!portrait.ok) throw new Error(`refused: ${portrait.reason}`);
    expect(portrait.bytes[0]).toBe(0xff);
    expect(portrait.bytes[1]).toBe(0xd8);
    expect(imageDimensions(portrait.bytes)).toEqual({
      width: PORTRAIT_WIDTH,
      height: PORTRAIT_HEIGHT,
    });
    expect(portrait.bytes.equals(upload)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The model and the text
// ---------------------------------------------------------------------------

describe("the board, as a model", () => {
  it("shows every player in seat order with both castaways, lit", () => {
    const game = startedGame();
    const model = boardView(game.view(), DEFAULT_CONFIG);
    expect(model.players.map((player) => player.name)).toEqual([
      "Player 0",
      "Player 1",
      "Player 2",
    ]);
    const second = model.players[1]!;
    expect(second.castaways.map((castaway) => castaway.name)).toEqual([
      "Sandra Diaz-Twine",
      "Tony Vlachos",
    ]);
    expect(second.castaways.every((castaway) => !castaway.votedOut)).toBe(true);
    expect(model.players.every((player) => player.status === "playing")).toBe(true);
    expect(model.players[0]!.isTurn).toBe(true);
    expect(model.players[0]!.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("grays out a castaway voted out, and picks out the one voted out just now", () => {
    const game = startedGame();
    const view = game.view();
    const sandra = view.players[1]!.castaways[0]!;
    // Stand in for a flip, through the view the board reads: the first card turned over.
    const flipped = {
      ...view,
      players: view.players.map((player, seat) =>
        seat !== 1
          ? player
          : {
              ...player,
              charactersRemaining: 1,
              castaways: player.castaways.map((castaway, index) =>
                index === 0
                  ? { ...castaway, votedOut: true, votedOutAtSeq: 99 }
                  : castaway,
              ),
            },
      ),
    };
    const events = [
      {
        type: "character_card_flipped",
        playerId: P[1]!,
        cardUid: sandra.cardUid!,
      },
    ] as unknown as GameEvent[];

    const model = boardView(flipped, DEFAULT_CONFIG, {
      justVotedOut: flippedIn(events),
    });
    const [first, second] = model.players[1]!.castaways;
    expect(first).toMatchObject({ votedOut: true, justVotedOut: true });
    expect(second).toMatchObject({ votedOut: false, justVotedOut: false });

    // And in words: struck through.
    const text = boardText(flipped, DEFAULT_CONFIG);
    expect(text).toContain("~~Sandra Diaz-Twine~~");
    expect(text).toContain("**Tony Vlachos**");
  });

  it("marks the Jury, the departed and the winner", () => {
    const game = startedGame();
    const view = game.view();
    const ended = {
      ...view,
      winnerId: P[0]!,
      players: view.players.map((player, seat) =>
        seat === 1
          ? { ...player, eliminated: true }
          : seat === 2
            ? { ...player, departed: true }
            : player,
      ),
    };
    const model = boardView(ended, DEFAULT_CONFIG);
    expect(model.players.map((player) => player.status)).toEqual([
      "winner",
      "jury",
      "left",
    ]);
    expect(model.title).toBe("Sole Survivor");
    expect(model.subtitle).toContain("Player 0 is the Sole Survivor");
  });

  it("carries a portrait to the castaway it belongs to", () => {
    const game = startedGame();
    const photo = Buffer.from("portrait");
    const model = boardView(game.view(), DEFAULT_CONFIG, {
      portraits: (playerId, index) => (playerId === P[1] && index === 1 ? photo : null),
    });
    expect(model.players[1]!.castaways[1]!.image).toBe(photo);
    expect(model.players[1]!.castaways[0]!.image).toBeNull();
  });

  it("is a picture, where the platform can draw one", async () => {
    if (!canDraw) return;
    const png = await renderBoardImage(boardView(startedGame().view(), DEFAULT_CONFIG));
    expect(png?.readUInt32BE(0)).toBe(0x89504e47);
    expect(imageDimensions(png!)?.width).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// The session posts it
// ---------------------------------------------------------------------------

interface Sent {
  readonly files: readonly { readonly name: string | null }[];
  readonly title: string;
}

class FakeChannel {
  readonly sent: Sent[] = [];
  constructor(readonly id: string) {}
  send(payload: {
    embeds?: readonly { toJSON(): { title?: string } }[];
    files?: readonly { name: string | null }[];
  }): Promise<void> {
    this.sent.push({
      files: payload.files ?? [],
      title: payload.embeds?.[0]?.toJSON().title ?? "",
    });
    return Promise.resolve();
  }
  isDMBased(): boolean {
    return false;
  }
  isTextBased(): boolean {
    return true;
  }
  as(): GuildTextBasedChannel {
    return this as unknown as GuildTextBasedChannel;
  }
}

function session(boardImages: boolean): { session: GameSession; channel: FakeChannel } {
  const config: SurvivorConfig = withOverrides(DEFAULT_CONFIG, {
    autosave: { enabled: false },
    engine: { deck: { rngSeed: SEED } },
    discord: { boardImages },
  });
  const channel = new FakeChannel("1287654321098765432");
  const client = {
    users: { fetch: () => Promise.resolve({ send: () => Promise.resolve() }) },
    channels: { fetch: () => Promise.resolve(channel.as()) },
  } as unknown as Client;
  const registry = new SessionRegistry({
    config,
    store: new SaveStore({ config: config.autosave, logger: quiet }),
    logger: quiet,
    client,
  });
  const created = registry.create({ channel: channel.as(), hostId: P[0]!, seed: SEED });
  if (!isOk(created)) throw new Error("could not create a session");
  return { session: created.value, channel };
}

function begin(target: GameSession): void {
  for (const [i, id] of P.entries()) {
    const joined = target.apply({ type: "join_game", actor: id, displayName: `P${i}` });
    if (!joined.ok) throw new Error(joined.error.code);
  }
  const started = target.apply({ type: "start_game", actor: P[0]! });
  if (!started.ok) throw new Error(started.error.code);
}

describe("the session posts the board", () => {
  it("as the game begins, as a picture after the narration", async () => {
    if (!canDraw) return;
    const { session: live, channel } = session(true);
    begin(live);
    await live.drain();
    const boards = channel.sent.filter((message) =>
      message.files.some((file) => file.name === BOARD_FILE),
    );
    expect(boards).toHaveLength(1);
    expect(boards[0]?.title).toContain("The Tribe");
    expect(channel.sent.indexOf(boards[0]!)).toBe(channel.sent.length - 1);
    await live.dispose();
  });

  it("never, when board images are switched off", async () => {
    const { session: live, channel } = session(false);
    begin(live);
    await live.drain();
    expect(channel.sent.some((message) => message.files.length > 0)).toBe(false);
    await live.dispose();
  });

  it("keeps a portrait on the castaway it was given to, and drops it on request", async () => {
    const { session: live } = session(false);
    const photo = Buffer.from("portrait");
    expect(await live.setPortrait(P[0]!, 1, photo)).toBe(true);
    expect(live.portrait(P[0]!, 1)).toBe(photo);
    expect(live.portrait(P[0]!, 0)).toBeNull();
    await live.setPortrait(P[0]!, 1, null);
    expect(live.portrait(P[0]!, 1)).toBeNull();
    await live.dispose();
  });
});

// Keep the card-uid helper honest: a uid the board has never seen highlights nothing.
describe("flippedIn", () => {
  it("collects the cards a batch turned over and nothing else", () => {
    const events = [
      { type: "character_card_flipped", cardUid: asCardUid("c001:survivor_character") },
      { type: "card_drawn", cardUid: asCardUid("c002:sorry_for_you") },
    ] as unknown as GameEvent[];
    expect([...flippedIn(events)]).toEqual([asCardUid("c001:survivor_character")]);
  });
});
