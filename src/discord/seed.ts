/**
 * Where entropy enters the system.
 *
 * WHY this file exists and why it is NOT in `src/engine/`: `Math.random()` and `Date.now()`
 * are platform calls, and `src/engine/**` may make neither (ARCHITECTURE.md §1 — "the engine
 * has no clock"). Keeping the one nondeterministic function out here means the engine's
 * determinism is total rather than "total except for this function", `CreateGameParams.seed`
 * can be REQUIRED, and a test physically cannot forget to pin the seed.
 *
 * `seedFromString` stays in `engine/rng.ts` — it is pure, and reproducing a specific game from
 * its channel id is an engine-side concern.
 */

const UINT32 = 0x1_0000_0000;

/**
 * A fresh seed for a new game. Called once, by the session registry, at game creation.
 *
 * Mixes a `Math.random()` draw with the wall clock so two games created in the same
 * millisecond still diverge. The value is echoed in the `game_started` event, so any game can
 * be replayed exactly from its log.
 */
export function randomSeed(): number {
  return (Math.floor(Math.random() * UINT32) ^ Date.now()) | 0;
}
