/**
 * Seedable deterministic PRNG.
 *
 * WHY this exists at all: audit #17 and #58 — the old `Deck.shuffle()` never shuffled the
 * "high-value" cards, it interleaved them at a fixed period in `cardlist.json` order, so idol
 * timing was fully predictable. And because every source of randomness was a bare
 * `Math.random()`, no shuffle-dependent bug could ever be reproduced in a test.
 *
 * Contract:
 *  - Given the same seed and the same call sequence, output is identical forever.
 *  - `state()` returns a plain JSON-serializable object, so the RNG round-trips through a
 *    snapshot with no replay cost: restoring mid-game continues the exact same stream.
 *  - `shuffle` is a genuine unbiased Fisher-Yates, and `int` uses rejection sampling rather
 *    than `Math.floor(random * n)`, which is measurably biased for large n.
 *
 * This module imports nothing. It is the only place in the engine allowed to be stateful.
 */

/** Serializable PRNG state. Embedded verbatim in `GameSnapshot`. */
export interface RngState {
  /** The seed the stream was originally created from. Informational — used for bug reports. */
  readonly seed: number;
  /** Current internal 32-bit state. This, not `seed`, is what resumption actually needs. */
  readonly s: number;
  /** Number of raw 32-bit draws taken so far. Informational; useful for divergence debugging. */
  readonly calls: number;
}

export interface Rng {
  /** Snapshot the stream position. Cheap; safe to call on every mutation. */
  state(): RngState;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Raw uniform 32-bit unsigned integer. The primitive everything else is built on. */
  nextUint32(): number;
  /** Uniform integer in [0, maxExclusive). Unbiased. Returns 0 when maxExclusive < 1. */
  int(maxExclusive: number): number;
  /** Uniform integer in [min, max] inclusive. Unbiased. THROWS if `max < min`. */
  range(min: number, max: number): number;
  /** Uniform element, or `undefined` for an empty array. Never throws. */
  pick<T>(items: readonly T[]): T | undefined;
  /** A NEW array holding the same elements in uniformly random order. Never mutates input. */
  shuffle<T>(items: readonly T[]): T[];
}

const UINT32 = 0x1_0000_0000;

/**
 * Create a PRNG. `mulberry32`: 32 bits of state, passes gjrand/PractRand at this scale, and
 * is four lines — the right size for a card game where the alternative was `Math.random()`.
 */
export function createRng(
  seed: number,
  resumeState?: Pick<RngState, "s" | "calls">,
): Rng {
  const initialSeed = seed | 0;
  let s = resumeState ? resumeState.s | 0 : initialSeed;
  let calls = resumeState ? resumeState.calls : 0;

  function nextUint32(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    calls += 1;
    return (t ^ (t >>> 14)) >>> 0;
  }

  function int(maxExclusive: number): number {
    const max = Math.floor(maxExclusive);
    if (max <= 1) return 0;
    // Rejection sampling: discard the ragged tail above the largest multiple of `max` that
    // fits in 32 bits, so every residue class is equally likely. Expected retries < 1.
    const limit = UINT32 - (UINT32 % max);
    let value = nextUint32();
    while (value >= limit) value = nextUint32();
    return value % max;
  }

  return {
    state: (): RngState => ({ seed: initialSeed, s, calls }),
    next: (): number => nextUint32() / UINT32,
    nextUint32,
    int,
    range: (min: number, max: number): number => {
      // A caller bug, not a rule violation, so a throw is correct (types.ts: the engine
      // returns Result for expected rule violations and throws only on an invariant break).
      // Without this, inverted arguments make `int()` see a non-positive bound and silently
      // return 0, so `range` returns a plausible-looking constant `min` forever — and since
      // this is the substrate of every shuffle and every random steal, a silent constant here
      // is the hardest possible bug to notice.
      if (max < min) {
        throw new Error(`Rng.range called with max (${max}) below min (${min})`);
      }
      return min + int(max - min + 1);
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[int(items.length)];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice();
      // Fisher-Yates, descending. `j` is drawn from [0, i] inclusive — drawing from [0, n)
      // on every step is the classic off-by-one that makes some permutations twice as likely.
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        const a = out[i];
        const b = out[j];
        // Indices are provably in range; the guards exist only for noUncheckedIndexedAccess.
        if (a === undefined || b === undefined) continue;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };
}

/** Restore a stream exactly where a snapshot left it. */
export function restoreRng(state: RngState): Rng {
  return createRng(state.seed, { s: state.s, calls: state.calls });
}

/**
 * NOTE: `randomSeed()` used to live here and no longer does. It called `Math.random()` and
 * `Date.now()` inside `src/engine/`, which contradicts the engine's own no-clock rule and
 * made the DEFAULT construction path nondeterministic — determinism is the headline
 * testability property of this engine and it should not be opt-in. Picking entropy is a
 * platform concern, so it lives in `src/discord/seed.ts` and reaches the engine through the
 * now-REQUIRED `CreateGameParams.seed`. CI greps `src/engine/` for `Math.random`, `Date.now`,
 * `setTimeout` and `setInterval`.
 */

/**
 * Derive a stable seed from a string (e.g. a Discord channel id + timestamp). FNV-1a.
 * Lets an operator reproduce a specific game from its id without storing a seed separately.
 */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
