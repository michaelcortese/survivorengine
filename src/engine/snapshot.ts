/**
 * Snapshots: pure, versioned, total, and validated at the boundary.
 *
 * Audit #98/#102: the old save format had no schema version and no validation, and two mutually
 * incompatible files already sat on disk at the repo root; audit #27/#33/#59/#100/#101: the old
 * restore rebuilt one half of the council state while forcing the other half to null (a
 * permanently wedged game) and silently dropped Camp Raid markers and Inheritance links.
 *
 * The fix is structural rather than careful: `GameState` is plain JSON — arrays, strings,
 * numbers, booleans and nulls, no `Map`, no `Set`, no class instance and no object reference
 * that has to be re-linked — so a round trip is a deep copy and nothing can be lost in a
 * fixup pass that does not exist. Card identity is a `CardUid` string and player identity is a
 * `PlayerId` string, which is what makes that true.
 *
 * `parseSnapshot` is the ONLY way in. It has real error codes to fail with, so a bad file is
 * reported as a bad file (`snapshot_malformed`, `snapshot_version_unsupported`,
 * `snapshot_card_census_mismatch`) rather than as an internal invariant break — which the old
 * code logged as a crash.
 *
 * No `fs` here, by the dependency rule: this module turns state into a plain object and back.
 */

import { auditCensus } from "./card.js";
import {
  COUNCIL_PHASE_ORDER,
  FINAL_COUNCIL_PHASE_ORDER,
  SNAPSHOT_SCHEMA_VERSION,
  TURN_PHASE_ORDER,
  err,
  ok,
  type GameSnapshot,
  type GameState,
  type Result,
} from "./types.js";

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Deep copy through the JSON value space. Anything that is not JSON — a function, a `Map`, an
 * `undefined` — is a bug in a state type rather than something to coerce, so it throws.
 */
export function deepCloneJson(value: unknown): JsonValue {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value as JsonValue;
  }
  if (kind === "object") {
    if (Array.isArray(value)) return value.map((v) => deepCloneJson(v));
    const out: Record<string, JsonValue> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined) continue;
      out[key] = deepCloneJson(raw);
    }
    return out;
  }
  throw new Error(`deepCloneJson: ${kind} is not JSON-serializable`);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function createSnapshot(state: GameState, savedAtMs: number): GameSnapshot {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, savedAtMs, state };
}

/** The plain object a persistence layer would hand to `JSON.stringify`. */
export function serializeSnapshot(snapshot: GameSnapshot): JsonValue {
  return deepCloneJson(snapshot);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isNumberOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v));

function malformed<T>(what: string, detail?: string): Result<T> {
  return err<T>(
    "snapshot_malformed",
    `snapshot is malformed: ${what}${detail ? ` (${detail})` : ""}`,
    { field: what },
  );
}

function checkPlayer(raw: unknown, at: number): string | null {
  if (!isRecord(raw)) return `players[${at}] is not an object`;
  if (typeof raw.id !== "string") return `players[${at}].id`;
  if (typeof raw.displayName !== "string") return `players[${at}].displayName`;
  if (typeof raw.color !== "string") return `players[${at}].color`;
  if (typeof raw.seat !== "number") return `players[${at}].seat`;
  if (!isStringArray(raw.hand)) return `players[${at}].hand`;
  if (!isStringArray(raw.voteCards)) return `players[${at}].voteCards`;
  if (!isStringArray(raw.grantedVotes)) return `players[${at}].grantedVotes`;
  if (!Array.isArray(raw.characterCards)) return `players[${at}].characterCards`;
  for (const [i, card] of raw.characterCards.entries()) {
    if (
      !isRecord(card) ||
      typeof card.uid !== "string" ||
      typeof card.flipped !== "boolean"
    ) {
      return `players[${at}].characterCards[${i}]`;
    }
    if (!isNumberOrNull(card.flippedAtSeq))
      return `players[${at}].characterCards[${i}].flippedAtSeq`;
  }
  if (raw.campRaid !== null) {
    if (
      !isRecord(raw.campRaid) ||
      typeof raw.campRaid.cardUid !== "string" ||
      typeof raw.campRaid.raiderId !== "string" ||
      typeof raw.campRaid.placedAtSeq !== "number"
    ) {
      return `players[${at}].campRaid`;
    }
  }
  if (!isNumberOrNull(raw.eliminatedAtSeq)) return `players[${at}].eliminatedAtSeq`;
  if (!isNumberOrNull(raw.leftAtSeq)) return `players[${at}].leftAtSeq`;
  if (typeof raw.connected !== "boolean") return `players[${at}].connected`;
  return null;
}

const PENDING_KINDS = [
  "take",
  "discard",
  "challenge",
  "card_choice",
  "alliance_target",
  "steal_victim",
  "leader_decision",
  "inheritance",
];

function checkPending(raw: unknown, at: number): string | null {
  if (!isRecord(raw)) return `pending[${at}] is not an object`;
  if (typeof raw.kind !== "string" || !PENDING_KINDS.includes(raw.kind)) {
    return `pending[${at}].kind`;
  }
  if (typeof raw.id !== "string") return `pending[${at}].id`;
  if (raw.status !== "open") {
    // The pruning invariant: a pending that has reached a terminal status is REMOVED from
    // state, so a saved file holding one is a file written by a different implementation.
    return `pending[${at}].status must be "open"`;
  }
  if (typeof raw.openedAtMs !== "number" || typeof raw.deadlineMs !== "number") {
    return `pending[${at}] timing`;
  }
  if (raw.kind === "challenge") {
    if (!Array.isArray(raw.slots)) return `pending[${at}].slots`;
    for (const [i, slot] of raw.slots.entries()) {
      if (!isRecord(slot) || typeof slot.playerId !== "string") {
        return `pending[${at}].slots[${i}]`;
      }
    }
  }
  if (raw.kind === "take") {
    if (!isStringArray(raw.takerIds) || raw.takerIds.length === 0) {
      return `pending[${at}].takerIds`;
    }
    if (typeof raw.victimId !== "string") return `pending[${at}].victimId`;
    if (!isRecord(raw.spec)) return `pending[${at}].spec`;
  }
  if (raw.kind === "inheritance") {
    // The window closes in a later dispatch than the elimination that opened it, so the
    // elimination's own report — what left the table, and which `FinalCouncilTrigger` the
    // endgame check was deferring — is carried on the pending. A file without them would
    // narrate the claim with `undefined` counters rather than fail loudly here.
    if (typeof raw.voteCardsReturned !== "number")
      return `pending[${at}].voteCardsReturned`;
    if (typeof raw.grantedVotesDiscarded !== "number") {
      return `pending[${at}].grantedVotesDiscarded`;
    }
    if (typeof raw.deferredTrigger !== "string")
      return `pending[${at}].deferredTrigger`;
  }
  return null;
}

function checkStage(raw: unknown): string | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return "stage";
  switch (raw.kind) {
    case "lobby":
      return null;
    case "turn":
    case "council": {
      const turn = raw.turn;
      if (!isRecord(turn)) return "stage.turn";
      if (typeof turn.playerId !== "string") return "stage.turn.playerId";
      if (
        typeof turn.phase !== "string" ||
        !TURN_PHASE_ORDER.includes(turn.phase as never)
      ) {
        return "stage.turn.phase";
      }
      if (typeof turn.stealResolved !== "boolean") return "stage.turn.stealResolved";
      if (typeof turn.turnNumber !== "number") return "stage.turn.turnNumber";
      if (raw.kind === "turn") return null;
      const council = raw.council;
      if (!isRecord(council)) return "stage.council";
      if (typeof council.id !== "string") return "stage.council.id";
      if (council.kind !== "single" && council.kind !== "double")
        return "stage.council.kind";
      if (
        typeof council.phase !== "string" ||
        !COUNCIL_PHASE_ORDER.includes(council.phase as never)
      ) {
        return "stage.council.phase";
      }
      if (typeof council.cardUid !== "string") return "stage.council.cardUid";
      if (typeof council.leaderId !== "string") return "stage.council.leaderId";
      if (typeof council.drawerId !== "string") return "stage.council.drawerId";
      for (const key of [
        "advantagesPlayed",
        "votes",
        "finishedVoting",
        "requiredCasts",
        "idolPlays",
        "nullifierPlays",
        "flippedThisCouncil",
      ]) {
        if (!Array.isArray(council[key])) return `stage.council.${key}`;
      }
      if (typeof council.eliminationsRemaining !== "number") {
        return "stage.council.eliminationsRemaining";
      }
      return null;
    }
    case "final_council": {
      const final = raw.finalCouncil;
      if (!isRecord(final)) return "stage.finalCouncil";
      if (
        typeof final.phase !== "string" ||
        !FINAL_COUNCIL_PHASE_ORDER.includes(final.phase as never)
      ) {
        return "stage.finalCouncil.phase";
      }
      if (typeof final.leaderId !== "string") return "stage.finalCouncil.leaderId";
      // JSON.parse gives a plain array; the contract's 2-tuple arity has to be checked here or
      // nowhere (audit #98/#102 name this case explicitly).
      if (!isStringArray(final.finalists) || final.finalists.length !== 2) {
        return "stage.finalCouncil.finalists must hold exactly 2 player ids";
      }
      if (!isStringArray(final.jury)) return "stage.finalCouncil.jury";
      if (!Array.isArray(final.juryVotes)) return "stage.finalCouncil.juryVotes";
      if (final.winnerId !== null && typeof final.winnerId !== "string") {
        return "stage.finalCouncil.winnerId";
      }
      return null;
    }
    case "finished":
      if (raw.winnerId !== null && typeof raw.winnerId !== "string")
        return "stage.winnerId";
      if (typeof raw.finishedAtMs !== "number") return "stage.finishedAtMs";
      return null;
    case "abandoned":
      if (typeof raw.abandonedById !== "string") return "stage.abandonedById";
      if (typeof raw.abandonedAtMs !== "number") return "stage.abandonedAtMs";
      return null;
    default:
      return `stage.kind "${raw.kind}" is not a known stage`;
  }
}

function checkConfig(raw: unknown): string | null {
  if (!isRecord(raw)) return "state.config";
  for (const key of ["limits", "deck", "timings", "houseRules"]) {
    if (!isRecord(raw[key])) return `state.config.${key}`;
  }
  const timings = raw.timings;
  if (!isRecord(timings) || !isRecord(timings.pendingWindows)) {
    return "state.config.timings.pendingWindows";
  }
  for (const kind of PENDING_KINDS) {
    if (typeof timings.pendingWindows[kind] !== "number") {
      return `state.config.timings.pendingWindows.${kind}`;
    }
  }
  return null;
}

/**
 * Validate raw JSON off a disk into a `GameSnapshot`.
 *
 * Checks, in order: the envelope, the schema version, the structural shape of every part of the
 * state that the engine will index into, and finally the card census — every uid in the registry
 * accounted for in exactly one place, and no uid held anywhere that the registry does not know.
 */
export function parseSnapshot(raw: unknown): Result<GameSnapshot> {
  if (!isRecord(raw)) return malformed("root is not an object");
  if (typeof raw.schemaVersion !== "number") return malformed("schemaVersion");
  if (raw.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return err(
      "snapshot_version_unsupported",
      `snapshot schema version ${raw.schemaVersion} is not supported (engine speaks ${SNAPSHOT_SCHEMA_VERSION})`,
      { found: raw.schemaVersion, expected: SNAPSHOT_SCHEMA_VERSION },
    );
  }
  if (typeof raw.savedAtMs !== "number") return malformed("savedAtMs");

  const state = raw.state;
  if (!isRecord(state)) return malformed("state");
  if (typeof state.gameId !== "string") return malformed("state.gameId");
  if (typeof state.hostId !== "string") return malformed("state.hostId");
  if (typeof state.seq !== "number") return malformed("state.seq");
  if (typeof state.createdAtMs !== "number") return malformed("state.createdAtMs");
  if (!isNumberOrNull(state.startedAtMs)) return malformed("state.startedAtMs");
  if (state.playerCount !== null && typeof state.playerCount !== "number") {
    return malformed("state.playerCount");
  }

  const configProblem = checkConfig(state.config);
  if (configProblem) return malformed(configProblem);

  const rng = state.rng;
  if (
    !isRecord(rng) ||
    typeof rng.seed !== "number" ||
    typeof rng.s !== "number" ||
    typeof rng.calls !== "number"
  ) {
    return malformed("state.rng");
  }

  const stageProblem = checkStage(state.stage);
  if (stageProblem) return malformed(stageProblem);

  if (!Array.isArray(state.players)) return malformed("state.players");
  for (const [i, player] of state.players.entries()) {
    const problem = checkPlayer(player, i);
    if (problem) return malformed(problem);
  }

  if (!Array.isArray(state.cards)) return malformed("state.cards");
  for (const [i, card] of state.cards.entries()) {
    if (
      !isRecord(card) ||
      typeof card.uid !== "string" ||
      typeof card.kind !== "string"
    ) {
      return malformed(`state.cards[${i}]`);
    }
  }

  const zones = state.zones;
  if (!isRecord(zones)) return malformed("state.zones");
  for (const zone of [
    "drawPile",
    "discardPile",
    "removedFromGame",
    "voteCardBank",
    "votingBox",
    "inPlay",
  ]) {
    if (!isStringArray(zones[zone])) return malformed(`state.zones.${zone}`);
  }

  if (!Array.isArray(state.pending)) return malformed("state.pending");
  for (const [i, pending] of state.pending.entries()) {
    const problem = checkPending(pending, i);
    if (problem) return malformed(problem);
  }

  if (!Array.isArray(state.reveals)) return malformed("state.reveals");
  for (const [i, reveal] of state.reveals.entries()) {
    if (
      !isRecord(reveal) ||
      typeof reveal.ownerId !== "string" ||
      typeof reveal.viewerId !== "string" ||
      !isStringArray(reveal.cardUids)
    ) {
      return malformed(`state.reveals[${i}]`);
    }
  }

  // The census. Cheap, and it is the single guard against the whole audit #75/#121 family.
  const typed = state as unknown as GameState;
  const problems = auditCensus(
    typed.cards,
    typed.players.map((p) => ({
      id: p.id,
      hand: p.hand,
      voteCards: p.voteCards,
      grantedVotes: p.grantedVotes,
      characterCards: p.characterCards,
    })),
    typed.zones,
  );
  if (problems.length > 0) {
    const first = problems[0];
    return err(
      "snapshot_card_census_mismatch",
      `snapshot card census does not balance: ${problems.length} problem(s), first is ${first?.uid ?? "?"} ${first?.problem ?? "?"}`,
      {
        problems: problems.length,
        firstUid: first?.uid ?? null,
        firstProblem: first?.problem ?? null,
      },
    );
  }

  // Every validation above has run; this is the one cast, and it is the reason
  // `src/persistence` never needs one (audit #98/#102: "must never write `raw as GameSnapshot`").
  return ok({
    schemaVersion: raw.schemaVersion,
    savedAtMs: raw.savedAtMs,
    state: typed,
  });
}
