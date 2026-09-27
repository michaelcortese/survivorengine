/**
 * Central place for tunable game settings.
 *
 * Timings can be overridden with environment variables (in seconds), so a group
 * can speed the game up or slow it down without touching code.
 */

function secondsFromEnv(name: string, fallbackSeconds: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed * 1000;
    }
    console.warn(`Ignoring invalid ${name}=${raw}; using ${fallbackSeconds}s.`);
  }
  return fallbackSeconds * 1000;
}

export const GameConfig = {
  minPlayers: 3,
  maxPlayers: 6,
  cardsPerPlayer: 3,
  /** Each player has two Survivor Character Cards; every vote-out turns one over. */
  livesPerPlayer: 2,
  /** Share of Tribal Council cards that are double eliminations (0.0 to 1.0). */
  doubleTribalRatio: 0.5,
  timings: {
    /** Default Tribal Council discussion time. The leader can start the vote early. */
    discussionMs: secondsFromEnv("DISCUSSION_SECONDS", 180),
    votingMs: secondsFromEnv("VOTING_SECONDS", 60),
    idolWindowMs: secondsFromEnv("IDOL_WINDOW_SECONDS", 60),
    nullifierWindowMs: secondsFromEnv("NULLIFIER_WINDOW_SECONDS", 30),
    /** How long a targeted player has to play Sorry for You. */
    sorryForYouWindowMs: secondsFromEnv("SORRY_FOR_YOU_SECONDS", 15),
    /** How long a leader has to break a tie before it is settled by drawing rocks. */
    tieBreakMs: secondsFromEnv("TIE_BREAK_SECONDS", 300),
    /** How long the jury has to vote at Final Tribal Council before the votes are read. */
    finalVoteMs: secondsFromEnv("FINAL_VOTE_SECONDS", 10 * 60),
    /** Pause between votes as they are read aloud. */
    voteReadMs: secondsFromEnv("VOTE_READ_SECONDS", 3),
    /** Dramatic pause before the name of the person voted out. */
    suspenseMs: secondsFromEnv("SUSPENSE_SECONDS", 5),
    /** How long a /setup lobby stays open. */
    lobbyMs: secondsFromEnv("LOBBY_SECONDS", 30 * 60),
    /** How long card pickers (give, discard, spy, forced discard) wait for a choice. */
    menuMs: secondsFromEnv("MENU_SECONDS", 60),
    /** How long Reward Challenge players have to pick (and the winner to choose who to steal from). */
    rewardChallengeMs: secondsFromEnv("REWARD_CHALLENGE_SECONDS", 60),
  },
};

/** "3 minutes", "90 seconds", "1 minute" */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
