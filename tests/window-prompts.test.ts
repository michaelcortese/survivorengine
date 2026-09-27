/**
 * WINDOW PROMPTS: EVERY WINDOW THAT OPENS GETS ITS BUTTONS, WHOEVER OPENED IT
 *
 * A pending window — a take, a forced discard, a Reward Challenge, the Leader's tie-break, an
 * Inheritance claim — can only be answered from the buttons on its public prompt. Those prompts
 * used to be posted by the command handler that had just dispatched, so a window opened by
 * anything ELSE had no buttons anywhere:
 *
 *  - the turn's backstop expiring steals at random and opens a `take` window the victim could
 *    not block, because no handler was running when it opened;
 *  - the voting backstop expiring ends in a tie and opens the Leader's decision with no prompt
 *    at all, so the council sat there until that window's own backstop decided for them;
 *  - and even from a click, the Leader's tie-break buttons were posted by the press itself, on a
 *    separate lane, ahead of the paced vote reveal that explains why there is a tie.
 *
 * The session now posts the prompt for every window a mutation opens, click or tick, on its own
 * render queue straight after the narration. What is held here:
 *
 *  - every kind of window has exactly one prompt, from exactly one command (`collectWindowPrompts`,
 *    which `index.ts` refuses to boot without);
 *  - a tick-opened `take` and a tick-opened `leader_decision` are both prompted, with buttons
 *    addressed to the player the engine is waiting on, AFTER the narration of what opened them;
 *  - a click-opened window is prompted exactly once, and a window that closed while its
 *    narration was going out is not prompted at all;
 *  - a prompt the channel refuses is reported to whoever acted, not dropped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client, EmbedBuilder, GuildTextBasedChannel } from "discord.js";

import cardCommand from "../src/commands/card.js";
import castawaysCommand from "../src/commands/castaways.js";
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
import { DEFAULT_CONFIG, withOverrides, type SurvivorConfig } from "../src/config.js";
import { collectWindowPrompts, type Command } from "../src/discord/interactions.js";
import {
  SessionRegistry,
  type GameSession,
  type PrivateCourier,
  type WindowPrompter,
} from "../src/discord/registry.js";
import type { OutgoingMessage } from "../src/discord/render.js";
import { UI_INTENT, parseCustomId, type Row } from "../src/discord/ui.js";
import {
  asPlayerId,
  isOk,
  type Action,
  type DispatchOutcome,
  type PendingKind,
  type PlayerId,
  type Result,
} from "../src/engine/types.js";
import type { Logger } from "../src/logger.js";
import { SaveStore } from "../src/persistence/store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED = 20250909;
const NOW = 1_700_000_000_000;
const TIMINGS = DEFAULT_CONFIG.engine.timings;

/** Real snowflakes: a prompt's buttons carry the channel and the player in their custom_ids. */
const CHANNEL_ID = "1287654321098765432";
const PLAYERS = [
  asPlayerId("9876543210987654321"),
  asPlayerId("1234567890123456789"),
  asPlayerId("1111111111111111111"),
] as const;

const COMMANDS: readonly Command[] = [
  cardCommand,
  castawaysCommand,
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

/** Every kind of window, exactly as `index.ts` lists them. */
const KINDS = Object.keys(TIMINGS.pendingWindows) as PendingKind[];

const CONFIG: SurvivorConfig = withOverrides(DEFAULT_CONFIG, {
  autosave: { enabled: false },
  engine: { deck: { rngSeed: SEED } },
  // The board picture renders on real async work, and this file walks a fake clock; the board
  // has its own tests.
  discord: { boardImages: false },
});

interface Sent {
  /** Content plus every embed's title and description, as one string. */
  readonly text: string;
  readonly customIds: readonly string[];
  readonly labels: readonly string[];
}

interface Outgoing extends OutgoingMessage {
  readonly components?: readonly Row[];
}

/** A text channel that records what it was sent, components included. */
class FakeChannel {
  readonly sent: Sent[] = [];
  /** Refuse anything carrying a component, the way a missing permission would. */
  refuseComponents = false;

  constructor(readonly id: string) {}

  send(payload: Outgoing): Promise<void> {
    const components = (payload.components ?? []).flatMap(
      (row) => row.toJSON().components,
    );
    if (this.refuseComponents && components.length > 0) {
      return Promise.reject(
        Object.assign(new Error("Missing Permissions"), { code: 50013 }),
      );
    }
    const embeds = (payload.embeds ?? []).map((embed: EmbedBuilder) => {
      const data = embed.toJSON();
      return `${data.title ?? ""} ${data.description ?? ""}`;
    });
    this.sent.push({
      text: [payload.content ?? "", ...embeds].join(" "),
      customIds: components.flatMap((component) =>
        "custom_id" in component && component.custom_id !== undefined
          ? [component.custom_id]
          : [],
      ),
      labels: components.flatMap((component) =>
        "label" in component && component.label !== undefined ? [component.label] : [],
      ),
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

  /** Every message that carried at least one button or menu. */
  prompts(): Sent[] {
    return this.sent.filter((message) => message.customIds.length > 0);
  }
}

/** Whatever a courier was asked to deliver, to whom. */
class RecordingCourier implements PrivateCourier {
  readonly delivered: { readonly to: readonly PlayerId[]; readonly content: string }[] =
    [];

  deliver(playerIds: readonly PlayerId[], payload: OutgoingMessage): Promise<boolean> {
    this.delivered.push({ to: [...playerIds], content: payload.content ?? "" });
    return Promise.resolve(true);
  }
}

function silentLogger(errors: string[]): Logger {
  const make = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string) => {
      errors.push(message);
    },
    child: () => make(),
  });
  return make();
}

function expectOk<T>(result: Result<T>, what: string): T {
  if (!isOk(result)) {
    throw new Error(
      `${what}: expected ok, got ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.value;
}

let errors: string[];

function harness(prompter: WindowPrompter | undefined): {
  readonly session: GameSession;
  readonly channel: FakeChannel;
} {
  const channel = new FakeChannel(CHANNEL_ID);
  const logger = silentLogger(errors);
  const client = {
    users: { fetch: () => Promise.resolve({ send: () => Promise.resolve() }) },
    channels: { fetch: () => Promise.resolve(channel.as()) },
  } as unknown as Client;
  const registry = new SessionRegistry({
    config: CONFIG,
    store: new SaveStore({ config: CONFIG.autosave, logger }),
    logger,
    client,
    prompter,
  });
  const session = expectOk(
    registry.create({ channel: channel.as(), hostId: PLAYERS[0], seed: SEED }),
    "create",
  );
  return { session, channel };
}

const realPrompter = (): WindowPrompter => {
  const collected = collectWindowPrompts(COMMANDS, KINDS);
  expect(collected.problems).toEqual([]);
  return collected.prompter;
};

function apply(
  session: GameSession,
  action: Action,
  courier?: PrivateCourier,
): DispatchOutcome {
  return expectOk(session.apply(action, courier ? { courier } : {}), action.type);
}

function startGame(session: GameSession): void {
  for (const [index, id] of PLAYERS.entries()) {
    apply(session, { type: "join_game", actor: id, displayName: `P${index}` });
  }
  apply(session, { type: "start_game", actor: PLAYERS[0] });
}

function onTurn(session: GameSession): PlayerId {
  const turn = session.view().turn;
  if (turn === null) throw new Error(`no turn in stage ${session.view().stage}`);
  return turn.playerId;
}

function stealTarget(session: GameSession, actor: PlayerId): PlayerId {
  const target = session
    .legalActions(actor)
    .find((action) => action.kind === "steal_random")?.legalTargets?.[0];
  if (target === undefined) throw new Error("no legal steal target");
  return target;
}

/** Let every open window expire on the session's own timer, as nobody pressing anything would. */
function expireWindows(session: GameSession): void {
  for (let guard = 0; guard < 20; guard += 1) {
    const next = session.game.nextDeadline();
    if (!next || next.pendingId === null) return;
    vi.advanceTimersByTime(Math.max(1, next.atMs - Date.now()) + 1);
  }
  throw new Error("windows would not drain");
}

/** Whole turns, pressing through each step, until a Tribal Council card comes off the deck. */
function driveToCouncil(session: GameSession): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const view = session.view();
    if (view.stage === "council") return;
    const actor = onTurn(session);
    const phase = view.turn?.phase;
    if (phase === "steal") {
      apply(session, {
        type: "steal_random",
        actor,
        target: stealTarget(session, actor),
      });
    } else if (phase === "play") apply(session, { type: "skip_play_step", actor });
    else apply(session, { type: "draw_card", actor });
    expireWindows(session);
  }
  throw new Error("never reached a Tribal Council");
}

/**
 * Let the render queue finish. The council's reveal pauses on `setTimeout`, which is fake here,
 * so the clock is walked forward one reveal interval at a time — far less than any window.
 */
async function settle(session: GameSession): Promise<void> {
  let drained = false;
  void session.drain().then(() => {
    drained = true;
  });
  for (let step = 0; step < 100 && !drained; step += 1) {
    await vi.advanceTimersByTimeAsync(TIMINGS.voteRevealInterval);
  }
  if (!drained) throw new Error("the render queue never drained");
}

/** The parsed custom_ids on one prompt. */
function parsedIds(prompt: Sent) {
  return prompt.customIds.map((raw) =>
    expectOk(parseCustomId(raw, CONFIG.discord), raw),
  );
}

beforeEach(() => {
  errors = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe("who prompts which window", () => {
  it("gives every kind of window exactly one prompt, from exactly one command", () => {
    const collected = collectWindowPrompts(COMMANDS, KINDS);
    expect(collected.problems).toEqual([]);

    const owners = new Map<PendingKind, string[]>();
    for (const command of COMMANDS) {
      for (const kind of Object.keys(command.prompts ?? {}) as PendingKind[]) {
        owners.set(kind, [...(owners.get(kind) ?? []), command.data.name]);
      }
    }
    for (const kind of KINDS) expect(owners.get(kind), kind).toHaveLength(1);
    expect(owners.get("take")).toEqual(["play"]);
    expect(owners.get("leader_decision")).toEqual(["council"]);
    expect(owners.get("inheritance")).toEqual(["council"]);
  });

  it("refuses a kind nobody prompts, a kind two commands prompt, and a kind that does not exist", () => {
    const orphaned = collectWindowPrompts([playCommand], KINDS).problems;
    expect(orphaned.join("\n")).toContain(
      "no command prompts the leader_decision window",
    );
    expect(orphaned.join("\n")).toContain("no command prompts the inheritance window");

    const twice = collectWindowPrompts(
      [playCommand, councilCommand, playCommand],
      KINDS,
    );
    expect(twice.problems.join("\n")).toContain("the take window is prompted by both");

    const stray: Command = {
      ...helpCommand,
      prompts: { ["not_a_window" as PendingKind]: () => null },
    };
    const unknown = collectWindowPrompts([playCommand, councilCommand, stray], KINDS);
    expect(unknown.problems).toEqual([
      '/help prompts a "not_a_window" window, which the engine never opens',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Windows a timer opened
// ---------------------------------------------------------------------------

describe("a window opened by a timer", () => {
  it("prompts the take window a turn's backstop opens, with the victim's own buttons", async () => {
    const { session, channel } = harness(realPrompter());
    startGame(session);
    await settle(session);
    expect(channel.prompts()).toEqual([]);

    // Nobody steals: the backstop steals at random on the player's behalf.
    vi.advanceTimersByTime(TIMINGS.turnSafetyTimeout + 1);
    const take = session.view().openPending.find((pending) => pending.kind === "take");
    expect(take, "the backstop should have opened a take window").toBeDefined();
    const victim = take!.waitingOnIds[0]!;
    await settle(session);

    const prompts = channel.prompts();
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt.text).toContain(`<@${victim}>`);
    expect(prompt.labels).toEqual(["Sorry For You!", "Let it happen"]);
    for (const parsed of parsedIds(prompt)) {
      expect(parsed.actor).toBe(victim);
      expect(parsed.args).toContain(take!.id);
    }

    // After the narration that explains it, never before.
    const declared = channel.sent.findIndex((message) =>
      message.text.includes("Sorry For You** may be played until"),
    );
    expect(declared).toBeGreaterThan(-1);
    expect(channel.sent.indexOf(prompt)).toBeGreaterThan(declared);
  });

  it("prompts the Leader's tie-break when the voting backstop ends in a tie", async () => {
    const { session, channel } = harness(realPrompter());
    startGame(session);
    driveToCouncil(session);
    const leader = session.view().council!.leaderId;
    apply(session, { type: "advance_council", actor: leader, from: "advantages" });
    apply(session, { type: "advance_council", actor: leader, from: "discussion" });
    await settle(session);
    const before = channel.prompts().length;

    // Nobody votes. The backstop forfeits every vote, the idol window passes, and the tally of
    // nothing is a tie the Leader has to break.
    for (let guard = 0; guard < 5; guard += 1) {
      if (
        session.view().openPending.some((pending) => pending.kind === "leader_decision")
      )
        break;
      const next = session.game.nextDeadline();
      if (next === null)
        throw new Error("the council stopped with nothing to wait for");
      vi.advanceTimersByTime(Math.max(1, next.atMs - Date.now()) + 1);
    }
    const decision = session
      .view()
      .openPending.find((pending) => pending.kind === "leader_decision");
    expect(decision, "the tally should have ended in a tie").toBeDefined();
    await settle(session);

    const prompts = channel.prompts().slice(before);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt.text).toContain(`<@${leader}>`);
    expect(prompt.labels).toEqual(["Open my controls"]);
    const [parsed] = parsedIds(prompt);
    expect(parsed?.actor).toBe(leader);
    expect(parsed?.intent).toEqual({ kind: "ui", ui: UI_INTENT.Refresh });

    // The tie is explained first; the controls come after it.
    const explained = channel.sent.findIndex((message) =>
      message.text.includes("It is not clear who is voted out."),
    );
    expect(explained).toBeGreaterThan(-1);
    expect(channel.sent.indexOf(prompt)).toBeGreaterThan(explained);
  });
});

// ---------------------------------------------------------------------------
// Windows a click opened
// ---------------------------------------------------------------------------

describe("a window opened by a click", () => {
  it("is prompted exactly once, by the session, with no handler involved", async () => {
    const { session, channel } = harness(realPrompter());
    startGame(session);
    const thief = onTurn(session);
    const victim = stealTarget(session, thief);
    apply(session, { type: "steal_random", actor: thief, target: victim });
    await settle(session);

    const prompts = channel.prompts();
    expect(prompts).toHaveLength(1);
    expect(parsedIds(prompts[0]!).every((parsed) => parsed.actor === victim)).toBe(
      true,
    );
  });

  it("is not prompted if it closed while its narration was still going out", async () => {
    const { session, channel } = harness(realPrompter());
    startGame(session);
    const thief = onTurn(session);
    const victim = stealTarget(session, thief);
    apply(session, { type: "steal_random", actor: thief, target: victim });
    const take = session.view().openPending[0]!;
    // Answered before the render queue has had a chance to run.
    apply(session, { type: "decline_reaction", actor: victim, pendingId: take.id });
    await settle(session);

    expect(channel.prompts()).toEqual([]);
  });

  it("posts nothing extra when no prompter is wired in", async () => {
    const { session, channel } = harness(undefined);
    startGame(session);
    const thief = onTurn(session);
    apply(session, {
      type: "steal_random",
      actor: thief,
      target: stealTarget(session, thief),
    });
    await settle(session);

    expect(channel.prompts()).toEqual([]);
    expect(channel.sent.length).toBeGreaterThan(0);
  });

  it("tells whoever acted when the channel refuses the prompt", async () => {
    const { session, channel } = harness(realPrompter());
    startGame(session);
    await settle(session);
    channel.refuseComponents = true;

    const courier = new RecordingCourier();
    const thief = onTurn(session);
    apply(
      session,
      { type: "steal_random", actor: thief, target: stealTarget(session, thief) },
      courier,
    );
    await settle(session);

    expect(channel.prompts()).toEqual([]);
    expect(errors).toContain("could not post the prompt for an open window");
    const told = courier.delivered.filter((delivery) =>
      delivery.content.includes("I could not post the prompt for an open window"),
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.to).toEqual([thief]);
    expect(told[0]?.content).toContain("take window");
  });
});
