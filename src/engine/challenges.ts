/**
 * The three Reward Challenges, as simultaneous secret-submission state machines.
 *
 * All three share one shape — every participant submits in secret, nothing is visible (not even
 * to the engine's public events) until the last slot is filled, and then everything reveals at
 * once. That is not decoration: "You can discuss what you're going to do before starting, but you
 * don't have to tell the truth!" only means anything if a submission cannot be observed before
 * the reveal. `PendingChallenge.slots` carries the submissions and `PendingView` exposes only
 * `submittedPlayerIds`, so a renderer physically cannot leak one.
 *
 * They differ in exactly three ways, and each difference is printed on the card:
 *   Do or Die       — 2 players, Rock Paper Scissors, ONE round. A tie is a defined outcome
 *                     (a mutual chosen-card swap), NOT a replay.
 *   Power Pair      — exactly 3 players, 1-3 fingers. Replays while everyone differs.
 *   Numbers Game    — EVERY player in the game, 1-5 fingers, lowest UNIQUE number.
 *                     Replays until there is a single winner.
 */

import { newEffectId, emitPublic, type Ctx } from "./draft.js";
import {
  openCardChoice,
  openChallenge,
  openDiscard,
  openStealVictim,
  openTake,
  prunePending,
  recordSubmission,
  expirePending,
} from "./pending.js";
import { findPlayer } from "./player.js";
import type { ChallengeOutcome, ChallengeReveal } from "./events.js";
import {
  assertNever,
  type ChallengeKind,
  type ChallengeSubmission,
  type FingerCount,
  type PendingChallenge,
  type PlayerId,
  type RpsThrow,
} from "./types.js";

// ---------------------------------------------------------------------------
// Submission shape
// ---------------------------------------------------------------------------

/** The legal shape of a submission for each challenge. Checked BEFORE anything mutates. */
export function submissionIsLegal(
  challenge: ChallengeKind,
  submission: ChallengeSubmission,
): boolean {
  switch (challenge) {
    case "do_or_die":
      return submission.kind === "rps";
    // Both bounds, not just the upper one: `FingerCount` makes a 0 unrepresentable INSIDE the
    // engine, but this is the runtime guard at the boundary and the Discord layer parses
    // submissions out of an `unknown` payload. A 0 is by construction the lowest unique number,
    // so an unchecked one wins It's a Numbers Game outright — "hold out 1, 2, or 3 fingers" /
    // "show 1-5 fingers".
    case "power_pair":
      return (
        submission.kind === "fingers" && submission.count >= 1 && submission.count <= 3
      );
    case "its_a_numbers_game":
      return (
        submission.kind === "fingers" && submission.count >= 1 && submission.count <= 5
      );
    default:
      return assertNever(challenge, "submissionIsLegal");
  }
}

/** Every throw of Rock–Paper–Scissors, in the order a menu should offer them. */
export const RPS_THROWS: readonly RpsThrow[] = ["rock", "paper", "scissors"];

/**
 * Every submission a challenge will accept, as data.
 *
 * The ranges live inside `submissionIsLegal` above, which is a PREDICATE: a menu could not ask
 * it what to offer and so had to restate "1–3 for Power Pair, 1–5 for It's a Numbers Game" in
 * the Discord layer. Two copies of a bound is how a UI comes to offer a choice the engine then
 * rejects, which is audit #74's shape one layer up. This is the single list, and
 * `challengeChoicesAreLegal()` in the tests holds it to `submissionIsLegal`.
 */
export function challengeChoices(
  challenge: ChallengeKind,
): readonly ChallengeSubmission[] {
  switch (challenge) {
    case "do_or_die":
      return RPS_THROWS.map((raw) => ({ kind: "rps", throw: raw }) as const);
    case "power_pair":
      return fingerChoices(3);
    case "its_a_numbers_game":
      return fingerChoices(5);
    default:
      return assertNever(challenge, "challengeChoices");
  }
}

const fingerChoices = (most: 3 | 5): readonly ChallengeSubmission[] =>
  Array.from(
    { length: most },
    (_unused, index) =>
      ({ kind: "fingers", count: (index + 1) as FingerCount }) as const,
  );

const beats: Readonly<Record<RpsThrow, RpsThrow>> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

// ---------------------------------------------------------------------------
// Starting and feeding a challenge
// ---------------------------------------------------------------------------

export function startChallenge(
  ctx: Ctx,
  params: {
    readonly challenge: ChallengeKind;
    readonly cardUid: PendingChallenge["cardUid"];
    readonly initiatorId: PlayerId;
    readonly participantIds: readonly PlayerId[];
    readonly round: number;
  },
): void {
  openChallenge(ctx, params);
}

/** Record one secret submission. Resolves the round the moment the last slot fills. */
export function submitToChallenge(
  ctx: Ctx,
  pending: PendingChallenge,
  playerId: PlayerId,
  submission: ChallengeSubmission,
): void {
  const updated = recordSubmission(ctx, pending, playerId, submission);
  const filled = updated.slots.filter((s) => s.submission !== null).length;
  emitPublic(ctx, {
    type: "challenge_submission_received",
    pendingId: updated.id,
    playerId,
    round: updated.round,
    submittedCount: filled,
    participantCount: updated.slots.length,
  });
  if (filled >= updated.slots.length) resolveChallenge(ctx, updated, false);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Shown {
  readonly playerId: PlayerId;
  readonly submission: ChallengeSubmission;
}

/**
 * Reveal and resolve. `expired` means the deadline closed the window: anyone who did not submit
 * forfeits the round and is simply not considered, which is the only reading of
 * `PendingDefault.challenge_forfeited` that cannot wedge a turn.
 */
export function resolveChallenge(
  ctx: Ctx,
  pending: PendingChallenge,
  expired: boolean,
): void {
  const shown: Shown[] = [];
  for (const slot of pending.slots) {
    if (slot.submission)
      shown.push({ playerId: slot.playerId, submission: slot.submission });
  }
  if (expired) expirePending(ctx, pending, "challenge_forfeited");
  else prunePending(ctx, pending.id);

  const reveals: ChallengeReveal[] = shown.map((s) => ({
    playerId: s.playerId,
    submission: s.submission,
  }));
  emitPublic(ctx, {
    type: "challenge_revealed",
    pendingId: pending.id,
    challenge: pending.challenge,
    round: pending.round,
    reveals,
  });

  switch (pending.challenge) {
    case "do_or_die":
      resolveDoOrDie(ctx, pending, shown);
      return;
    case "power_pair":
      resolvePowerPair(ctx, pending, shown, expired);
      return;
    case "its_a_numbers_game":
      resolveNumbersGame(ctx, pending, shown, expired);
      return;
    default:
      assertNever(pending.challenge, "resolveChallenge");
  }
}

function announce(
  ctx: Ctx,
  pending: PendingChallenge,
  outcome: ChallengeOutcome,
): void {
  emitPublic(ctx, {
    type: "challenge_resolved",
    pendingId: pending.id,
    challenge: pending.challenge,
    round: pending.round,
    outcome,
  });
}

function replay(
  ctx: Ctx,
  pending: PendingChallenge,
  reason: "all_different" | "no_unique_lowest",
): void {
  emitPublic(ctx, {
    type: "challenge_replayed",
    pendingId: pending.id,
    challenge: pending.challenge,
    nextRound: pending.round + 1,
    reason,
  });
  openChallenge(ctx, {
    challenge: pending.challenge,
    cardUid: pending.cardUid,
    initiatorId: pending.initiatorId,
    participantIds: pending.slots.map((s) => s.playerId),
    round: pending.round + 1,
  });
}

// --- Do or Die -------------------------------------------------------------

function resolveDoOrDie(
  ctx: Ctx,
  pending: PendingChallenge,
  shown: readonly Shown[],
): void {
  const throws = shown.filter(
    (s): s is Shown & { submission: { kind: "rps"; throw: RpsThrow } } =>
      s.submission.kind === "rps",
  );
  const [a, b] = throws;

  if (!a) return; // Nobody threw: the card is spent and nothing happens.
  if (!b) {
    // The opponent forfeited by never throwing. "if either player wins, they steal 2 random
    // cards from the loser" — a walkover is still a win.
    const loser = pending.slots.map((s) => s.playerId).find((id) => id !== a.playerId);
    if (!loser) return;
    announce(ctx, pending, {
      kind: "rps_decisive",
      winnerId: a.playerId,
      loserId: loser,
    });
    openTake(ctx, {
      origin: {
        kind: "challenge",
        effectId: newEffectId(ctx),
        challenge: "do_or_die",
        cardUid: pending.cardUid,
      },
      takerIds: [a.playerId],
      victimId: loser,
      spec: { kind: "random", count: 2 },
    });
    return;
  }

  if (a.submission.throw === b.submission.throw) {
    // "If you tie, you each swap 1 card of your choice." The only chosen-card exchange in the
    // game, and the only Do or Die outcome that is not a steal — so no Sorry For You window.
    announce(ctx, pending, { kind: "rps_tie", playerIds: [a.playerId, b.playerId] });
    for (const side of [a, b]) {
      const player = findPlayer(ctx, side.playerId);
      const other = side === a ? b.playerId : a.playerId;
      if (!player || player.hand.length === 0) continue;
      openCardChoice(ctx, {
        chooserId: side.playerId,
        fromPlayerId: other,
        reason: "do_or_die_swap",
        options: player.hand,
      });
    }
    return;
  }

  const aWins = beats[a.submission.throw] === b.submission.throw;
  const winnerId = aWins ? a.playerId : b.playerId;
  const loserId = aWins ? b.playerId : a.playerId;
  announce(ctx, pending, { kind: "rps_decisive", winnerId, loserId });
  openTake(ctx, {
    origin: {
      kind: "challenge",
      effectId: newEffectId(ctx),
      challenge: "do_or_die",
      cardUid: pending.cardUid,
    },
    takerIds: [winnerId],
    victimId: loserId,
    spec: { kind: "random", count: 2 },
  });
}

// --- Power Pair ------------------------------------------------------------

function resolvePowerPair(
  ctx: Ctx,
  pending: PendingChallenge,
  shown: readonly Shown[],
  expired: boolean,
): void {
  const fingers = shown.filter(
    (s): s is Shown & { submission: { kind: "fingers"; count: FingerCount } } =>
      s.submission.kind === "fingers",
  );
  if (fingers.length < 3) return; // Someone forfeited: the challenge simply does not resolve.

  const counts = new Map<number, PlayerId[]>();
  for (const entry of fingers) {
    const bucket = counts.get(entry.submission.count) ?? [];
    bucket.push(entry.playerId);
    counts.set(entry.submission.count, bucket);
  }

  const pair = [...counts.values()].find((ids) => ids.length === 2);
  if (pair) {
    const [x, y] = pair;
    const odd = fingers.map((f) => f.playerId).find((id) => !pair.includes(id));
    if (!x || !y || !odd) return;
    announce(ctx, pending, {
      kind: "power_pair_matched",
      matchedIds: [x, y],
      oddOneOutId: odd,
    });
    // ONE pending with TWO takers: "they each steal 1 random card from the 3rd player", and one
    // Sorry For You from the odd one out therefore blanks both and makes each of them discard 1.
    openTake(ctx, {
      origin: {
        kind: "challenge",
        effectId: newEffectId(ctx),
        challenge: "power_pair",
        cardUid: pending.cardUid,
      },
      takerIds: [x, y],
      victimId: odd,
      spec: { kind: "random", count: 2 },
    });
    return;
  }

  const all = [...counts.values()].find((ids) => ids.length === 3);
  if (all) {
    announce(ctx, pending, { kind: "power_pair_all_same", playerIds: all });
    for (const playerId of all) openDiscard(ctx, playerId, 1, "power_pair_all_same");
    return;
  }

  // "If everyone shows a different number of fingers, play again."
  if (!expired) replay(ctx, pending, "all_different");
}

// --- It's a Numbers Game ---------------------------------------------------

function resolveNumbersGame(
  ctx: Ctx,
  pending: PendingChallenge,
  shown: readonly Shown[],
  expired: boolean,
): void {
  const fingers = shown.filter(
    (s): s is Shown & { submission: { kind: "fingers"; count: FingerCount } } =>
      s.submission.kind === "fingers",
  );
  if (fingers.length === 0) return;

  const counts = new Map<FingerCount, PlayerId[]>();
  for (const entry of fingers) {
    const bucket = counts.get(entry.submission.count) ?? [];
    bucket.push(entry.playerId);
    counts.set(entry.submission.count, bucket);
  }
  const unique = [...counts.entries()]
    .filter(([, ids]) => ids.length === 1)
    .sort((a, b) => a[0] - b[0]);
  const lowest = unique[0];

  if (!lowest) {
    // "If necessary, repeat until there's a single winner."
    if (!expired) replay(ctx, pending, "no_unique_lowest");
    return;
  }

  const winnerId = lowest[1][0];
  if (!winnerId) return;
  announce(ctx, pending, {
    kind: "numbers_game_winner",
    winnerId,
    number: lowest[0],
  });
  // "gets to steal 2 random cards from ANY player" — the winner names the victim, which is a
  // second decision and therefore a second window.
  openStealVictim(ctx, {
    chooserId: winnerId,
    cardUid: pending.cardUid,
    effectId: newEffectId(ctx),
    count: 2,
  });
}
