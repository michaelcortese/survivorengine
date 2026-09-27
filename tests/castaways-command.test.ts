/**
 * `/castaways` AND THE LOBBY'S CASTAWAYS BUTTON
 *
 * The flows that turn what a player typed — into a form or into slash-command options — into
 * the one engine action, `name_castaways`. The engine's own rules are held in castaways.test.ts;
 * what is held here is the layer between:
 *
 *  - the lobby button and a bare `/castaways` open a form, prefilled, addressed to the presser;
 *  - in the lobby a blank field means "deal me a legend", and a presser not yet at the fire is
 *    seated first; once the game is under way a blank means "keep this one";
 *  - a form opened from the lobby card re-renders that card; anything else is answered privately;
 *  - a name made of nothing printable is refused, not quietly treated as blank;
 *  - a castaway renamed loses the old castaway's photo; a photo is fetched and checked before any
 *    name changes, and one for a castaway with no name is refused;
 *  - autocomplete suggests legends nobody else at the table has, and what was typed, first.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Client, GuildTextBasedChannel, ModalBuilder } from "discord.js";

import castaways, { searchLegends } from "../src/commands/castaways.js";
import { DEFAULT_CONFIG, withOverrides, type SurvivorConfig } from "../src/config.js";
import { boardImagesAvailable, imageDimensions } from "../src/discord/board-image.js";
import type {
  AutocompleteContext,
  CommandContext,
  ComponentContext,
  Payload,
  Responder,
} from "../src/discord/interactions.js";
import { SessionRegistry, type GameSession } from "../src/discord/registry.js";
import { UI_INTENT, parseCustomId } from "../src/discord/ui.js";
import {
  asPlayerId,
  isOk,
  type Action,
  type GameError,
  type PlayerId,
} from "../src/engine/types.js";
import type { Logger } from "../src/logger.js";
import { SaveStore } from "../src/persistence/store.js";

const SEED = 20250909;
const CHANNEL = "1287654321098765432";
const HOST = asPlayerId("9876543210987654321");
const GUEST = asPlayerId("1234567890123456789");
const THIRD = asPlayerId("1111111111111111111");
const LATE = asPlayerId("2222222222222222222");

const CONFIG: SurvivorConfig = withOverrides(DEFAULT_CONFIG, {
  autosave: { enabled: false },
  engine: { deck: { rngSeed: SEED } },
  discord: { boardImages: false },
});

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

let canDraw = false;
beforeAll(async () => {
  canDraw = await boardImagesAvailable();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Everything a handler said, by route. */
class FakeReply {
  readonly modals: ModalBuilder[] = [];
  readonly sent: string[] = [];
  readonly failures: (GameError | string)[] = [];
  readonly updates: Payload[] = [];

  showModal(modal: ModalBuilder): Promise<boolean> {
    this.modals.push(modal);
    return Promise.resolve(true);
  }
  send(payload: Payload): Promise<void> {
    this.sent.push(payload.content ?? "");
    return Promise.resolve();
  }
  fail(reason: GameError | string): Promise<void> {
    this.failures.push(reason);
    return Promise.resolve();
  }
  update(payload: Payload): Promise<void> {
    this.updates.push(payload);
    return Promise.resolve();
  }
  as(): Responder {
    return this as unknown as Responder;
  }
}

function newSession(): GameSession {
  const channel = {
    id: CHANNEL,
    isDMBased: () => false,
    isTextBased: () => true,
    send: () => Promise.resolve(),
  } as unknown as GuildTextBasedChannel;
  const registry = new SessionRegistry({
    config: CONFIG,
    store: new SaveStore({ config: CONFIG.autosave, logger: quiet }),
    logger: quiet,
    client: {} as Client,
  });
  const created = registry.create({ channel, hostId: HOST, seed: SEED });
  if (!isOk(created)) throw new Error("could not create a session");
  return created.value;
}

function apply(session: GameSession, action: Action): void {
  const out = session.apply(action);
  if (!out.ok) throw new Error(`${action.type}: ${out.error.code}`);
}

function lobby(): GameSession {
  const session = newSession();
  apply(session, { type: "join_game", actor: HOST, displayName: "Host" });
  apply(session, { type: "join_game", actor: GUEST, displayName: "Guest" });
  apply(session, { type: "join_game", actor: THIRD, displayName: "Third" });
  return session;
}

function running(): GameSession {
  const session = lobby();
  apply(session, { type: "start_game", actor: HOST });
  return session;
}

const castawaysOf = (session: GameSession, id: PlayerId): readonly (string | null)[] =>
  session
    .view()
    .players.find((player) => player.id === id)
    ?.castaways.map((c) => c.name) ?? [];

/** A component context for the form or the button. `form` present means a modal submission. */
function componentCtx(
  session: GameSession,
  actor: PlayerId,
  reply: FakeReply,
  form?: { readonly fields: readonly string[]; readonly fromLobbyCard: boolean },
): ComponentContext {
  const interaction = {
    isModalSubmit: () => form !== undefined,
    isFromMessage: () => form?.fromLobbyCard === true,
    fields: {
      getTextInputValue: (id: string): string => {
        const index = Number(id.replace("castaway", ""));
        const value = form?.fields[index];
        if (value === undefined) throw new Error(`no field ${id}`);
        return value;
      },
    },
  };
  return {
    interaction,
    reply: reply.as(),
    values: form?.fields ?? [],
    session,
    actor,
    config: CONFIG,
    log: quiet,
    nowMs: Date.now(),
    displayName: () => "Late Arrival",
    hasManageGuild: () => false,
    dispatch: (action: Action) => session.apply(action),
  } as unknown as ComponentContext;
}

interface Upload {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
}

function commandCtx(
  session: GameSession,
  actor: PlayerId,
  reply: FakeReply,
  options: {
    readonly first?: string;
    readonly second?: string;
    readonly first_photo?: Upload;
    readonly second_photo?: Upload;
  } = {},
): CommandContext {
  const lookup = options as Readonly<Record<string, unknown>>;
  return {
    interaction: {
      options: {
        getString: (name: string) => (lookup[name] as string | undefined) ?? null,
        getAttachment: (name: string) => (lookup[name] as Upload | undefined) ?? null,
      },
    },
    reply: reply.as(),
    actor,
    config: CONFIG,
    log: quiet,
    nowMs: Date.now(),
    requireSession: () => ({ ok: true, value: session }),
    dispatch: (target: GameSession, action: Action) => target.apply(action),
    displayName: () => "Late Arrival",
    hasManageGuild: () => false,
  } as unknown as CommandContext;
}

/** A refusal as the player reads it: a sentence, or a `GameError`'s developer message. */
const failureText = (reply: FakeReply): string => {
  const first = reply.failures[0];
  return first === undefined ? "" : typeof first === "string" ? first : first.message;
};

const route = (key: string) => {
  const handler = castaways.components?.[key];
  if (handler === undefined) throw new Error(`no ${key} route`);
  return handler;
};

const pressButton = route("name_castaways");
const submitForm = route(`${UI_INTENT.Confirm}:cst`);

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

describe("the castaway form", () => {
  it("opens from the lobby button, addressed to the presser and prefilled", async () => {
    const session = lobby();
    apply(session, {
      type: "name_castaways",
      actor: GUEST,
      castaways: ["Parvati Shallow", null],
    });
    const reply = new FakeReply();
    await pressButton(componentCtx(session, GUEST, reply));

    expect(reply.modals).toHaveLength(1);
    const modal = reply.modals[0]!.toJSON();
    const parsed = parseCustomId(modal.custom_id, CONFIG.discord);
    if (!parsed.ok) throw new Error("the form's id does not decode");
    expect(parsed.value.actor).toBe(GUEST);
    expect(parsed.value.intent).toEqual({ kind: "ui", ui: UI_INTENT.Confirm });
    expect(parsed.value.args[0]).toBe("cst");
    const inputs = JSON.stringify(modal.components);
    expect(inputs).toContain("Parvati Shallow");
    expect(inputs).toContain("Castaway #1");
    expect(inputs).toContain("Castaway #2");
  });

  it("opens from a bare /castaways too", async () => {
    const session = running();
    const reply = new FakeReply();
    await castaways.execute(commandCtx(session, GUEST, reply));
    expect(reply.modals).toHaveLength(1);
    expect(reply.failures).toEqual([]);
  });

  it("in the lobby: a blank is a random legend, and the card itself is re-rendered", async () => {
    const session = lobby();
    const reply = new FakeReply();
    await submitForm(
      componentCtx(session, GUEST, reply, {
        fields: ["  parvati   Shallow ", ""],
        fromLobbyCard: true,
      }),
    );
    expect(reply.failures).toEqual([]);
    expect(castawaysOf(session, GUEST)).toEqual(["parvati Shallow", null]);
    expect(reply.updates).toHaveLength(1);
    expect(JSON.stringify(reply.updates[0]?.embeds?.[0]?.toJSON())).toContain(
      "parvati Shallow",
    );
  });

  it("seats somebody who pressed it before joining", async () => {
    const session = lobby();
    const reply = new FakeReply();
    await submitForm(
      componentCtx(session, LATE, reply, {
        fields: ["Q Burdette", "Cirie Fields"],
        fromLobbyCard: true,
      }),
    );
    expect(session.hasPlayer(LATE)).toBe(true);
    expect(castawaysOf(session, LATE)).toEqual(["Q Burdette", "Cirie Fields"]);
  });

  it("during the game: a blank keeps what is there, and the answer is private", async () => {
    const session = running();
    const before = castawaysOf(session, GUEST);
    await session.setPortrait(GUEST, 1, Buffer.from("old photo"));
    await session.setPortrait(GUEST, 0, Buffer.from("kept photo"));
    const reply = new FakeReply();
    await submitForm(
      componentCtx(session, GUEST, reply, {
        fields: ["", "Rob Cesternino"],
        fromLobbyCard: false,
      }),
    );
    expect(reply.failures).toEqual([]);
    expect(castawaysOf(session, GUEST)).toEqual([before[0], "Rob Cesternino"]);
    expect(reply.sent[0]).toContain("**Rob Cesternino**");
    // A renamed castaway does not keep the last castaway's photo; the other one keeps its own.
    expect(session.portrait(GUEST, 1)).toBeNull();
    expect(session.portrait(GUEST, 0)?.toString()).toBe("kept photo");
  });

  it("refuses a name with nothing printable in it, and changes nothing", async () => {
    const session = lobby();
    const reply = new FakeReply();
    await submitForm(
      componentCtx(session, GUEST, reply, {
        fields: ["🔥🔥🔥", ""],
        fromLobbyCard: true,
      }),
    );
    expect(reply.failures).toHaveLength(1);
    expect((reply.failures[0] as GameError).code).toBe("castaway_name_invalid");
    expect(castawaysOf(session, GUEST)).toEqual([null, null]);
  });

  it("hands a refusal from the engine straight back", async () => {
    const session = lobby();
    apply(session, {
      type: "name_castaways",
      actor: HOST,
      castaways: ["Tony Vlachos", null],
    });
    const reply = new FakeReply();
    await submitForm(
      componentCtx(session, GUEST, reply, {
        fields: ["tony vlachos", ""],
        fromLobbyCard: true,
      }),
    );
    expect((reply.failures[0] as GameError).code).toBe("castaway_name_taken");
  });
});

// ---------------------------------------------------------------------------
// The slash command with options
// ---------------------------------------------------------------------------

describe("/castaways with names", () => {
  it("sets only what was given, and re-renders the lobby card where it is", async () => {
    const session = lobby();
    const edits: unknown[] = [];
    session.lobbyCard = {
      edit: (payload: unknown) => {
        edits.push(payload);
        return Promise.resolve();
      },
    } as unknown as GameSession["lobbyCard"];
    apply(session, {
      type: "name_castaways",
      actor: GUEST,
      castaways: ["Sue Hawk", null],
    });

    const reply = new FakeReply();
    await castaways.execute(
      commandCtx(session, GUEST, reply, { second: "Kelly Wiglesworth" }),
    );
    expect(reply.failures).toEqual([]);
    expect(castawaysOf(session, GUEST)).toEqual(["Sue Hawk", "Kelly Wiglesworth"]);
    expect(edits).toHaveLength(1);
    expect(reply.sent[0]).toContain("Your castaways");
  });

  it("refuses a photo for a castaway with no name", async () => {
    const session = lobby();
    const reply = new FakeReply();
    await castaways.execute(
      commandCtx(session, GUEST, reply, {
        first: "Sue Hawk",
        second_photo: {
          name: "me.png",
          contentType: "image/png",
          size: 100,
          url: "https://example.invalid/me.png",
        },
      }),
    );
    expect(failureText(reply)).toContain("castaway #2 a name too");
    expect(castawaysOf(session, GUEST)).toEqual([null, null]);
  });

  it("refuses an upload that is not a supported image, before changing any name", async () => {
    const session = lobby();
    const reply = new FakeReply();
    await castaways.execute(
      commandCtx(session, GUEST, reply, {
        first: "Sue Hawk",
        first_photo: {
          name: "notes.pdf",
          contentType: "application/pdf",
          size: 100,
          url: "https://example.invalid/notes.pdf",
        },
      }),
    );
    expect(failureText(reply)).toContain("is not a PNG, JPEG, WebP or GIF image");
    expect(castawaysOf(session, GUEST)).toEqual([null, null]);
  });

  it("fetches a photo, keeps a portrait of it, and puts it on the castaway", async () => {
    if (!canDraw) return;
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(300, 300);
    canvas.getContext("2d").fillRect(0, 0, 300, 300);
    const png = await canvas.encode("png");
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(new Uint8Array(png))));

    const session = running();
    const reply = new FakeReply();
    await castaways.execute(
      commandCtx(session, GUEST, reply, {
        first_photo: {
          name: "me.png",
          contentType: "image/png",
          size: png.length,
          url: "https://cdn.discordapp.com/me.png",
        },
      }),
    );
    expect(reply.failures).toEqual([]);
    const portrait = session.portrait(GUEST, 0);
    expect(portrait).not.toBeNull();
    expect(imageDimensions(portrait!)).toEqual({ width: 240, height: 288 });
    expect(reply.sent[0]).toContain("📷");
  });
});

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

describe("suggesting castaways", () => {
  it("matches the start of any word first, then anywhere", () => {
    const found = searchLegends("rob", new Set(), 25);
    expect(found[0]).toMatch(/\bRob/);
    expect(found).toContain("Boston Rob Mariano");
    expect(found).toContain("Rob Cesternino");
  });

  it("leaves out castaways somebody else at the table already has", async () => {
    const session = lobby();
    apply(session, {
      type: "name_castaways",
      actor: HOST,
      castaways: ["Rob Cesternino", null],
    });
    const choices: string[] = [];
    const ctx = {
      interaction: { channelId: CHANNEL },
      focused: { name: "first", value: "Rob" },
      registry: { get: () => session },
      config: CONFIG,
      log: quiet,
      actor: GUEST,
      respond: (list: readonly { name: string }[]) => {
        choices.push(...list.map((choice) => choice.name));
        return Promise.resolve();
      },
    } as unknown as AutocompleteContext;
    await castaways.autocomplete?.(ctx);
    expect(choices).not.toContain("Rob Cesternino");
    expect(choices).toContain("Boston Rob Mariano");
  });

  it("offers what was typed first when it is somebody new", async () => {
    const choices: string[] = [];
    const ctx = {
      interaction: { channelId: CHANNEL },
      focused: { name: "first", value: "My Cousin **Vinny**" },
      registry: { get: () => null },
      config: CONFIG,
      log: quiet,
      actor: GUEST,
      respond: (list: readonly { name: string }[]) => {
        choices.push(...list.map((choice) => choice.name));
        return Promise.resolve();
      },
    } as unknown as AutocompleteContext;
    await castaways.autocomplete?.(ctx);
    expect(choices[0]).toBe("My Cousin Vinny");
  });
});
