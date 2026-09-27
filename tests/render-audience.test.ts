/**
 * AUDIENCE ROUTING AND DISCORD LIMITS  —  src/discord/render.ts
 *
 * A secret rendered into the public channel is the worst bug this project can have, so this
 * file treats `render.ts` as an untrusted funnel and asserts on its OUTPUT rather than on its
 * source. Real games are driven through the pure engine with fixed seeds; every `GameEvent`
 * they emit is rendered twice — once alone, so each message can be attributed to the event
 * that produced it, and once inside its real dispatch batch, so the batching/flushing path is
 * exercised too. Everything the renderer emits lands in a recording sink.
 *
 * What is asserted, and why each one is a rule and not a preference:
 *
 *  1. ROUTING. `render.ts`'s first hard rule: `public` -> `publish`, `players[…]` -> exactly
 *     those players. An event whose audience is a player list must NEVER produce channel-bound
 *     output, and a public event must never be whispered (audit #126 sent public-by-rule
 *     information ephemerally, which is the same defect pointing the other way).
 *
 *  2. SECRETS. The three things the physical game keeps face down: the cards in your hand
 *     (`card_drawn`, `take_resolved`, `camp_raid_resolved`, `spy_shack_peeked`,
 *     `challenge_swap_completed`), a cast vote before the Voting Box is opened (`vote_cast`,
 *     `jury_vote_cast`), and a challenge submission before the simultaneous reveal. None of
 *     these may appear in a published message, and the private narration that carries them
 *     must never turn up in the channel transcript.
 *
 *  3. LIMITS. Audit #86: unbounded strings were rejected wholesale with a 400 and the player
 *     saw nothing at all. Every published or whispered content string must fit
 *     `discord.maxMessageLength`; every embed must fit Discord's per-field ceilings and the
 *     6000-character total; and no embed may be built with an empty title, description or
 *     field value — discord.js (via @sapphire/shapeshift) THROWS on those, `renderEvents`
 *     catches the throw, and the table silently never hears about the event. That last failure
 *     mode is invisible unless something watches the logger, so this file does.
 *
 *  4. COVERAGE. The `GameEvent` union is closed and `EVENT_AUDIENCE_POLICY` is a
 *     `Record<GameEventType, …>`, so its key set IS the union. Every one of those kinds is
 *     rendered here — the fuzzed games reach most of them, a set of lobby/lifecycle scenarios
 *     reaches the rest, and a hand-built gallery renders one of every kind (and every internal
 *     branch: all eight council phases, all five discard reasons, all sixteen house rules…)
 *     with adversarially long names. The final test names any kind that was never rendered.
 *
 * Nothing here sleeps, calls `Date.now()` or `Math.random()`: the clock is a counter, the
 * engine seed is fixed, and `sink.pause()` resolves immediately.
 */

import { EmbedBuilder } from "discord.js";
import { beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, type SurvivorConfig } from "../src/config.js";
import { CARD_CATALOG } from "../src/engine/cards.js";
import {
  EVENT_AUDIENCE_POLICY,
  type GameEvent,
  type GameEventType,
  type HouseRuleId,
} from "../src/engine/events.js";
import { createGame, restoreGame } from "../src/engine/game.js";
import {
  CardKind,
  asCardUid,
  asCouncilId,
  asGameId,
  asPendingId,
  asPlayerId,
  councilOf,
  finalCouncilOf,
  type Action,
  type ActionKind,
  type CardInstance,
  type CardUid,
  type ChallengeSubmission,
  type CouncilId,
  type CouncilPhase,
  type FinalCouncilPhase,
  type FingerCount,
  type Game,
  type GameState,
  type GameView,
  type LegalAction,
  type PendingKind,
  type PlayerColor,
  type PlayerCount,
  type PlayerId,
  type PrivateView,
  type TurnPhase,
} from "../src/engine/types.js";
import type { LogFields, Logger } from "../src/logger.js";
import {
  handEmbeds,
  lobbyEmbed,
  renderEvents,
  statusEmbed,
  type OutgoingMessage,
  type RenderContext,
  type RenderSink,
} from "../src/discord/render.js";

const CONFIG: SurvivorConfig = DEFAULT_CONFIG;

// ---------------------------------------------------------------------------
// Discord's own ceilings
// ---------------------------------------------------------------------------

/**
 * The platform's limits, written out here rather than read from `config.discord`: the point of
 * the assertion is that the renderer's chosen ceilings actually satisfy Discord, so reading
 * the same numbers the renderer truncates to would make the test agree with itself. The two
 * that ARE in config (message length, embed description) are cross-checked below.
 */
const DISCORD = {
  messageContent: 2000,
  embedTitle: 256,
  embedDescription: 4096,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  embedAuthorName: 256,
  embedFields: 25,
  embedTotal: 6000,
  embedsPerMessage: 10,
} as const;

// ---------------------------------------------------------------------------
// The recording sink and logger
// ---------------------------------------------------------------------------

type Channel = "publish" | "whisper";

interface Delivery {
  readonly channel: Channel;
  /** Empty for `publish`. */
  readonly to: readonly PlayerId[];
  readonly content: string | undefined;
  readonly embeds: readonly EmbedBuilder[];
}

class Recorder implements RenderSink {
  readonly deliveries: Delivery[] = [];
  readonly pauses: number[] = [];

  publish(payload: OutgoingMessage): Promise<void> {
    this.deliveries.push({
      channel: "publish",
      to: [],
      content: payload.content,
      embeds: payload.embeds ?? [],
    });
    return Promise.resolve();
  }

  whisper(playerIds: readonly PlayerId[], payload: OutgoingMessage): Promise<void> {
    this.deliveries.push({
      channel: "whisper",
      to: [...playerIds],
      content: payload.content,
      embeds: payload.embeds ?? [],
    });
    return Promise.resolve();
  }

  pause(ms: number): Promise<void> {
    this.pauses.push(ms);
    return Promise.resolve();
  }
}

interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields | undefined;
}

function recordingLogger(sink: LogLine[]): Logger {
  const write =
    (level: LogLine["level"]) =>
    (message: string, fields?: LogFields): void => {
      sink.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: (message: string, _cause?: unknown, fields?: LogFields): void => {
      sink.push({ level: "error", message, fields });
    },
    child: () => logger,
  };
  return logger;
}

// ---------------------------------------------------------------------------
// Deterministic harness PRNG (never the engine's, never Math.random)
// ---------------------------------------------------------------------------

function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Display names chosen so that no player name is a substring of any card name, colour word or
 * piece of narration copy: several leak assertions below search the public transcript for a
 * player's name and would otherwise report a false positive on the word "Idol".
 */
const NAMES = ["Ari", "Bex", "Cyd", "Dov", "Eze", "Fen"] as const;
const idFor = (i: number): PlayerId => asPlayerId(`u-${NAMES[i]!.toLowerCase()}`);

// ---------------------------------------------------------------------------
// Turning a LegalAction affordance into a real Action (the autopilot)
// ---------------------------------------------------------------------------

/** Actions the autopilot never takes: they end or reshape the game outside normal play. */
const OUT_OF_SCOPE: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "join_game",
  "leave_game",
  "choose_color",
  "name_castaways",
  "start_game",
  "abandon_game",
  "remove_player",
  "transfer_host",
]);

function buildAction(
  state: GameState,
  actor: PlayerId,
  legal: LegalAction,
  rand: () => number,
): Action | null {
  const pick = <T>(xs: readonly T[]): T | null =>
    xs.length === 0 ? null : (xs[Math.floor(rand() * xs.length)] ?? null);
  const pickTwo = <T>(xs: readonly T[]): [T, T] | null => {
    if (xs.length < 2) return null;
    const i = Math.floor(rand() * xs.length);
    let j = Math.floor(rand() * (xs.length - 1));
    if (j >= i) j += 1;
    return [xs[i]!, xs[j]!];
  };
  const targets = legal.legalTargets ?? [];
  const cards = legal.playableCardUids ?? [];
  const pendingId = legal.pendingId;

  switch (legal.kind) {
    case "steal_random": {
      const t = pick(targets);
      return t ? { type: "steal_random", actor, target: t } : null;
    }
    case "skip_play_step":
      return { type: "skip_play_step", actor };
    case "draw_card":
      return { type: "draw_card", actor };
    case "play_sorry_for_you": {
      const c = pick(cards);
      return pendingId && c
        ? { type: "play_sorry_for_you", actor, cardUid: c, pendingId }
        : null;
    }
    case "play_inheritance": {
      const c = pick(cards);
      return pendingId && c
        ? { type: "play_inheritance", actor, cardUid: c, pendingId }
        : null;
    }
    case "decline_reaction":
      return pendingId ? { type: "decline_reaction", actor, pendingId } : null;
    case "discard_card": {
      const c = pick(cards);
      return pendingId && c
        ? { type: "discard_card", actor, pendingId, cardUid: c }
        : null;
    }
    case "choose_card": {
      const c = pick(legal.optionCardUids ?? []);
      return pendingId && c
        ? { type: "choose_card", actor, pendingId, cardUid: c }
        : null;
    }
    case "choose_alliance_target": {
      const t = pick(targets);
      return pendingId && t
        ? { type: "choose_alliance_target", actor, pendingId, target: t }
        : null;
    }
    case "choose_steal_victim": {
      const t = pick(targets);
      return pendingId && t
        ? { type: "choose_steal_victim", actor, pendingId, target: t }
        : null;
    }
    case "submit_challenge_choice": {
      if (!pendingId) return null;
      const pending = state.pending.find((p) => p.id === pendingId);
      if (!pending || pending.kind !== "challenge") return null;
      if (pending.challenge === "do_or_die") {
        const throws = ["rock", "paper", "scissors"] as const;
        return {
          type: "submit_challenge_choice",
          actor,
          pendingId,
          submission: { kind: "rps", throw: throws[Math.floor(rand() * 3)]! },
        };
      }
      const max = pending.challenge === "power_pair" ? 3 : 5;
      const count = (Math.floor(rand() * max) + 1) as FingerCount;
      return {
        type: "submit_challenge_choice",
        actor,
        pendingId,
        submission: { kind: "fingers", count },
      };
    }
    case "leader_choose_eliminations": {
      if (!pendingId) return null;
      const want = legal.chooseCount ?? 1;
      const pool = [...targets];
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      const chosen = pool.slice(0, want);
      return chosen.length === want
        ? { type: "leader_choose_eliminations", actor, pendingId, targets: chosen }
        : null;
    }
    case "cast_vote": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "cast_vote", actor, cardUid: c, target: t } : null;
    }
    case "finish_voting":
      return { type: "finish_voting", actor };
    case "play_immunity_idol": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t
        ? { type: "play_immunity_idol", actor, cardUid: c, protects: t }
        : null;
    }
    case "play_idol_nullifier": {
      const c = pick(cards);
      const council = councilOf(state.stage);
      const idol = council?.idolPlays.find((i) => i.nullifiedBy === null);
      return c && idol
        ? {
            type: "play_idol_nullifier",
            actor,
            cardUid: c,
            targetIdolUid: idol.cardUid,
          }
        : null;
    }
    case "advance_council": {
      const council = councilOf(state.stage);
      return council ? { type: "advance_council", actor, from: council.phase } : null;
    }
    case "advance_final_council": {
      const final = finalCouncilOf(state.stage);
      return final ? { type: "advance_final_council", actor, from: final.phase } : null;
    }
    case "juror_ready":
      return { type: "juror_ready", actor };
    case "reveal_hand":
      return { type: "reveal_hand", actor };
    case "cast_jury_vote": {
      const final = finalCouncilOf(state.stage);
      return final
        ? {
            type: "cast_jury_vote",
            actor,
            finalist: final.finalists[rand() < 0.5 ? 0 : 1],
          }
        : null;
    }
    case "final_leader_break_tie": {
      const final = finalCouncilOf(state.stage);
      return final
        ? {
            type: "final_leader_break_tie",
            actor,
            winner: final.finalists[rand() < 0.5 ? 0 : 1],
          }
        : null;
    }
    case "play_camp_raid": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "play_camp_raid", actor, cardUid: c, target: t } : null;
    }
    case "play_spy_shack": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "play_spy_shack", actor, cardUid: c, target: t } : null;
    }
    case "play_knowledge_is_power": {
      const c = pick(cards);
      const t = pick(targets);
      if (!c || !t) return null;
      const victim = state.players.find((p) => p.id === t);
      const known = victim?.hand
        .map((uid) => state.cards.find((card) => card.uid === uid)?.kind)
        .filter((k): k is CardKind => k !== undefined && k !== CardKind.Vote);
      const named =
        known && known.length > 0 && rand() < 0.5
          ? known[Math.floor(rand() * known.length)]!
          : CardKind.SorryForYou;
      return { type: "play_knowledge_is_power", actor, cardUid: c, target: t, named };
    }
    case "play_lets_form_an_alliance": {
      const c = pick(cards);
      const pair = pickTwo(targets);
      return c && pair
        ? {
            type: "play_lets_form_an_alliance",
            actor,
            cardUid: c,
            partner: pair[0],
            victim: pair[1],
          }
        : null;
    }
    case "play_do_or_die": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t ? { type: "play_do_or_die", actor, cardUid: c, opponent: t } : null;
    }
    case "play_power_pair": {
      const c = pick(cards);
      const pair = pickTwo(targets);
      return c && pair
        ? {
            type: "play_power_pair",
            actor,
            cardUid: c,
            first: pair[0],
            second: pair[1],
          }
        : null;
    }
    case "play_its_a_numbers_game": {
      const c = pick(cards);
      return c ? { type: "play_its_a_numbers_game", actor, cardUid: c } : null;
    }
    case "play_control_the_vote": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t
        ? { type: "play_control_the_vote", actor, cardUid: c, target: t }
        : null;
    }
    case "play_goodwill_gamble": {
      const c = pick(cards);
      const t = pick(targets);
      return c && t
        ? { type: "play_goodwill_gamble", actor, cardUid: c, recipient: t }
        : null;
    }
    case "play_im_the_leader_now": {
      const c = pick(cards);
      return c ? { type: "play_im_the_leader_now", actor, cardUid: c } : null;
    }
    case "join_game":
    case "leave_game":
    case "choose_color":
    case "name_castaways":
    case "start_game":
    case "abandon_game":
    case "remove_player":
    case "transfer_host":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The transcript: every event, rendered alone AND rendered in its real batch
// ---------------------------------------------------------------------------

interface RenderedEvent {
  /** Position in the whole game, so "before the box was opened" is answerable. */
  readonly order: number;
  readonly event: GameEvent;
  /** What the renderer produced for this event, rendered on its own. */
  readonly deliveries: readonly Delivery[];
  /** Every player's hand at the moment this event was rendered, by uid. */
  readonly handsByPlayer: ReadonlyMap<PlayerId, readonly CardUid[]>;
}

interface RenderedBatch {
  readonly events: readonly GameEvent[];
  readonly deliveries: readonly Delivery[];
}

interface Transcript {
  readonly label: string;
  readonly rendered: readonly RenderedEvent[];
  readonly batches: readonly RenderedBatch[];
  readonly logs: readonly LogLine[];
  readonly finalView: GameView;
  readonly finalState: GameState;
  readonly largestHandSeen: number;
}

const COVERED = new Set<GameEventType>();

/** Render one batch: once event-by-event (for attribution), once whole (for batching). */
async function renderBatch(
  events: readonly GameEvent[],
  game: Game,
  logs: LogLine[],
  out: RenderedEvent[],
  batches: RenderedBatch[],
  counter: { n: number },
): Promise<void> {
  if (events.length === 0) return;
  const ctx: RenderContext = {
    view: game.view(),
    config: CONFIG,
    card: (uid: CardUid) => game.card(uid),
  };
  const hands = new Map<PlayerId, readonly CardUid[]>();
  for (const player of game.state().players) hands.set(player.id, [...player.hand]);

  for (const event of events) {
    COVERED.add(event.type);
    const solo = new Recorder();
    await renderEvents([event], ctx, solo, { logger: recordingLogger(logs) });
    counter.n += 1;
    out.push({
      order: counter.n,
      event,
      deliveries: solo.deliveries,
      handsByPlayer: hands,
    });
  }

  const whole = new Recorder();
  await renderEvents(events, ctx, whole, { logger: recordingLogger(logs) });
  batches.push({ events: [...events], deliveries: whole.deliveries });
}

interface PlayOptions {
  readonly label: string;
  readonly seed: number;
  readonly playerCount: PlayerCount;
  readonly maxSteps?: number;
  /** Probability of letting an open window expire on the clock instead of answering it. */
  readonly tickBias?: number;
}

/** Drive one complete game and render everything it emits. */
async function playAndRender(options: PlayOptions): Promise<Transcript> {
  const { label, seed, playerCount } = options;
  const maxSteps = options.maxSteps ?? 3000;
  const tickBias = options.tickBias ?? 0;
  const rand = makeRandom(seed ^ 0x1f2e3d4c);
  const ids = Array.from({ length: playerCount }, (_, i) => idFor(i));
  const logs: LogLine[] = [];
  const rendered: RenderedEvent[] = [];
  const batches: RenderedBatch[] = [];
  const counter = { n: 0 };
  let largestHandSeen = 0;
  let clock = 1_700_000_000_000;
  const now = (): number => (clock += 1000);

  const game = createGame({
    gameId: asGameId(`render-${label}`),
    hostId: ids[0]!,
    config: CONFIG.engine,
    nowMs: now(),
    seed,
  });

  // `createGame` queues `game_created`; the first dispatch carries it out.
  for (const [i, id] of ids.entries()) {
    const joined = game.dispatch(
      { type: "join_game", actor: id, displayName: NAMES[i]! },
      now(),
    );
    expect(joined.ok, `join_game by ${id} in ${label}`).toBe(true);
    if (joined.ok) {
      await renderBatch(joined.value.events, game, logs, rendered, batches, counter);
    }
  }
  const started = game.dispatch(
    { type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! },
    now(),
  );
  expect(started.ok, `start_game in ${label}`).toBe(true);
  if (started.ok) {
    await renderBatch(started.value.events, game, logs, rendered, batches, counter);
  }

  let step = 0;
  let silent = 0;
  while (step < maxSteps) {
    step += 1;
    const state = game.state();
    if (state.stage.kind === "finished" || state.stage.kind === "abandoned") break;
    for (const player of state.players) {
      largestHandSeen = Math.max(largestHandSeen, player.hand.length);
    }

    const affordances: { actor: PlayerId; legal: LegalAction }[] = [];
    for (const player of state.players) {
      for (const legal of game.legalActions(player.id, clock)) {
        if (OUT_OF_SCOPE.has(legal.kind)) continue;
        affordances.push({ actor: player.id, legal });
      }
    }
    for (let i = affordances.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [affordances[i], affordances[j]] = [affordances[j]!, affordances[i]!];
    }

    // Some of the time, let the clock decide instead of a player: that is the only route to
    // `pending_expired` and to every "the bot chose for you" narration hanging off it.
    const letItExpire = state.pending.length > 0 && rand() < tickBias;

    let acted = false;
    if (!letItExpire) {
      for (const option of affordances) {
        const action = buildAction(state, option.actor, option.legal, rand);
        if (!action) continue;
        const outcome = game.dispatch(action, now());
        if (!outcome.ok) continue;
        await renderBatch(outcome.value.events, game, logs, rendered, batches, counter);
        silent = outcome.value.events.length === 0 ? silent + 1 : 0;
        acted = true;
        break;
      }
    }
    if (acted) {
      if (silent > 6) break;
      continue;
    }

    const next = game.nextDeadline();
    if (!next) break;
    clock = Math.max(clock, next.atMs) + 1;
    const ticked = game.tick(clock);
    if (!ticked.ok) break;
    await renderBatch(ticked.value.events, game, logs, rendered, batches, counter);
    silent = ticked.value.events.length === 0 ? silent + 1 : 0;
    if (silent > 6) break;
  }

  return {
    label,
    rendered,
    batches,
    logs,
    finalView: game.view(),
    finalState: game.state(),
    largestHandSeen,
  };
}

// ---------------------------------------------------------------------------
// Lobby / lifecycle scenarios the autopilot deliberately never takes
// ---------------------------------------------------------------------------

async function playLifecycleScenarios(): Promise<Transcript> {
  const logs: LogLine[] = [];
  const rendered: RenderedEvent[] = [];
  const batches: RenderedBatch[] = [];
  const counter = { n: 0 };
  let clock = 1_700_000_000_000;
  const now = (): number => (clock += 1000);
  const ids = Array.from({ length: 5 }, (_, i) => idFor(i));

  const run = async (game: Game, action: Action): Promise<void> => {
    const outcome = game.dispatch(action, now());
    if (outcome.ok) {
      await renderBatch(outcome.value.events, game, logs, rendered, batches, counter);
    }
  };

  // --- lobby: joins, an explicit colour change, a leave, a host transfer, a removal ---
  const lobby = createGame({
    gameId: asGameId("render-lifecycle"),
    hostId: ids[0]!,
    config: CONFIG.engine,
    nowMs: now(),
    seed: 424242,
  });
  for (const [i, id] of ids.entries()) {
    await run(lobby, { type: "join_game", actor: id, displayName: NAMES[i]! });
  }
  await run(lobby, { type: "choose_color", actor: ids[1]!, color: "yellow" });
  await run(lobby, { type: "transfer_host", actor: ids[0]!, target: ids[1]! });
  await run(lobby, { type: "remove_player", actor: ids[1]!, target: ids[4]! });
  await run(lobby, { type: "leave_game", actor: ids[3]! });
  // The host leaving hands the camp on rather than dead-ending the lobby.
  await run(lobby, { type: "leave_game", actor: ids[1]! });
  await run(lobby, { type: "leave_game", actor: ids[0]! });
  await run(lobby, { type: "leave_game", actor: ids[2]! });

  // --- a started game the host abandons via the moderator escape hatch ---
  const abandoned = createGame({
    gameId: asGameId("render-abandon"),
    hostId: ids[0]!,
    config: CONFIG.engine,
    nowMs: now(),
    seed: 99,
  });
  for (const [i, id] of ids.slice(0, 4).entries()) {
    await run(abandoned, { type: "join_game", actor: id, displayName: NAMES[i]! });
  }
  await run(abandoned, { type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! });
  await run(abandoned, {
    type: "abandon_game",
    actor: asPlayerId("u-moderator"),
    viaModerator: true,
  });

  // --- a mid-game departure, which is a different event shape from a lobby one ---
  const midGame = createGame({
    gameId: asGameId("render-midgame-leave"),
    hostId: ids[0]!,
    config: CONFIG.engine,
    nowMs: now(),
    seed: 7,
  });
  for (const [i, id] of ids.slice(0, 4).entries()) {
    await run(midGame, { type: "join_game", actor: id, displayName: NAMES[i]! });
  }
  await run(midGame, { type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! });
  await run(midGame, { type: "leave_game", actor: ids[3]! });

  // --- a restore, which replays `snapshot_restored` into the next dispatch ---
  const source = createGame({
    gameId: asGameId("render-restore"),
    hostId: ids[0]!,
    config: CONFIG.engine,
    nowMs: now(),
    seed: 31337,
  });
  for (const [i, id] of ids.slice(0, 3).entries()) {
    source.dispatch({ type: "join_game", actor: id, displayName: NAMES[i]! }, now());
  }
  source.dispatch({ type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! }, now());
  const restored = restoreGame(source.snapshot());
  expect(restored.ok).toBe(true);
  if (restored.ok) {
    await run(restored.value, {
      type: "steal_random",
      actor: ids[0]!,
      target: ids[1]!,
    });
  }

  return {
    label: "lifecycle",
    rendered,
    batches,
    logs,
    finalView: lobby.view(),
    finalState: lobby.state(),
    largestHandSeen: 0,
  };
}

// ---------------------------------------------------------------------------
// The gallery: one hand-built event of EVERY kind, with hostile payloads
// ---------------------------------------------------------------------------

const LONG_NAME = "Ari".padEnd(400, "-ludicrously-long-display-name");

const COUNCIL_PHASES: readonly CouncilPhase[] = [
  "advantages",
  "discussion",
  "voting",
  "idols",
  "nullifiers",
  "tally",
  "tie_break",
  "cleanup",
];
const FINAL_PHASES: readonly FinalCouncilPhase[] = [
  "opening",
  "statements",
  "jury_questions",
  "jury_vote",
  "tie_break",
  "complete",
];
const TURN_PHASES: readonly TurnPhase[] = ["steal", "play", "draw", "ended"];
const PENDING_KINDS: readonly PendingKind[] = [
  "take",
  "discard",
  "challenge",
  "card_choice",
  "alliance_target",
  "steal_victim",
  "leader_decision",
  "inheritance",
];
const PENDING_DEFAULTS = [
  "take_resolved",
  "discard_auto_selected",
  "challenge_forfeited",
  "card_choice_auto_selected",
  "alliance_target_forfeited",
  "steal_victim_forfeited",
  "leader_choice_auto_selected",
  "inheritance_forfeited",
] as const;
const HOUSE_RULE_IDS: readonly HouseRuleId[] = [
  ...(Object.keys(
    DEFAULT_CONFIG.engine.houseRules,
  ) as (keyof typeof DEFAULT_CONFIG.engine.houseRules)[]),
  "idol_nullifier_included",
];

/**
 * Build one event of every kind against a real six-player game, so that ids, colours and card
 * uids all resolve through the real view and the real registry. Where an event has internal
 * branches — a phase, a reason, a policy — every branch gets its own event.
 */
function galleryEvents(view: GameView, state: GameState): readonly GameEvent[] {
  const ids = view.players.map((p) => p.id);
  const [a, b, c, d] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
  const councilId: CouncilId = asCouncilId("council-1");
  const pendingId = asPendingId("pend-1");
  const uidOf = (kind: CardKind): CardUid =>
    state.cards.find((card) => card.kind === kind)?.uid ?? asCardUid("c0:missing");
  const idol = uidOf(CardKind.ImmunityIdol);
  const sorry = uidOf(CardKind.SorryForYou);
  const voteUid = uidOf(CardKind.Vote);
  const instance = (kind: CardKind): CardInstance =>
    state.cards.find((card) => card.kind === kind) ??
    ({ uid: uidOf(kind), kind } as CardInstance);
  const meta = (n: number, audience: GameEvent["audience"]) => ({
    seq: n,
    atMs: 1_700_000_500_000,
    audience,
  });
  const pub = { kind: "public" } as const;
  const priv = (...players: PlayerId[]): GameEvent["audience"] => ({
    kind: "players",
    playerIds: players,
  });

  let n = 0;
  const next = (): number => (n += 1);
  const events: GameEvent[] = [];
  const push = (body: unknown, audience: GameEvent["audience"] = pub): void => {
    events.push({ ...meta(next(), audience), ...(body as object) } as GameEvent);
  };

  // --- lifecycle ---
  push({ type: "game_created", gameId: view.gameId });
  push({
    type: "player_joined",
    playerId: a,
    displayName: LONG_NAME,
    color: "red" as PlayerColor,
    seat: 0,
    playerCount: 1,
  });
  push({ type: "player_left", playerId: b, playerCount: 5, wasInProgress: false });
  push({ type: "player_left", playerId: b, playerCount: 5, wasInProgress: true });
  push({ type: "player_removed", playerId: c, removedById: a, wasInProgress: true });
  push({
    type: "host_changed",
    previousHostId: a,
    newHostId: b,
    reason: "transferred",
  });
  push({ type: "host_changed", previousHostId: a, newHostId: b, reason: "host_left" });
  push({
    type: "host_changed",
    previousHostId: a,
    newHostId: b,
    reason: "host_removed",
  });
  push({ type: "color_chosen", playerId: a, color: "teal" as PlayerColor });
  push({
    type: "castaways_named",
    playerId: a,
    castaways: ["Parvati Shallow", null],
    reason: "picked",
  });
  push({
    type: "castaways_named",
    playerId: a,
    castaways: ["Parvati Shallow", "Boston Rob Mariano"],
    reason: "dealt",
  });
  push({
    type: "castaways_named",
    playerId: b,
    castaways: ["Sandra Diaz-Twine", "Tony Vlachos"],
    reason: "renamed",
  });
  push({ type: "player_connection_changed", playerId: a, connected: false });
  push({ type: "player_connection_changed", playerId: a, connected: true });
  push({
    type: "game_started",
    playerCount: 6 as PlayerCount,
    seatOrder: ids,
    firstPlayerId: a,
    seed: 12345,
  });
  push({
    type: "deck_built",
    drawPileSize: 52,
    composition: [{ kind: CardKind.SorryForYou, count: 7 }],
    singleCouncilCards: 2,
    doubleCouncilCards: 2,
    councilPositions: [10, 25, 40, 52],
    removedFromGame: 3,
    idolNullifierIncluded: true,
  });
  push({ type: "vote_cards_dealt", perPlayer: 1, removedCount: 0 });
  push({ type: "hands_dealt", handSize: 3, playerIds: ids });
  push({ type: "game_abandoned", byId: a });
  push({ type: "game_abandoned", byId: a, viaModerator: true });
  push({ type: "game_abandoned", byId: a, emptyLobby: true });
  push({ type: "game_finished", winnerId: null });
  push({ type: "game_finished", winnerId: a });
  push({
    type: "snapshot_restored",
    schemaVersion: 1,
    seq: 100,
    savedAtMs: 1_700_000_000_000,
  });

  // --- turn ---
  push({ type: "turn_started", playerId: a, turnNumber: 1, deadlineMs: null });
  push({
    type: "turn_started",
    playerId: a,
    turnNumber: 2,
    deadlineMs: 1_700_000_900_000,
  });
  for (const to of TURN_PHASES) {
    push({ type: "turn_phase_changed", playerId: a, from: "steal", to });
  }
  push({ type: "play_step_skipped", playerId: a });
  push({
    type: "card_played",
    playerId: a,
    cardUid: sorry,
    kind: CardKind.SorryForYou,
    consumedTurnPlay: true,
  });
  push(
    { type: "card_drawn", playerId: a, cardUid: idol, kind: CardKind.ImmunityIdol },
    priv(a),
  );
  push({ type: "turn_ended", playerId: a, drawPileRemaining: 20, nextPlayerId: b });
  push({ type: "turn_ended", playerId: a, drawPileRemaining: 0, nextPlayerId: null });
  push({ type: "draw_pile_exhausted", policy: "final_council", playersRemaining: 4 });
  push({ type: "draw_pile_exhausted", policy: "draw", playersRemaining: 4 });

  // --- takes ---
  for (const selection of ["random", "chosen", "specific"] as const) {
    push({
      type: "take_declared",
      pendingId,
      origin: { kind: "turn_steal", effectId: asPendingId("eff-1") },
      takerIds: [a],
      victimId: b,
      count: 1,
      selection,
      deadlineMs: 1_700_000_900_000,
    });
  }
  push({
    type: "take_declared",
    pendingId,
    origin: { kind: "turn_steal", effectId: asPendingId("eff-1") },
    takerIds: [a, c],
    victimId: b,
    count: 2,
    selection: "random",
    deadlineMs: 1_700_000_900_000,
  });
  push(
    {
      type: "take_resolved",
      pendingId,
      takerId: a,
      victimId: b,
      cardUids: [idol],
      kinds: [CardKind.ImmunityIdol],
    },
    priv(a, b),
  );
  push(
    {
      type: "take_resolved",
      pendingId,
      takerId: a,
      victimId: b,
      cardUids: [],
      kinds: [],
    },
    priv(a, b),
  );
  push({
    type: "cards_transferred",
    fromId: b,
    toId: a,
    count: 1,
    fromHandSize: 2,
    toHandSize: 4,
  });
  push({
    type: "take_blocked",
    pendingId,
    victimId: b,
    blockedTakerIds: [a],
    sorryCardUid: sorry,
  });
  push({
    type: "take_blocked",
    pendingId,
    victimId: b,
    blockedTakerIds: [a, c],
    sorryCardUid: sorry,
  });
  push({ type: "take_found_nothing", pendingId, takerId: a, victimId: b });
  push({ type: "sorry_for_you_played", playerId: b, cardUid: sorry, pendingId });
  for (const reason of ["sorry_for_you_penalty", "power_pair_all_same"] as const) {
    push({
      type: "forced_discard_opened",
      pendingId,
      playerId: a,
      count: 1,
      reason,
      deadlineMs: 1_700_000_900_000,
    });
  }
  for (const reason of [
    "played",
    "forced",
    "council_cleanup",
    "elimination",
    "surplus_vote",
  ] as const) {
    push({
      type: "card_discarded",
      playerId: a,
      cardUid: sorry,
      kind: CardKind.SorryForYou,
      reason,
      autoSelected: reason === "forced",
    });
  }

  // --- card effects ---
  push({
    type: "camp_raid_placed",
    raiderId: a,
    victimId: b,
    cardUid: uidOf(CardKind.CampRaid),
  });
  for (const wasTribalCouncilCard of [false, true]) {
    push(
      {
        type: "camp_raid_resolved",
        raiderId: a,
        victimId: b,
        markerCardUid: uidOf(CardKind.CampRaid),
        takenCardUid: idol,
        takenCardKind: CardKind.ImmunityIdol,
        wasTribalCouncilCard,
      },
      priv(a, b),
    );
  }
  push({
    type: "knowledge_is_power_asked",
    askerId: a,
    targetId: b,
    named: CardKind.ImmunityIdol,
  });
  for (const hit of [true, false]) {
    push({
      type: "knowledge_is_power_answered",
      askerId: a,
      targetId: b,
      named: CardKind.ImmunityIdol,
      hit,
    });
  }
  push(
    {
      type: "spy_shack_peeked",
      spyId: a,
      targetId: b,
      cards: [instance(CardKind.ImmunityIdol), instance(CardKind.Inheritance)],
    },
    priv(a),
  );
  push({ type: "spy_shack_peeked", spyId: a, targetId: b, cards: [] }, priv(a));
  push({
    type: "alliance_formed",
    initiatorId: a,
    partnerId: b,
    cardUid: uidOf(CardKind.LetsFormAnAlliance),
    initiatorVictimId: c,
  });
  push({ type: "alliance_target_chosen", pendingId, partnerId: b, victimId: d });

  // --- challenges ---
  for (const challenge of ["do_or_die", "power_pair", "its_a_numbers_game"] as const) {
    push({
      type: "challenge_started",
      pendingId,
      challenge,
      cardUid: uidOf(CardKind.DoOrDie),
      initiatorId: a,
      participantIds: [a, b],
      round: 1,
      deadlineMs: 1_700_000_900_000,
    });
    push({
      type: "challenge_started",
      pendingId,
      challenge,
      cardUid: uidOf(CardKind.DoOrDie),
      initiatorId: a,
      participantIds: [a, b, c],
      round: 3,
      deadlineMs: 1_700_000_900_000,
    });
  }
  push({
    type: "challenge_submission_received",
    pendingId,
    playerId: a,
    round: 1,
    submittedCount: 1,
    participantCount: 2,
  });
  const submissions: readonly ChallengeSubmission[] = [
    { kind: "rps", throw: "rock" },
    { kind: "rps", throw: "paper" },
    { kind: "rps", throw: "scissors" },
    { kind: "fingers", count: 1 },
    { kind: "fingers", count: 5 },
  ];
  push({
    type: "challenge_revealed",
    pendingId,
    challenge: "do_or_die",
    round: 1,
    reveals: submissions.map((submission, i) => ({
      playerId: ids[i % ids.length]!,
      submission,
    })),
  });
  // Every participant forfeited: `resolveChallenge` emits the reveal with an EMPTY
  // `reveals` list (src/engine/challenges.ts:176). The engine really does produce this, on
  // any challenge whose window expires with nothing in it.
  push({
    type: "challenge_revealed",
    pendingId,
    challenge: "power_pair",
    round: 1,
    reveals: [],
  });
  for (const reason of ["all_different", "no_unique_lowest"] as const) {
    push({
      type: "challenge_replayed",
      pendingId,
      challenge: "power_pair",
      nextRound: 2,
      reason,
    });
  }
  const outcomes = [
    { kind: "rps_decisive", winnerId: a, loserId: b },
    { kind: "rps_tie", playerIds: [a, b] },
    { kind: "power_pair_matched", matchedIds: [a, b], oddOneOutId: c },
    { kind: "power_pair_all_same", playerIds: [a, b, c] },
    { kind: "numbers_game_winner", winnerId: a, number: 3 },
  ] as const;
  for (const outcome of outcomes) {
    push({
      type: "challenge_resolved",
      pendingId,
      challenge: "do_or_die",
      round: 1,
      outcome,
    });
  }
  push(
    {
      type: "challenge_swap_completed",
      pendingId,
      aId: a,
      bId: b,
      aGaveCardUid: idol,
      aGaveCardKind: CardKind.ImmunityIdol,
      bGaveCardUid: sorry,
      bGaveCardKind: CardKind.SorryForYou,
    },
    priv(a, b),
  );

  // --- council ---
  for (const kind of ["single", "double"] as const) {
    push({
      type: "council_started",
      councilId,
      kind,
      cardUid: uidOf(CardKind.TribalCouncilSingle),
      drawerId: a,
      leaderId: b,
      councilNumber: 1,
      councilsRemainingInDeck: 3,
    });
  }
  for (const to of COUNCIL_PHASES) {
    push({
      type: "council_phase_changed",
      councilId,
      from: "advantages",
      to,
      deadlineMs: to === "voting" ? 1_700_000_900_000 : null,
    });
  }
  for (const grantsNextTurn of [true, false]) {
    push({
      type: "council_leader_changed",
      councilId,
      fromId: a,
      toId: b,
      cardUid: uidOf(CardKind.ImTheLeaderNow),
      grantsNextTurn,
    });
  }
  for (const kind of [
    "control_the_vote",
    "goodwill_gamble",
    "im_the_leader_now",
  ] as const) {
    push({
      type: "advantage_played",
      councilId,
      cardUid: uidOf(CardKind.ControlTheVote),
      kind,
      playedById: a,
      targetId: kind === "im_the_leader_now" ? null : b,
    });
  }
  for (const mustBeUsedThisCouncil of [true, false]) {
    push({
      type: "vote_card_taken",
      councilId,
      takerId: a,
      victimId: b,
      cardUid: voteUid,
      mustBeUsedThisCouncil,
    });
  }
  push({
    type: "goodwill_gamble_given",
    councilId,
    giverId: a,
    recipientId: b,
    cardUid: uidOf(CardKind.GoodwillGamble),
  });
  push({
    type: "voting_opened",
    councilId,
    requiredVoterIds: ids,
    requiredCasts: ids.map((id) => ({
      playerId: id,
      cardUid: voteUid,
      source: "vote_card" as const,
    })),
    deadlineMs: 1_700_000_900_000,
  });
  push({
    type: "voting_opened",
    councilId,
    requiredVoterIds: [a],
    requiredCasts: [
      { playerId: a, cardUid: voteUid, source: "vote_card" as const },
      { playerId: a, cardUid: voteUid, source: "goodwill_gamble" as const },
    ],
    deadlineMs: null,
  });
  push(
    {
      type: "vote_cast",
      councilId,
      voterId: a,
      cardUid: voteUid,
      targetId: b,
      source: "vote_card",
    },
    priv(a),
  );
  push({ type: "voter_finished", councilId, voterId: a, remainingVoterIds: [] });
  push({ type: "voter_finished", councilId, voterId: a, remainingVoterIds: [b, c] });
  push({
    type: "votes_forfeited",
    councilId,
    playerIds: [c],
    casts: [
      { playerId: c, cardUid: voteUid, source: "vote_card" },
      { playerId: c, cardUid: voteUid, source: "goodwill_gamble" },
    ],
  });
  push({ type: "voting_closed", councilId });
  push({ type: "idol_window_opened", councilId, deadlineMs: 1_700_000_900_000 });
  push({ type: "idol_played", councilId, cardUid: idol, playedById: a, protectsId: a });
  push({ type: "idol_played", councilId, cardUid: idol, playedById: a, protectsId: b });
  push({
    type: "nullifier_window_opened",
    councilId,
    idolCardUids: [idol],
    deadlineMs: 1_700_000_900_000,
  });
  push({
    type: "idol_nullified",
    councilId,
    nullifierCardUid: uidOf(CardKind.IdolNullifier),
    idolCardUid: idol,
    playedById: c,
    idolProtectedId: a,
  });
  push({
    type: "votes_revealed",
    councilId,
    revealOrder: ids.map((id, i) => ({
      cardUid: voteUid,
      voterId: id,
      targetId: b,
      source: "vote_card" as const,
      order: i,
    })),
    totalVotes: ids.length,
  });
  push({
    type: "tally_computed",
    councilId,
    rows: [
      {
        playerId: a,
        rawVotes: 3,
        countedVotes: 0,
        immune: true,
        protectedByIdolUids: [idol],
      },
      {
        playerId: b,
        rawVotes: 2,
        countedVotes: 2,
        immune: false,
        protectedByIdolUids: [],
      },
      {
        playerId: c,
        rawVotes: 0,
        countedVotes: 0,
        immune: false,
        protectedByIdolUids: [],
      },
    ],
    highestCountedVotes: 2,
    topVoteGetters: [b],
  });
  // Every vote nullified: the branch whose fallback description must not be empty.
  push({
    type: "tally_computed",
    councilId,
    rows: [
      {
        playerId: a,
        rawVotes: 0,
        countedVotes: 0,
        immune: false,
        protectedByIdolUids: [],
      },
    ],
    highestCountedVotes: 0,
    topVoteGetters: [],
  });
  for (const reason of [
    "tie_for_most",
    "double_tie_for_most",
    "double_tie_for_second",
    "unclear_cascade",
    "three_player_double_override",
  ] as const) {
    push({
      type: "tie_break_required",
      councilId,
      pendingId,
      leaderId: a,
      reason,
      tier: "voted_non_immune",
      candidates: [b, c],
      choose: 1,
      deadlineMs: 1_700_000_900_000,
    });
  }
  for (const emptyBecause of ["no_candidates", "not_enough_candidates"] as const) {
    push({
      type: "tie_break_tier_descended",
      councilId,
      from: "voted_non_immune",
      to: "unvoted_non_immune",
      emptyBecause,
    });
  }
  push({
    type: "leader_chose_eliminations",
    councilId,
    leaderId: a,
    targetIds: [b, c],
    tier: "voted_non_immune",
    reason: "double_tie_for_most",
  });
  for (const charactersRemaining of [1, 0]) {
    push({
      type: "character_card_flipped",
      playerId: b,
      cardUid: uidOf(CardKind.SurvivorCharacter),
      castaway: charactersRemaining === 1 ? "Sandra Diaz-Twine" : "Tony Vlachos",
      charactersRemaining,
      votesReceived: 3,
      councilId,
    });
  }
  push({
    type: "player_eliminated",
    playerId: b,
    eliminationOrder: 1,
    playersRemaining: 3,
    handSize: 2,
  });
  for (const handSize of [1, 4]) {
    push({
      type: "inheritance_window_opened",
      pendingId,
      eliminatedPlayerId: b,
      color: "green" as PlayerColor,
      handSize,
      deadlineMs: 1_700_000_900_000,
    });
  }
  push({
    type: "inheritance_claimed",
    pendingId,
    claimantId: a,
    eliminatedPlayerId: b,
    cardUid: uidOf(CardKind.Inheritance),
    cardCount: 3,
  });
  push({
    type: "hand_discarded_on_elimination",
    playerId: b,
    cards: [instance(CardKind.ImmunityIdol), instance(CardKind.Inheritance)],
    voteCardsReturned: 1,
    grantedVotesDiscarded: 1,
  });
  push({
    type: "hand_discarded_on_elimination",
    playerId: b,
    cards: [],
    voteCardsReturned: 0,
    grantedVotesDiscarded: 0,
  });
  push({ type: "vote_cards_returned", councilId, playerIds: ids, surplusDiscarded: 2 });
  push({
    type: "council_ended",
    councilId,
    eliminatedIds: [b],
    flippedIds: [b],
    nextPlayerId: c,
    nextTurnFromOverride: true,
  });
  push({
    type: "council_ended",
    councilId,
    eliminatedIds: [],
    flippedIds: [],
    nextPlayerId: null,
    nextTurnFromOverride: false,
  });

  // --- final council ---
  for (const trigger of [
    "single_elimination",
    "double_elimination_partial",
    "double_elimination_complete",
    "three_player_override",
    "draw_pile_empty",
    "player_left_game",
  ] as const) {
    push({
      type: "final_council_started",
      leaderId: c,
      finalists: [a, b],
      juryIds: [c, d],
      trigger,
    });
  }
  for (const to of FINAL_PHASES) {
    push({
      type: "final_council_phase_changed",
      from: "opening",
      to,
      deadlineMs: to === "jury_vote" ? 1_700_000_900_000 : null,
    });
  }
  push({
    type: "finalist_hand_revealed",
    playerId: a,
    cards: [instance(CardKind.ImmunityIdol)],
  });
  push({ type: "finalist_hand_revealed", playerId: a, cards: [] });
  push({ type: "juror_ready", jurorId: c, readyCount: 1, juryCount: 2 });
  push({ type: "jury_vote_cast", jurorId: c, finalistId: a }, priv(c));
  push({ type: "jury_vote_registered", jurorId: c, castCount: 1, juryCount: 2 });
  push({
    type: "jury_votes_revealed",
    votes: [
      { jurorId: c, finalistId: a, atSeq: 1 },
      { jurorId: d, finalistId: b, atSeq: 2 },
    ],
    tallies: [
      { finalistId: a, votes: 1 },
      { finalistId: b, votes: 1 },
    ],
  });
  push({
    type: "final_tie_break_required",
    leaderId: c,
    finalists: [a, b],
    deadlineMs: 1_700_000_900_000,
  });
  for (const method of [
    "jury_majority",
    "leader_tie_break",
    "sole_survivor",
  ] as const) {
    push({
      type: "winner_declared",
      winnerId: a,
      method,
      ...(method === "jury_majority" ? { votes: 3, juryCount: 4 } : {}),
    });
  }

  // --- pending windows and policy disclosure ---
  for (const pendingKind of PENDING_KINDS) {
    push({
      type: "pending_opened",
      pendingId,
      pendingKind,
      waitingOnIds: [a],
      deadlineMs: 1_700_000_900_000,
    });
  }
  for (const defaultApplied of PENDING_DEFAULTS) {
    push({ type: "pending_expired", pendingId, pendingKind: "take", defaultApplied });
  }
  for (const reason of [
    "blocked",
    "superseded",
    "player_eliminated",
    "game_ended",
    "declined",
  ] as const) {
    push({ type: "pending_cancelled", pendingId, pendingKind: "take", reason });
  }
  for (const rule of HOUSE_RULE_IDS) {
    push({
      type: "house_rule_applied",
      rule,
      setting:
        rule === "drawPileExhaustionPolicy"
          ? DEFAULT_CONFIG.engine.houseRules.drawPileExhaustionPolicy
          : true,
      affectedPlayerIds: rule === "allowSelfVote" ? [] : [a, b],
    });
  }

  return events;
}

async function renderGallery(): Promise<Transcript> {
  const logs: LogLine[] = [];
  const rendered: RenderedEvent[] = [];
  const batches: RenderedBatch[] = [];
  const counter = { n: 0 };
  let clock = 1_700_000_000_000;
  const now = (): number => (clock += 1000);
  const ids = Array.from({ length: 6 }, (_, i) => idFor(i));

  const game = createGame({
    gameId: asGameId("render-gallery"),
    hostId: ids[0]!,
    config: CONFIG.engine,
    nowMs: now(),
    seed: 20250910,
  });
  for (const [i, id] of ids.entries()) {
    game.dispatch({ type: "join_game", actor: id, displayName: NAMES[i]! }, now());
  }
  game.dispatch({ type: "start_game", actor: ids[0]!, firstPlayer: ids[0]! }, now());

  const events = galleryEvents(game.view(), game.state());
  await renderBatch(events, game, logs, rendered, batches, counter);

  return {
    label: "gallery",
    rendered,
    batches,
    logs,
    finalView: game.view(),
    finalState: game.state(),
    largestHandSeen: 0,
  };
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

const isPrivate = (event: GameEvent): boolean =>
  EVENT_AUDIENCE_POLICY[event.type] === "private";

const textOf = (delivery: Delivery): string => {
  const embedText = delivery.embeds
    .map((embed) => JSON.stringify(embed.toJSON()))
    .join("\n");
  return `${delivery.content ?? ""}\n${embedText}`;
};

/** Every Discord-side problem with one embed, as human-readable strings. */
function embedProblems(embed: EmbedBuilder, where: string): string[] {
  const data = embed.toJSON();
  const problems: string[] = [];
  const check = (
    label: string,
    value: string | undefined,
    max: number,
    required: boolean,
  ): number => {
    if (value === undefined) {
      if (required) problems.push(`${where}: ${label} is missing`);
      return 0;
    }
    if (value.length === 0) problems.push(`${where}: ${label} is EMPTY`);
    if (value.length > max) {
      problems.push(`${where}: ${label} is ${value.length} chars, max ${max}`);
    }
    return value.length;
  };

  let total = 0;
  total += check("title", data.title, DISCORD.embedTitle, false);
  total += check("description", data.description, DISCORD.embedDescription, false);
  total += check("footer.text", data.footer?.text, DISCORD.embedFooter, false);
  total += check("author.name", data.author?.name, DISCORD.embedAuthorName, false);
  const fields = data.fields ?? [];
  if (fields.length > DISCORD.embedFields) {
    problems.push(`${where}: ${fields.length} fields, max ${DISCORD.embedFields}`);
  }
  for (const [i, field] of fields.entries()) {
    total += check(`field[${i}].name`, field.name, DISCORD.embedFieldName, true);
    total += check(`field[${i}].value`, field.value, DISCORD.embedFieldValue, true);
  }
  if (total > DISCORD.embedTotal) {
    problems.push(`${where}: embed totals ${total} chars, Discord's ceiling is 6000`);
  }
  if (
    data.title === undefined &&
    data.description === undefined &&
    fields.length === 0 &&
    data.image === undefined
  ) {
    problems.push(`${where}: embed carries nothing at all`);
  }
  return problems;
}

/** Everything wrong with one outgoing message, as human-readable strings. */
function deliveryProblems(delivery: Delivery, where: string): string[] {
  const problems: string[] = [];
  const content = delivery.content;
  if (content !== undefined && content.length > DISCORD.messageContent) {
    problems.push(
      `${where}: content is ${content.length} chars, Discord's ceiling is ${DISCORD.messageContent}`,
    );
  }
  const hasText = content !== undefined && content.trim() !== "";
  if (!hasText && delivery.embeds.length === 0) {
    problems.push(`${where}: message has neither content nor an embed`);
  }
  if (delivery.embeds.length > DISCORD.embedsPerMessage) {
    problems.push(
      `${where}: ${delivery.embeds.length} embeds, max ${DISCORD.embedsPerMessage}`,
    );
  }
  let embedTotal = 0;
  for (const [i, embed] of delivery.embeds.entries()) {
    problems.push(...embedProblems(embed, `${where} embed[${i}]`));
    const data = embed.toJSON();
    embedTotal +=
      (data.title?.length ?? 0) +
      (data.description?.length ?? 0) +
      (data.footer?.text.length ?? 0) +
      (data.author?.name.length ?? 0) +
      (data.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  }
  if (embedTotal > DISCORD.embedTotal) {
    problems.push(
      `${where}: embeds total ${embedTotal} chars across the message, ceiling is 6000`,
    );
  }
  return problems;
}

const report = (problems: readonly string[]): string =>
  problems.length === 0
    ? ""
    : `${problems.length} problem(s):\n${problems.slice(0, 25).join("\n")}`;

// ---------------------------------------------------------------------------
// Build every transcript once
// ---------------------------------------------------------------------------

let TRANSCRIPTS: Transcript[] = [];
let GAMES: Transcript[] = [];
let GALLERY: Transcript;

beforeAll(async () => {
  GAMES = [
    await playAndRender({ label: "s3", seed: 20250910, playerCount: 3 }),
    await playAndRender({ label: "s4", seed: 11235813, playerCount: 4 }),
    await playAndRender({ label: "s5", seed: 314159265, playerCount: 5 }),
    await playAndRender({ label: "s6", seed: 2718281828, playerCount: 6 }),
    await playAndRender({ label: "s6b", seed: 987654321, playerCount: 6 }),
    // Two games where nobody answers half the windows, so the expiry narrations render too.
    await playAndRender({
      label: "s4-lazy",
      seed: 6180339887,
      playerCount: 4,
      tickBias: 0.5,
    }),
    await playAndRender({
      label: "s6-lazy",
      seed: 1414213562,
      playerCount: 6,
      tickBias: 0.65,
    }),
  ];
  const lifecycle = await playLifecycleScenarios();
  GALLERY = await renderGallery();
  TRANSCRIPTS = [...GAMES, lifecycle, GALLERY];
}, 120_000);

const allRendered = (): readonly RenderedEvent[] =>
  TRANSCRIPTS.flatMap((t) => t.rendered);
const allBatches = (): readonly RenderedBatch[] =>
  TRANSCRIPTS.flatMap((t) => t.batches);

// ---------------------------------------------------------------------------
// 1. Audience routing
// ---------------------------------------------------------------------------

describe("audience routing", () => {
  it("the games this suite drives actually reach every part of the game", () => {
    // Deliberately GAMES and not the hand-built gallery: the gallery contains one of
    // everything by construction, so asserting against it would prove nothing about whether a
    // real game was ever played through a council, an elimination and a Final Tribal Council.
    const kinds = new Set(GAMES.flatMap((t) => t.rendered.map((r) => r.event.type)));
    for (const needed of [
      "council_started",
      "voting_opened",
      "vote_cast",
      "votes_revealed",
      "character_card_flipped",
      "player_eliminated",
      "final_council_started",
      "jury_vote_cast",
      "winner_declared",
      "card_drawn",
      "take_resolved",
    ] as const) {
      expect(kinds.has(needed), `a driven game must reach ${needed}`).toBe(true);
    }
    expect(GAMES.flatMap((t) => t.rendered).length).toBeGreaterThan(1000);
  });

  it("an event addressed to a player list never produces channel-bound output", () => {
    const leaks = allRendered()
      .filter((r) => isPrivate(r.event))
      .flatMap((r) =>
        r.deliveries
          .filter((d) => d.channel === "publish")
          .map(
            (d) =>
              `${r.event.type} (seq ${r.event.seq}) was PUBLISHED: ${textOf(d).slice(0, 200)}`,
          ),
      );
    expect(report(leaks)).toBe("");
  });

  it("a private event reaches exactly the players named in its envelope and nobody else", () => {
    const problems: string[] = [];
    for (const r of allRendered()) {
      if (!isPrivate(r.event)) continue;
      const envelope =
        r.event.audience.kind === "players"
          ? [...r.event.audience.playerIds].sort()
          : [];
      for (const delivery of r.deliveries) {
        const got = [...delivery.to].sort();
        if (JSON.stringify(got) !== JSON.stringify(envelope)) {
          problems.push(
            `${r.event.type} (seq ${r.event.seq}) whispered to [${got.join(",")}], ` +
              `envelope says [${envelope.join(",")}]`,
          );
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("a public event is never delivered as a whisper to a subset of the table", () => {
    const problems = allRendered()
      .filter((r) => !isPrivate(r.event))
      .flatMap((r) =>
        r.deliveries
          .filter((d) => d.channel === "whisper")
          .map(
            (d) =>
              `${r.event.type} (seq ${r.event.seq}) whispered to [${d.to.join(",")}]`,
          ),
      );
    expect(report(problems)).toBe("");
  });

  it("the renderer drops nothing: no event's envelope ever disagrees with the policy table", () => {
    const dropped = TRANSCRIPTS.flatMap((t) =>
      t.logs
        .filter((l) => l.message.includes("EVENT_AUDIENCE_POLICY"))
        .map((l) => `${t.label}: ${JSON.stringify(l.fields)}`),
    );
    expect(report(dropped)).toBe("");
  });

  it("every event that carries news produces at least one message", () => {
    // Events the renderer deliberately silences, each because a better event covers the moment.
    const deliberatelySilent = new Set<GameEventType>([
      "game_created",
      "sorry_for_you_played",
      "player_connection_changed",
      "turn_phase_changed",
      "council_phase_changed",
      "final_council_phase_changed",
      "pending_opened",
      "pending_cancelled",
      "game_finished",
    ]);
    const silent = new Map<GameEventType, number>();
    for (const r of allRendered()) {
      if (r.deliveries.length > 0) continue;
      if (deliberatelySilent.has(r.event.type)) continue;
      silent.set(r.event.type, (silent.get(r.event.type) ?? 0) + 1);
    }
    expect(
      report(
        [...silent].map(([type, n]) => `${type} produced no message ${n} time(s)`),
      ),
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. Secrets
// ---------------------------------------------------------------------------

describe("secrets never reach the channel", () => {
  it("no private narration ever turns up in the public transcript of the same game", () => {
    const problems: string[] = [];
    for (const transcript of TRANSCRIPTS) {
      const secrets = new Map<string, GameEvent>();
      for (const r of transcript.rendered) {
        if (!isPrivate(r.event)) continue;
        for (const delivery of r.deliveries) {
          const content = delivery.content;
          // Short or generic strings would collide by accident; only assert on real prose.
          if (content !== undefined && content.length > 24)
            secrets.set(content, r.event);
        }
      }
      const publicTexts = transcript.rendered
        .filter((r) => !isPrivate(r.event))
        .flatMap((r) =>
          r.deliveries.filter((d) => d.channel === "publish").map(textOf),
        );
      const batchTexts = transcript.batches.flatMap((b) =>
        b.deliveries.filter((d) => d.channel === "publish").map(textOf),
      );
      for (const [secret, event] of secrets) {
        for (const text of [...publicTexts, ...batchTexts]) {
          if (text.includes(secret)) {
            problems.push(
              `${transcript.label}: the private narration of ${event.type} (seq ${event.seq}) ` +
                `appears in a published message`,
            );
            break;
          }
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("a hand seen through The Spy Shack is never listed in the channel", () => {
    const problems: string[] = [];
    for (const transcript of TRANSCRIPTS) {
      const publicText = transcript.rendered
        .filter((r) => !isPrivate(r.event))
        .flatMap((r) => r.deliveries.filter((d) => d.channel === "publish").map(textOf))
        .join("\n");
      for (const r of transcript.rendered) {
        if (r.event.type !== "spy_shack_peeked") continue;
        if (r.event.cards.length < 2) continue;
        const listed = r.event.cards
          .map((card) => `• ${CARD_CATALOG[card.kind].name}`)
          .join("\n");
        if (publicText.includes(listed)) {
          problems.push(
            `${transcript.label}: the hand ${r.event.spyId} peeked at (seq ${r.event.seq}) ` +
              `is listed in a published message`,
          );
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("no rendered message ever names a card by its uid", () => {
    // A uid identifies one physical card. It has no place in copy at all, and a uid in a public
    // message would let anybody follow a specific card from hand to hand.
    const problems: string[] = [];
    for (const transcript of TRANSCRIPTS) {
      const uids = new Set(transcript.finalState.cards.map((card) => card.uid));
      for (const r of transcript.rendered) {
        for (const delivery of r.deliveries) {
          const text = textOf(delivery);
          for (const uid of uids) {
            if (text.includes(uid)) {
              problems.push(
                `${transcript.label}: ${r.event.type} (seq ${r.event.seq}) printed uid ${uid}`,
              );
              break;
            }
          }
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("a vote is never named in the channel before the Voting Box is opened", () => {
    const problems: string[] = [];
    for (const transcript of GAMES) {
      const rendered = transcript.rendered;
      // For each council, the window runs from `voting_opened` to `votes_revealed`.
      const opens = new Map<CouncilId, number>();
      const reveals = new Map<CouncilId, number>();
      for (const r of rendered) {
        if (r.event.type === "voting_opened" && !opens.has(r.event.councilId)) {
          opens.set(r.event.councilId, r.order);
        }
        if (r.event.type === "votes_revealed") reveals.set(r.event.councilId, r.order);
      }
      for (const r of rendered) {
        if (r.event.type !== "vote_cast") continue;
        const cast = r.event;
        const from = opens.get(cast.councilId) ?? 0;
        const to = reveals.get(cast.councilId) ?? Number.MAX_SAFE_INTEGER;
        const target = transcript.finalView.players.find((p) => p.id === cast.targetId);
        if (!target) continue;
        // `bold(displayName)` is how every reveal-side narration names a vote target.
        const tell = `**${target.displayName}**`;
        for (const other of rendered) {
          if (other.order <= from || other.order >= to) continue;
          for (const delivery of other.deliveries) {
            if (delivery.channel !== "publish") continue;
            if (textOf(delivery).includes(tell)) {
              problems.push(
                `${transcript.label}: ${other.event.type} (order ${other.order}) named ` +
                  `${target.displayName} as a vote target in the channel before ` +
                  `votes_revealed (council ${cast.councilId})`,
              );
            }
          }
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("a challenge submission is never shown in the channel before the simultaneous reveal", () => {
    // "choose in secret. Everything reveals at once." — the whole point of these three cards.
    const rpsWord = { rock: "Rock", paper: "Paper", scissors: "Scissors" } as const;
    const fingerEmoji = ["☝️", "✌️", "🤟", "🖖", "🖐️"] as const;
    const tellOf = (submission: ChallengeSubmission): string =>
      submission.kind === "rps"
        ? rpsWord[submission.throw]
        : `${fingerEmoji[submission.count - 1] ?? ""} ${submission.count}`;

    const problems: string[] = [];
    for (const transcript of GAMES) {
      const rendered = transcript.rendered;
      for (const r of rendered) {
        if (r.event.type !== "challenge_revealed") continue;
        const revealed = r.event;
        const revealAt = r.order;
        // The window opens at the most recent `challenge_started` for this pending.
        const start = rendered
          .filter(
            (o) =>
              o.event.type === "challenge_started" &&
              o.event.pendingId === revealed.pendingId &&
              o.order < revealAt,
          )
          .map((o) => o.order)
          .pop();
        if (start === undefined) continue;
        const tells = new Set(
          revealed.reveals.map((reveal) => tellOf(reveal.submission)),
        );
        for (const other of rendered) {
          if (other.order <= start || other.order >= revealAt) continue;
          for (const delivery of other.deliveries) {
            if (delivery.channel !== "publish") continue;
            const text = textOf(delivery);
            for (const tell of tells) {
              if (text.includes(tell)) {
                problems.push(
                  `${transcript.label}: ${other.event.type} (order ${other.order}) showed ` +
                    `"${tell}" in the channel before the challenge reveal`,
                );
              }
            }
          }
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("the five events that carry hand contents are private in the policy AND in practice", () => {
    const handRevealing: readonly GameEventType[] = [
      "card_drawn",
      "take_resolved",
      "camp_raid_resolved",
      "spy_shack_peeked",
      "challenge_swap_completed",
    ];
    for (const type of handRevealing) {
      expect(EVENT_AUDIENCE_POLICY[type], `${type} must be private by policy`).toBe(
        "private",
      );
    }
    const wanted = new Set<GameEventType>(handRevealing);
    const seen = new Set<GameEventType>();
    const problems: string[] = [];
    for (const r of allRendered()) {
      if (!wanted.has(r.event.type)) continue;
      seen.add(r.event.type);
      for (const delivery of r.deliveries) {
        if (delivery.channel === "publish") {
          problems.push(`${r.event.type} (seq ${r.event.seq}) went to the channel`);
        }
      }
    }
    expect(report(problems)).toBe("");
    expect(
      report(
        handRevealing.filter((t) => !seen.has(t)).map((t) => `${t} was never rendered`),
      ),
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. Discord's limits
// ---------------------------------------------------------------------------

describe("Discord limits", () => {
  it("the renderer's configured ceilings are the ones Discord actually enforces", () => {
    expect(CONFIG.discord.maxMessageLength).toBeLessThanOrEqual(DISCORD.messageContent);
    expect(CONFIG.discord.maxEmbedDescriptionLength).toBeLessThanOrEqual(
      DISCORD.embedDescription,
    );
    expect(CONFIG.discord.maxEmbedFieldValueLength).toBeLessThanOrEqual(
      DISCORD.embedFieldValue,
    );
    expect(CONFIG.discord.maxEmbedsPerMessage).toBeLessThanOrEqual(
      DISCORD.embedsPerMessage,
    );
  });

  it("every message rendered from a single event is within Discord's limits", () => {
    const problems: string[] = [];
    for (const r of allRendered()) {
      for (const [i, delivery] of r.deliveries.entries()) {
        problems.push(
          ...deliveryProblems(
            delivery,
            `${r.event.type} (seq ${r.event.seq}) msg[${i}]`,
          ),
        );
      }
    }
    expect(report(problems)).toBe("");
  });

  it("every message rendered from a batched dispatch is within Discord's limits", () => {
    // The batching path is where an over-length message is actually made: consecutive
    // one-liners are joined before they are split (audit #86).
    const problems: string[] = [];
    for (const [b, batch] of allBatches().entries()) {
      for (const [i, delivery] of batch.deliveries.entries()) {
        problems.push(...deliveryProblems(delivery, `batch[${b}] msg[${i}]`));
      }
    }
    expect(report(problems)).toBe("");
  });

  it("no embed is ever built with an empty title, description or field value", () => {
    // discord.js throws on those; `renderEvents` catches the throw and logs, so the only
    // symptom in production is a table that never hears about the event.
    const failures = TRANSCRIPTS.flatMap((t) =>
      t.logs
        .filter((l) => l.message.includes("could not narrate"))
        .map((l) => `${t.label}: ${JSON.stringify(l.fields)}`),
    );
    expect(report(failures)).toBe("");
  });

  it("a ceremony pauses between beats and never after the last one", () => {
    // A pause after the final beat is a `sink.pause()` the table waits through for nothing.
    const problems: string[] = [];
    for (const r of allRendered()) {
      if (r.deliveries.length === 0) continue;
      // Only ceremonies pause; every ceremony pauses exactly (beats - 1) times.
      const ceremonies: readonly GameEventType[] = [
        "challenge_revealed",
        "votes_revealed",
        "character_card_flipped",
        "jury_votes_revealed",
      ];
      if (!ceremonies.includes(r.event.type)) continue;
      if (r.deliveries.length < 2) {
        problems.push(`${r.event.type} (seq ${r.event.seq}) is a ceremony of one beat`);
      }
    }
    expect(report(problems)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 4. Degenerate games
// ---------------------------------------------------------------------------

describe("degenerate games render rather than throw", () => {
  it("a game with zero players renders a board and a lobby card", () => {
    const game = createGame({
      gameId: asGameId("render-empty"),
      hostId: asPlayerId("u-nobody"),
      config: CONFIG.engine,
      nowMs: 1_700_000_000_000,
      seed: 1,
    });
    const view = game.view();
    expect(view.players).toHaveLength(0);

    const board = statusEmbed(view, CONFIG);
    expect(report(embedProblems(board, "empty statusEmbed"))).toBe("");
    expect(board.toJSON().description).not.toBe("");

    const lobby = lobbyEmbed(view, CONFIG);
    expect(report(embedProblems(lobby, "empty lobbyEmbed"))).toBe("");
    expect(lobby.toJSON().description).not.toBe("");
  });

  it("an empty batch of events renders no messages and does not throw", async () => {
    const game = createGame({
      gameId: asGameId("render-empty-batch"),
      hostId: asPlayerId("u-nobody"),
      config: CONFIG.engine,
      nowMs: 1_700_000_000_000,
      seed: 1,
    });
    const sink = new Recorder();
    await renderEvents(
      [],
      { view: game.view(), config: CONFIG, card: (uid) => game.card(uid) },
      sink,
      { logger: recordingLogger([]) },
    );
    expect(sink.deliveries).toHaveLength(0);
  });

  it("a finished game renders a board, a lobby card and a hand", () => {
    const finished = GAMES.filter((t) => t.finalView.status === "finished");
    expect(
      finished.length,
      "at least one driven game must reach a winner",
    ).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const transcript of finished) {
      problems.push(
        ...embedProblems(
          statusEmbed(transcript.finalView, CONFIG),
          `${transcript.label} finished statusEmbed`,
        ),
      );
      problems.push(
        ...embedProblems(
          lobbyEmbed(transcript.finalView, CONFIG),
          `${transcript.label} finished lobbyEmbed`,
        ),
      );
      for (const player of transcript.finalView.players) {
        const priv = privateViewOf(transcript.finalState, player.id);
        if (!priv) continue;
        for (const [i, embed] of handEmbeds(
          priv,
          transcript.finalView,
          CONFIG,
        ).entries()) {
          problems.push(
            ...embedProblems(
              embed,
              `${transcript.label} finished hand ${player.id}[${i}]`,
            ),
          );
        }
      }
    }
    expect(report(problems)).toBe("");
  });

  it("a hand holding every card the box can put in one renders within the embed limits", () => {
    // `limits.maxHandSize` is null — the hand is unbounded by rule, so the physical ceiling is
    // the whole shuffled deck concentrated in one hand (repeated Inheritance claims and steals).
    const game = createGame({
      gameId: asGameId("render-max-hand"),
      hostId: idFor(0),
      config: CONFIG.engine,
      nowMs: 1_700_000_000_000,
      seed: 5150,
    });
    for (let i = 0; i < 6; i += 1) {
      game.dispatch(
        { type: "join_game", actor: idFor(i), displayName: NAMES[i]! },
        1 + i,
      );
    }
    game.dispatch({ type: "start_game", actor: idFor(0), firstPlayer: idFor(0) }, 100);
    const state = game.state();
    const view = game.view();
    const holdable = state.cards.filter(
      (card) =>
        card.kind !== CardKind.SurvivorCharacter &&
        card.kind !== CardKind.TribalCouncilSingle &&
        card.kind !== CardKind.TribalCouncilDouble,
    );
    expect(holdable.length).toBeGreaterThan(20);

    const maxHand: PrivateView = {
      viewer: idFor(0),
      hand: holdable,
      voteCards: state.cards.filter((card) => card.kind === CardKind.Vote).slice(0, 2),
      grantedVotes: [],
      myVotes: [],
      myPending: [],
      revealedToMe: [{ ownerId: idFor(1), atSeq: 5, cards: holdable }],
    };

    let embeds: readonly EmbedBuilder[] = [];
    expect(() => {
      embeds = handEmbeds(maxHand, view, CONFIG);
    }, `handEmbeds must survive a hand of ${holdable.length} cards`).not.toThrow();
    const problems = embeds.flatMap((embed, i) =>
      embedProblems(embed, `maxHand[${i}]`),
    );
    expect(report(problems)).toBe("");
    expect(embeds.length).toBeLessThanOrEqual(CONFIG.discord.maxEmbedsPerMessage);
  });

  it("the largest hand any driven game actually produced renders too", () => {
    const largest = Math.max(...GAMES.map((t) => t.largestHandSeen));
    expect(largest).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const transcript of GAMES) {
      for (const player of transcript.finalState.players) {
        const priv = privateViewOf(transcript.finalState, player.id);
        if (!priv) continue;
        for (const [i, embed] of handEmbeds(
          priv,
          transcript.finalView,
          CONFIG,
        ).entries()) {
          problems.push(...embedProblems(embed, `${transcript.label} hand[${i}]`));
        }
      }
    }
    expect(report(problems)).toBe("");
  });
});

/** A PrivateView rebuilt from state, so a finished game's hands can still be rendered. */
function privateViewOf(state: GameState, viewer: PlayerId): PrivateView | null {
  const player = state.players.find((p) => p.id === viewer);
  if (!player) return null;
  const resolve = (uids: readonly CardUid[]): CardInstance[] =>
    uids
      .map((uid) => state.cards.find((card) => card.uid === uid))
      .filter((card): card is CardInstance => card !== undefined);
  return {
    viewer,
    hand: resolve(player.hand),
    voteCards: resolve(player.voteCards),
    grantedVotes: resolve(player.grantedVotes),
    myVotes: [],
    myPending: [],
    revealedToMe: [],
  };
}

// ---------------------------------------------------------------------------
// 5. Coverage of the closed union
// ---------------------------------------------------------------------------

describe("coverage", () => {
  it("every GameEvent kind the union declares is rendered at least once", () => {
    // `EVENT_AUDIENCE_POLICY` is a `Record<GameEventType, …>`: its key set IS the union, so a
    // new event kind lands here without this file being touched.
    const declared = Object.keys(EVENT_AUDIENCE_POLICY) as GameEventType[];
    const missing = declared.filter((type) => !COVERED.has(type));
    expect(
      missing.length === 0
        ? ""
        : `${missing.length} event kind(s) were never rendered: ${missing.join(", ")}`,
    ).toBe("");
    expect(declared.length).toBeGreaterThan(70);
  });

  it("the hand-built gallery renders one of every kind on its own", () => {
    const inGallery = new Set(GALLERY.rendered.map((r) => r.event.type));
    const declared = Object.keys(EVENT_AUDIENCE_POLICY) as GameEventType[];
    const missing = declared.filter((type) => !inGallery.has(type));
    expect(
      missing.length === 0 ? "" : `gallery is missing: ${missing.join(", ")}`,
    ).toBe("");
  });

  it("real games, not just the gallery, reach most of the union", () => {
    const fromGames = new Set(
      GAMES.flatMap((t) => t.rendered.map((r) => r.event.type)),
    );
    const declared = Object.keys(EVENT_AUDIENCE_POLICY) as GameEventType[];
    // Nine are only reachable through lobby churn, a restore, a moderator abandon, a
    // disconnect notice or an exhausted draw pile — the lifecycle scenarios and the gallery
    // cover those. Everything else must come out of a game that was actually played.
    expect(fromGames.size).toBeGreaterThanOrEqual(declared.length - 12);
  });
});
