/**
 * THE ACKNOWLEDGEMENT DISCIPLINE, AND THE ROUTER — the layer between a real click and
 * everything the other suites prove.
 *
 * `src/discord/interactions.ts` is the class four separate audit findings reduce to:
 *
 *   #45  a command called `followUp()` first                   -> InteractionNotReplied
 *   #46  a command called `reply()` twice                      -> InteractionAlreadyReplied
 *   #42  a command acknowledged nothing at all                 -> "The application did not respond"
 *   #89  a command deferred and then replied                   -> InteractionAlreadyReplied
 *
 * It holds a three-state machine, two serialising promise chains, an auto-defer timer and six
 * methods that each branch on `#state` and `#deferKind` — and nothing constructed it. Neither
 * did anything construct `src/events/interactionCreate.ts`, the five-gate check that decides
 * whether a press may touch a game at all (the incarnation check that closes audit #78, the
 * `mayPress` check that closes #30/#47). A refactor could change either and leave every gate
 * green.
 *
 * WHAT IS ASSERTED, and the promise each assertion holds the code to:
 *
 *  - interactions.ts header: "a property of the class rather than a rule people remember" —
 *    EXACTLY ONE acknowledgement per interaction, whatever order the methods are called in,
 *    and never a forbidden pair (reply-then-reply, followUp-before-reply, defer-then-reply).
 *  - `armAutoDefer`: "so a slow handler cannot produce that message no matter what it forgets
 *    to do" — including when the handler's first act is an `announce()` that takes longer than
 *    Discord's three-second deadline.
 *  - THE VISIBILITY RULE: "`send()` whispers, `announce()` speaks, and neither can be mistaken
 *    for the other."
 *  - `update`/`disableSource`: an ephemeral message is NOT reachable through
 *    `PATCH /channels/{id}/messages/{id}`, so killing dead components must use the webhook.
 *  - interactionCreate's five gates, each refusing with its own sentence and touching no game.
 *
 * HOW TIME IS FAKED. Only `setTimeout`/`clearTimeout`/`Date`, so promises still settle on a
 * real microtask queue. The slow-channel test measures the ORDER of calls, not wall-clock ms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client, GuildTextBasedChannel, RepliableInteraction } from "discord.js";

import { DEFAULT_CONFIG, withOverrides, type SurvivorConfig } from "../src/config.js";
import type {
  BotContext,
  Command,
  ComponentHandler,
  Payload,
} from "../src/discord/interactions.js";
import { Responder } from "../src/discord/interactions.js";
import { SessionRegistry, type GameSession } from "../src/discord/registry.js";
import type { OutgoingMessage } from "../src/discord/render.js";
import { UI_INTENT, encode, type CustomIdParts } from "../src/discord/ui.js";
import interactionCreate from "../src/events/interactionCreate.js";
import type { Action, PlayerId, Result } from "../src/engine/types.js";
import { asPlayerId, isOk } from "../src/engine/types.js";
import type { LogFields, Logger } from "../src/logger.js";
import { SaveStore } from "../src/persistence/store.js";

// ---------------------------------------------------------------------------
// Recording doubles
// ---------------------------------------------------------------------------

interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    debug: (message: string, _fields?: LogFields) =>
      lines.push({ level: "debug", message }),
    info: (message: string, _fields?: LogFields) =>
      lines.push({ level: "info", message }),
    warn: (message: string, _fields?: LogFields) =>
      lines.push({ level: "warn", message }),
    error: (message: string, _cause?: unknown, _fields?: LogFields) =>
      lines.push({ level: "error", message }),
    child: () => make(),
  });
  return make();
}

/** Every call the Responder made on the interaction, in order. */
type CallName =
  | "reply"
  | "deferReply"
  | "deferUpdate"
  | "editReply"
  | "followUp"
  | "update"
  | "message.edit"
  | "webhook.editMessage"
  | "channel.send";

interface Call {
  readonly name: CallName;
  readonly at: number;
}

interface FakeOptions {
  /** A message component (a button press) rather than a chat command. */
  readonly component?: boolean;
  /** The source message is ephemeral, so the channel edit route does not exist for it. */
  readonly ephemeralSource?: boolean;
  /** Make `channel.send` take this many milliseconds of FAKE time before resolving. */
  readonly slowChannelSendMs?: number;
  readonly customId?: string;
  readonly userId?: string;
  readonly channelId?: string;
  /** Make `webhook.editMessage` throw, to exercise the channel-route fallback. */
  readonly webhookEditFails?: boolean;
}

/**
 * A `RepliableInteraction` that records what was called on it and enforces Discord's own rules.
 *
 * The point of the throws: the class under test exists so that these can never happen, so the
 * double asserts them rather than the tests remembering to.
 */
class FakeInteraction {
  readonly calls: Call[] = [];
  readonly channelSends: Payload[] = [];
  replied = false;
  deferred = false;

  readonly customId: string;
  readonly channelId: string;
  readonly user: { id: string; displayName: string };
  readonly member = null;
  readonly memberPermissions = null;
  readonly message: {
    id: string;
    components: readonly never[];
    flags: { has: () => boolean };
    edit: (options: unknown) => Promise<void>;
  };
  readonly webhook: { editMessage: (id: string, options: unknown) => Promise<void> };
  readonly channel: {
    id: string;
    isSendable: () => boolean;
    isDMBased: () => boolean;
    isTextBased: () => boolean;
    send: (payload: Payload) => Promise<{ id: string }>;
  };

  #order = 0;
  readonly #component: boolean;

  constructor(private readonly options: FakeOptions = {}) {
    this.#component = options.component === true;
    this.customId = options.customId ?? "sv|0|ui|0||0-0";
    this.channelId = options.channelId ?? "chan-ack";
    this.user = { id: options.userId ?? "1000000000000000001", displayName: "Tester" };
    this.message = {
      id: "msg-1",
      components: [],
      flags: { has: () => options.ephemeralSource === true },
      edit: (): Promise<void> => {
        this.#record("message.edit");
        return Promise.resolve();
      },
    };
    this.webhook = {
      editMessage: (): Promise<void> => {
        this.#record("webhook.editMessage");
        return options.webhookEditFails === true
          ? Promise.reject(new Error("404 Unknown Message"))
          : Promise.resolve();
      },
    };
    this.channel = {
      id: this.channelId,
      isSendable: () => true,
      isDMBased: () => false,
      isTextBased: () => true,
      send: async (payload: Payload) => {
        this.#record("channel.send");
        this.channelSends.push(payload);
        const delay = this.options.slowChannelSendMs ?? 0;
        if (delay > 0) await sleepFake(delay);
        return { id: "posted-1" };
      },
    };
  }

  #record(name: CallName): void {
    this.calls.push({ name, at: (this.#order += 1) });
  }

  isMessageComponent(): boolean {
    return this.#component;
  }
  isRepliable(): boolean {
    return true;
  }
  isAnySelectMenu(): boolean {
    return false;
  }
  isChatInputCommand(): boolean {
    return !this.#component;
  }
  isAutocomplete(): boolean {
    return false;
  }
  isModalSubmit(): boolean {
    return false;
  }

  reply(): Promise<void> {
    if (this.replied || this.deferred) throw new Error("InteractionAlreadyReplied");
    this.replied = true;
    this.#record("reply");
    return Promise.resolve();
  }

  deferReply(): Promise<void> {
    if (this.replied || this.deferred) throw new Error("InteractionAlreadyReplied");
    this.deferred = true;
    this.#record("deferReply");
    return Promise.resolve();
  }

  deferUpdate(): Promise<void> {
    if (this.replied || this.deferred) throw new Error("InteractionAlreadyReplied");
    this.deferred = true;
    this.#record("deferUpdate");
    return Promise.resolve();
  }

  update(): Promise<void> {
    if (this.replied || this.deferred) throw new Error("InteractionAlreadyReplied");
    this.replied = true;
    this.#record("update");
    return Promise.resolve();
  }

  editReply(): Promise<void> {
    if (!this.replied && !this.deferred) throw new Error("InteractionNotReplied");
    this.replied = true;
    this.#record("editReply");
    return Promise.resolve();
  }

  followUp(): Promise<void> {
    if (!this.replied && !this.deferred) throw new Error("InteractionNotReplied");
    this.#record("followUp");
    return Promise.resolve();
  }

  names(): CallName[] {
    return this.calls.map((call) => call.name);
  }

  /** How many of the calls Discord counts as THE acknowledgement were made. */
  acknowledgements(): number {
    const acks: readonly CallName[] = ["reply", "deferReply", "deferUpdate", "update"];
    return this.calls.filter((call) => acks.includes(call.name)).length;
  }

  as(): RepliableInteraction {
    return this as unknown as RepliableInteraction;
  }
}

/** A fake-timer sleep, so a "slow" network call costs no real time. */
function sleepFake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const CONFIG: SurvivorConfig = withOverrides(DEFAULT_CONFIG, {
  engine: { deck: { rngSeed: 20250909 } },
});

let logLines: LogLine[];

function makeResponder(interaction: RepliableInteraction): Responder {
  return new Responder(interaction, CONFIG, recordingLogger(logLines));
}

beforeEach(() => {
  logLines = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Exactly one acknowledgement
// ---------------------------------------------------------------------------

describe("the Responder acknowledges exactly once, from every starting state", () => {
  it("answers a fresh command interaction with a single reply", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    await responder.send({ content: "hello" });

    expect(fake.names()).toEqual(["reply"]);
    expect(fake.acknowledgements()).toBe(1);
    expect(responder.state).toBe("replied");
  });

  it("fills in a deferred reply with editReply rather than a second reply (audit #89)", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    await responder.defer();
    await responder.send({ content: "the answer" });

    expect(fake.names()).toEqual(["deferReply", "editReply"]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("follows up rather than replying twice (audit #46)", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    await responder.send({ content: "one" });
    await responder.send({ content: "two" });
    await responder.send({ content: "three" });

    expect(fake.names()).toEqual(["reply", "followUp", "followUp"]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("never follows up before it has replied (audit #45)", async () => {
    // Every ordering of the four talking methods, each on its own fresh interaction: the first
    // call must always be an acknowledgement and there must never be a second one.
    const openings: readonly (readonly [string, (r: Responder) => Promise<unknown>])[] =
      [
        ["send", (r) => r.send({ content: "x" })],
        ["fail", (r) => r.fail("no")],
        ["deliver", (r) => r.deliver({ content: "psst" })],
        ["defer", (r) => r.defer()],
      ];
    for (const [name, first] of openings) {
      for (const [, second] of openings) {
        const fake = new FakeInteraction();
        const responder = makeResponder(fake.as());
        await first(responder);
        await second(responder);
        expect(fake.acknowledgements(), `${name} then the next call`).toBe(1);
        expect(fake.names()[0], `${name} must acknowledge first`).not.toBe("followUp");
        expect(fake.names()[0]).not.toBe("editReply");
      }
    }
  });

  it("defers a component as an UPDATE, leaving both send() and update() available", async () => {
    const fake = new FakeInteraction({ component: true });
    const responder = makeResponder(fake.as());

    await responder.deferUpdate();
    expect(responder.state).toBe("deferred");
    await responder.update({ content: "re-rendered" });
    await responder.send({ content: "and privately" });

    expect(fake.names()).toEqual(["deferUpdate", "editReply", "followUp"]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("is idempotent: defer() and deferUpdate() called twice acknowledge once", async () => {
    const fake = new FakeInteraction({ component: true });
    const responder = makeResponder(fake.as());

    await responder.deferUpdate();
    await responder.deferUpdate();
    await responder.defer();

    expect(fake.acknowledgements()).toBe(1);
    expect(fake.names()).toEqual(["deferUpdate"]);
  });

  it("deferUpdate() is a no-op off a message component, and acknowledges nothing", async () => {
    const fake = new FakeInteraction({ component: false });
    const responder = makeResponder(fake.as());

    await responder.deferUpdate();

    expect(fake.names()).toEqual([]);
    expect(responder.acknowledged).toBe(false);
  });

  it("survives a transport failure without throwing at the handler", async () => {
    const fake = new FakeInteraction();
    fake.reply = (): Promise<void> =>
      Promise.reject(new Error("10062 Unknown Interaction"));
    const responder = makeResponder(fake.as());

    await expect(responder.send({ content: "hi" })).resolves.toBeUndefined();
    expect(logLines.some((line) => line.level === "warn")).toBe(true);
  });

  it("reports a failed delivery as false so the courier can fall back to a DM", async () => {
    const fake = new FakeInteraction();
    fake.reply = (): Promise<void> => Promise.reject(new Error("10062"));
    const responder = makeResponder(fake.as());

    await expect(responder.deliver({ content: "your hand" })).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The auto-defer, and the deadline it exists to protect
// ---------------------------------------------------------------------------

describe("the auto-defer beats Discord's three-second deadline", () => {
  it("acknowledges on the handler's behalf when nothing else does (audit #16/#42)", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    const startedAt = Date.now();
    responder.armAutoDefer();
    expect(fake.names()).toEqual([]);
    await vi.advanceTimersByTimeAsync(CONFIG.discord.autoDeferAfter + 1);

    expect(fake.names()).toEqual(["deferReply"]);
    // Comfortably inside the three seconds Discord allows before it closes the interaction.
    expect(Date.now() - startedAt).toBeLessThan(CONFIG.discord.initialResponseDeadline);
  });

  it("is disarmed by a handler that answers in time", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    responder.armAutoDefer();
    await responder.send({ content: "quick" });
    await vi.advanceTimersByTimeAsync(CONFIG.discord.autoDeferAfter * 3);

    expect(fake.names()).toEqual(["reply"]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("is NOT delayed by a slow announce() — the defect that put audit #16/#42 back", async () => {
    // `announce()` is a `channel.send` and never touches the interaction, but it used to be
    // queued on the SAME promise chain as `defer()`. A send delayed past ~3s by discord.js's
    // per-channel bucket (5 messages / 5s — exactly what a busy Tribal Council produces)
    // therefore held the acknowledgement behind it: the defer landed AFTER Discord had already
    // closed the interaction, `deferReply` failed with 10062, and the player who typed
    // `/status` saw the red "The application did not respond".
    const slow = CONFIG.discord.initialResponseDeadline * 2;
    const fake = new FakeInteraction({ slowChannelSendMs: slow });
    const responder = makeResponder(fake.as());

    responder.armAutoDefer();
    const announced = responder.announce({ content: "the board" });

    // The acknowledgement must land at the auto-defer mark, NOT behind the channel send.
    await vi.advanceTimersByTimeAsync(CONFIG.discord.autoDeferAfter + 1);
    const ackIndex = fake.calls.findIndex((call) => call.name === "deferReply");
    expect(ackIndex, "the interaction was never acknowledged in time").toBeGreaterThan(
      -1,
    );

    await vi.advanceTimersByTimeAsync(slow + 1);
    await announced;

    const sendDone = fake.calls.findIndex((call) => call.name === "channel.send");
    expect(sendDone, "the announce did go out").toBeGreaterThan(-1);
    expect(fake.acknowledgements()).toBe(1);
    // And it acknowledged strictly before the interaction's deadline.
    const ackAt = fake.calls[ackIndex]?.at ?? Number.MAX_SAFE_INTEGER;
    expect(ackAt).toBeLessThanOrEqual(2);
  });

  it("keeps announces in order among themselves", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    const first = responder.announce({ content: "one" });
    const second = responder.announce({ content: "two" });
    await Promise.all([first, second]);

    expect(fake.channelSends.map((payload) => payload.content)).toEqual(["one", "two"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The visibility rule
// ---------------------------------------------------------------------------

describe("send() whispers and announce() speaks", () => {
  it("never posts a send() to the channel", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    await responder.send({ content: "for your eyes only" });

    expect(fake.channelSends).toHaveLength(0);
    expect(fake.names()).toEqual(["reply"]);
  });

  it("never acknowledges the interaction from an announce()", async () => {
    const fake = new FakeInteraction();
    const responder = makeResponder(fake.as());

    await responder.announce({ content: "everybody" });

    expect(fake.acknowledgements()).toBe(0);
    expect(responder.acknowledged).toBe(false);
    expect(fake.channelSends.map((p) => p.content)).toEqual(["everybody"]);
  });

  it("returns null from announce() when the channel refuses it", async () => {
    const fake = new FakeInteraction();
    fake.channel.send = (): Promise<{ id: string }> =>
      Promise.reject(new Error("50013 Missing Permissions"));
    const responder = makeResponder(fake.as());

    await expect(responder.announce({ content: "x" })).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Killing a dead component, ephemeral included
// ---------------------------------------------------------------------------

describe("disableSource kills components on ephemeral surfaces too (audit #88)", () => {
  it("uses interaction.update() while the responder is still fresh", async () => {
    const fake = new FakeInteraction({ component: true, ephemeralSource: true });
    const responder = makeResponder(fake.as());

    await responder.disableSource();

    expect(fake.names()).toEqual(["update"]);
  });

  it("uses the WEBHOOK route once it has already replied, never the channel route", async () => {
    // `Message#edit` is `PATCH /channels/{channel.id}/messages/{id}`, and an ephemeral message
    // does not exist on that route: Discord answers 404 and `#enqueue` swallows it as a warn,
    // so the buttons stayed live on every ephemeral surface in the bot — the `/hand` pages, the
    // `/council` panel, the `/vote` ballot, the `/play` menus, the abandon confirmation.
    const fake = new FakeInteraction({ component: true, ephemeralSource: true });
    const responder = makeResponder(fake.as());

    await responder.send({ content: "that button belongs to an earlier game" });
    await responder.disableSource();

    expect(fake.names()).toContain("webhook.editMessage");
    expect(fake.names()).not.toContain("message.edit");
  });

  it("falls back to the channel route for a NON-ephemeral message when the token is gone", async () => {
    const fake = new FakeInteraction({
      component: true,
      ephemeralSource: false,
      webhookEditFails: true,
    });
    const responder = makeResponder(fake.as());

    await responder.send({ content: "refused" });
    await responder.disableSource();

    expect(fake.names()).toContain("webhook.editMessage");
    expect(fake.names()).toContain("message.edit");
  });

  it("update() after a reply edits the source message rather than the wrong one", async () => {
    const fake = new FakeInteraction({ component: true });
    const responder = makeResponder(fake.as());

    await responder.send({ content: "a note" });
    await responder.update({ content: "the panel, redrawn" });

    expect(fake.names()).toEqual(["reply", "webhook.editMessage"]);
    expect(fake.acknowledgements()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The router's five gates
// ---------------------------------------------------------------------------

const HOST = "2000000000000000001";
const OTHER = "2000000000000000002";
const CHANNEL_ID = "3000000000000000001";

interface Rig {
  readonly bot: BotContext;
  readonly session: GameSession;
  readonly registry: SessionRegistry;
  readonly channel: { readonly sent: OutgoingMessage[] };
  readonly handled: string[];
}

/** A real registry over a real engine, with a channel that only records. */
function rig(
  options: { readonly routes?: Record<string, ComponentHandler> } = {},
): Rig {
  const logger = recordingLogger(logLines);
  const sent: OutgoingMessage[] = [];
  const channel = {
    id: CHANNEL_ID,
    sent,
    send: (payload: OutgoingMessage): Promise<void> => {
      sent.push(payload);
      return Promise.resolve();
    },
    isDMBased: () => false,
    isTextBased: () => true,
    isSendable: () => true,
  };
  const config = withOverrides(CONFIG, { autosave: { enabled: false } });
  const store = new SaveStore({ config: config.autosave, logger });
  const client = {
    users: { fetch: () => Promise.resolve({ send: () => Promise.resolve() }) },
    channels: {
      fetch: () => Promise.resolve(channel as unknown as GuildTextBasedChannel),
    },
  } as unknown as Client;
  const registry = new SessionRegistry({ config, store, logger, client });
  const created = registry.create({
    channel: channel as unknown as GuildTextBasedChannel,
    hostId: asPlayerId(HOST),
    seed: 20250909,
  });
  if (!isOk(created)) throw new Error("could not create the session");
  const session = created.value;

  const handled: string[] = [];
  const routes = new Map<string, ComponentHandler>();
  for (const [key, handler] of Object.entries(options.routes ?? {})) {
    routes.set(key, async (ctx) => {
      handled.push(key);
      await handler(ctx);
    });
  }

  const bot: BotContext = {
    client,
    config,
    registry,
    store,
    log: logger,
    commands: new Map<string, Command>(),
    components: routes,
  };
  return { bot, session, registry, channel, handled };
}

function idFor(session: GameSession, overrides: Partial<CustomIdParts> = {}): string {
  const parts: CustomIdParts = {
    gameId: session.gameId,
    intent: "join_game",
    actor: asPlayerId(HOST),
    incarnation: session.incarnation,
    seq: session.seq,
    ...overrides,
  };
  const built = encode(parts, CONFIG.discord);
  if (!isOk(built)) throw new Error(`could not encode: ${built.error.message}`);
  return built.value;
}

async function press(bot: BotContext, fake: FakeInteraction): Promise<void> {
  await interactionCreate.execute(bot, fake as unknown as never);
}

describe("the router proves a press is valid before anything touches a game", () => {
  it("routes a decodable component to the command that claimed it", async () => {
    let sawActor: PlayerId | null = null;
    const r = rig({
      routes: {
        join_game: async (ctx) => {
          sawActor = ctx.actor;
          await ctx.reply.send({ content: "joined" });
        },
      },
    });
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(r.handled).toEqual(["join_game"]);
    expect(sawActor).toBe(asPlayerId(HOST));
    expect(fake.acknowledgements()).toBe(1);
  });

  it("refuses a component that names another player (audit #30/#47)", async () => {
    const r = rig({ routes: { join_game: () => Promise.resolve() } });
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session, { actor: asPlayerId(HOST) }),
      userId: OTHER,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(r.handled, "another player's button must never reach a handler").toEqual([]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("refuses a component minted for the PREVIOUS game in this channel (audit #78)", async () => {
    const r = rig({ routes: { join_game: () => Promise.resolve() } });
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session, { incarnation: r.session.incarnation - 1 }),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(r.handled).toEqual([]);
    // A refused component is killed so the next click produces an explanation, not a failure —
    // and the kill goes out FIRST, while the responder can still use interaction.update().
    expect(fake.names()[0]).toBe("update");
    expect(fake.acknowledgements()).toBe(1);
  });

  it("ignores a custom_id belonging to another application", async () => {
    const r = rig({ routes: { join_game: () => Promise.resolve() } });
    const fake = new FakeInteraction({
      component: true,
      customId: "someotherbot|whatever|x",
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(r.handled).toEqual([]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("acknowledges an inert placeholder and says nothing at all", async () => {
    const r = rig();
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session, { intent: UI_INTENT.Inert }),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(fake.names()).toEqual(["deferUpdate"]);
    expect(r.channel.sent).toHaveLength(0);
  });

  it("leaves the game untouched when a handler throws, and still answers the player", async () => {
    const r = rig({
      routes: {
        join_game: () => {
          throw new Error("handler is broken");
        },
      },
    });
    const before = r.session.snapshot().state;
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(r.session.snapshot().state).toEqual(before);
    expect(fake.acknowledgements()).toBe(1);
    expect(logLines.some((line) => line.level === "error")).toBe(true);
  });

  it("dispatches an unclaimed engine action straight from the custom_id", async () => {
    const r = rig();
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session, { intent: "join_game", actor: asPlayerId(HOST) }),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(
      r.session.view().players.map((player) => player.id),
      "the generic path must have applied the action",
    ).toContain(asPlayerId(HOST));
    expect(fake.acknowledgements()).toBe(1);
  });

  it("refuses every press once the channel's game is gone", async () => {
    const r = rig({ routes: { join_game: () => Promise.resolve() } });
    const id = idFor(r.session);
    await r.registry.dispose(r.session.gameId);

    const fake = new FakeInteraction({
      component: true,
      customId: id,
      userId: HOST,
      channelId: CHANNEL_ID,
    });
    await press(r.bot, fake);

    expect(r.handled).toEqual([]);
    expect(fake.acknowledgements()).toBe(1);
  });

  it("answers a command Discord knows about but this build does not (audit #57/#61/#103)", async () => {
    const r = rig();
    const fake = new FakeInteraction({ component: false, channelId: CHANNEL_ID });
    const asCommand = fake as unknown as {
      commandName: string;
      options: { getFocused: () => unknown };
    };
    asCommand.commandName = "not-a-real-command";

    await press(r.bot, fake);

    expect(fake.acknowledgements()).toBe(1);
    expect(
      logLines.some(
        (line) =>
          line.level === "error" &&
          line.message.includes("no handler for a registered"),
      ),
    ).toBe(true);
  });

  it("acknowledges a command that answered nothing, so nobody watches 'thinking…' forever", async () => {
    const r = rig();
    const commands = new Map<string, Command>();
    let ran = false;
    commands.set("quiet", {
      data: { name: "quiet", toJSON: () => ({}) } as Command["data"],
      execute: (): Promise<void> => {
        ran = true;
        return Promise.resolve();
      },
    });
    const bot: BotContext = { ...r.bot, commands };
    const fake = new FakeInteraction({ component: false, channelId: CHANNEL_ID });
    (fake as unknown as { commandName: string }).commandName = "quiet";

    await press(bot, fake);

    expect(ran).toBe(true);
    expect(fake.acknowledgements()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The dispatch path a component handler is given
// ---------------------------------------------------------------------------

describe("ComponentContext carries the decisions the layer must not re-derive", () => {
  it("hands a handler the SAME Manage Server answer a command gets", async () => {
    let sawManageGuild: boolean | null = null;
    const r = rig({
      routes: {
        join_game: async (ctx) => {
          sawManageGuild = ctx.hasManageGuild();
          await ctx.reply.send({ content: "ok" });
        },
      },
    });
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    // `memberPermissions` is null on the double, which is the "not a moderator" answer — the
    // point is that the handler HAS the answer rather than reimplementing the check.
    expect(sawManageGuild).toBe(false);
  });

  it("refuses a dispatch the engine rejects, and changes nothing", async () => {
    let outcome: Result<unknown> | null = null;
    const r = rig({
      routes: {
        start_game: async (ctx) => {
          const action: Action = {
            type: "start_game",
            actor: ctx.actor,
            firstPlayer: ctx.actor,
          };
          outcome = ctx.dispatch(action);
          await ctx.reply.send({ content: "tried" });
        },
      },
    });
    const before = r.session.snapshot().state;
    const fake = new FakeInteraction({
      component: true,
      customId: idFor(r.session, { intent: "start_game" }),
      userId: HOST,
      channelId: CHANNEL_ID,
    });

    await press(r.bot, fake);

    expect(outcome).not.toBeNull();
    expect(outcome && isOk(outcome)).toBe(false);
    expect(r.session.snapshot().state).toEqual(before);
  });
});
