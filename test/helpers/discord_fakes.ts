/**
 * Minimal stand-ins for the discord.js objects the bot touches, so game flows
 * can run in tests without connecting to Discord. Every message is recorded.
 */
import { EventEmitter } from "node:events";
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
} from "discord.js";
import { GameConfig } from "../../src/game/config";

export interface Payload {
  content?: string;
  embeds?: unknown[];
  files?: unknown[];
  components?: unknown[];
  flags?: unknown;
}

function normalize(payload: unknown): Payload {
  if (typeof payload === "string") return { content: payload };
  return { ...(payload as Payload) };
}

/** Speeds every timer up so full councils run in milliseconds. */
export function useFastTimings(overrides: Partial<typeof GameConfig.timings> = {}) {
  Object.assign(GameConfig.timings, {
    discussionMs: 0,
    votingMs: 0,
    idolWindowMs: 0,
    nullifierWindowMs: 0,
    sorryForYouWindowMs: 30,
    tieBreakMs: 60_000,
    finalVoteMs: 60_000,
    voteReadMs: 0,
    suspenseMs: 0,
    lobbyMs: 60_000,
    menuMs: 40,
    ...overrides,
  });
}

export class FakeCollector extends EventEmitter {
  ended = false;
  private timer?: NodeJS.Timeout;

  constructor(options: { time?: number } = {}) {
    super();
    // Like discord.js, a missing or zero `time` means the collector never times out.
    if (options.time) this.timer = setTimeout(() => this.stop("time"), options.time);
  }

  stop(reason = "user") {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.emit("end", new Map(), reason);
  }

  /** Simulates a user clicking a component on the message. */
  async click(interaction: unknown) {
    const listeners = this.listeners("collect");
    await Promise.all(listeners.map((listener) => listener(interaction)));
  }
}

let nextMessageId = 1;

export class FakeMessage {
  id = String(nextMessageId++);
  edits: Payload[] = [];
  collectors: FakeCollector[] = [];

  constructor(public payload: Payload) {}

  get content(): string {
    return this.payload.content ?? "";
  }

  async edit(payload: unknown) {
    const next = normalize(payload);
    this.edits.push(next);
    this.payload = { ...this.payload, ...next };
    return this;
  }

  createMessageComponentCollector(options: { time?: number } = {}) {
    const collector = new FakeCollector(options);
    this.collectors.push(collector);
    return collector;
  }
}

export class FakeChannel {
  messages: FakeMessage[] = [];
  /** Simulated network latency for each message sent. */
  sendDelayMs = 0;

  isSendable() {
    return true;
  }

  async send(payload: unknown) {
    if (this.sendDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    }
    const message = new FakeMessage(normalize(payload));
    this.messages.push(message);
    return message;
  }

  /** All text posted in the channel, one entry per message. */
  get texts(): string[] {
    return this.messages.map((message) => message.content);
  }

  /** Everything said so far, including embed text. */
  transcript(): string {
    return this.messages
      .map((message) => {
        const embeds = (message.payload.embeds ?? []) as { data?: { description?: string } }[];
        return [message.content, ...embeds.map((embed) => embed.data?.description ?? "")]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
  }
}

export interface FakeUser {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  displayAvatarURL: () => string;
}

export function fakeUser(id: string, name = `User${id}`): FakeUser {
  return {
    id,
    username: name,
    displayName: name,
    bot: false,
    displayAvatarURL: () => "",
  };
}

export interface LogEntry {
  kind: "reply" | "deferReply" | "editReply" | "followUp" | "update" | "showModal";
  payload: Payload;
}

/** DMs sent through the fake client, by user id. */
export const sentDMs: { userId: string; content: string }[] = [];

const fakeClient = {
  users: {
    fetch: async (id: string) => ({
      send: async (content: string) => {
        sentDMs.push({ userId: id, content });
      },
    }),
  },
};

export class FakeInteraction {
  log: LogEntry[] = [];
  replied = false;
  deferred = false;
  replyMessage: FakeMessage | null = null;
  followUps: FakeMessage[] = [];
  client = fakeClient;
  memberPermissions = null;
  modal: unknown = null;
  modalSubmit: unknown = null;

  constructor(
    public user: FakeUser,
    public channel: FakeChannel,
    public optionValues: Record<string, unknown> = {},
    public commandName = "test",
    public customId = "",
    public values: string[] = [],
  ) {}

  options = {
    get: (name: string) => this.optionValues[name] ?? null,
    getUser: (name: string, required?: boolean) => this.option(name, required),
    getString: (name: string, required?: boolean) => this.option(name, required),
    getNumber: (name: string, required?: boolean) => this.option(name, required),
    getInteger: (name: string, required?: boolean) => this.option(name, required),
    getBoolean: (name: string, required?: boolean) => this.option(name, required),
    getAttachment: (name: string, required?: boolean) => this.option(name, required),
    getFocused: () => String(this.optionValues.focused ?? ""),
  };

  private option(name: string, required?: boolean) {
    const value = this.optionValues[name];
    if ((value === undefined || value === null) && required) {
      throw new Error(`Missing required option ${name}`);
    }
    return value ?? null;
  }

  private record(kind: LogEntry["kind"], payload: unknown) {
    const entry = { kind, payload: normalize(payload) };
    this.log.push(entry);
    return entry.payload;
  }

  async reply(payload: unknown) {
    if (this.replied || this.deferred) throw new Error("Interaction already replied");
    this.replied = true;
    this.replyMessage = new FakeMessage(this.record("reply", payload));
    if ((payload as { withResponse?: boolean })?.withResponse) {
      return { resource: { message: this.replyMessage } };
    }
    return this.replyMessage;
  }

  async deferReply(payload?: unknown) {
    if (this.replied || this.deferred) throw new Error("Interaction already replied");
    this.deferred = true;
    this.record("deferReply", payload ?? {});
    this.replyMessage = new FakeMessage({});
  }

  async editReply(payload: unknown) {
    if (!this.replied && !this.deferred) throw new Error("Interaction not replied");
    const next = this.record("editReply", payload);
    this.replyMessage ??= new FakeMessage({});
    await this.replyMessage.edit(next);
    return this.replyMessage;
  }

  async fetchReply() {
    return this.replyMessage;
  }

  async followUp(payload: unknown) {
    if (!this.replied && !this.deferred) throw new Error("Interaction not replied");
    const message = new FakeMessage(this.record("followUp", payload));
    this.followUps.push(message);
    return message;
  }

  async update(payload: unknown) {
    this.replied = true;
    this.record("update", payload);
  }

  async showModal(modal: unknown) {
    this.replied = true;
    this.modal = modal;
    this.record("showModal", {});
  }

  async awaitModalSubmit() {
    if (!this.modalSubmit) throw new Error("No modal submitted");
    return this.modalSubmit;
  }

  /** Text of every reply, edit and follow-up. */
  get texts(): string[] {
    return this.log.map((entry) => entry.payload.content ?? "");
  }

  get lastText(): string {
    return this.texts[this.texts.length - 1] ?? "";
  }

  asCommand(): ChatInputCommandInteraction {
    return this as unknown as ChatInputCommandInteraction;
  }

  asButton(): ButtonInteraction {
    return this as unknown as ButtonInteraction;
  }

  asAutocomplete(): AutocompleteInteraction {
    return this as unknown as AutocompleteInteraction;
  }
}

/** A modal submission carrying the given text fields. */
export function fakeModalSubmit(fields: Record<string, string>, target: FakeInteraction) {
  return {
    fields: { getTextInputValue: (id: string) => fields[id] ?? "" },
    isFromMessage: () => true,
    update: (payload: unknown) => target.update(payload),
    reply: (payload: unknown) => target.followUp(payload),
    replied: false,
    deferred: false,
  };
}

/** Waits until `check` passes, polling every millisecond. */
export async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
