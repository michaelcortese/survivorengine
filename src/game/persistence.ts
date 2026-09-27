import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client, SendableChannels } from "discord.js";
import { Game, TribalCouncilState } from "./game";
import Player from "./player";
import Card from "./card";
import Deck from "./deck";
import type { Castaway } from "./castaways";
import { announceHandSettlements } from "./tribal_council";
import {
  createFinalTribalCouncil,
  startFinalTribalCouncil,
} from "./final_tribal_council";
import type { Announcer } from "../util/discord";

/**
 * Keeps games going across bot restarts. The game is written to a JSON file
 * shortly after every change (see Game.changed) and read back when the bot
 * starts. Timers and Discord collectors can't be saved, so on restore:
 *
 * - a Tribal Council that was in progress is called off: votes are reset and
 *   play continues after the player who drew it;
 * - a Final Tribal Council keeps the jury's votes and posts new vote buttons;
 * - a /setup lobby is dropped.
 */

const SAVE_VERSION = 1;
/** Changes are batched: the file is written this long after the first one. */
const SAVE_DELAY_MS = 500;

interface SavedCard {
  name: string;
  description: string | null;
  compactDescription: string | null;
  imageUrl: string | null;
  tribalValue?: number;
  /** Id of the player whose hand this Inheritance card inherits. */
  inheritancePlayer?: string;
}

interface SavedCastaway {
  name: string;
  lost: boolean;
  lostAtTribal?: number;
  chosen: boolean;
  /** The uploaded photo, base64-encoded. */
  image?: string;
}

interface SavedPlayer {
  id: string;
  username: string;
  color: string;
  avatarUrl?: string;
  castaways: SavedCastaway[];
  hand: SavedCard[];
  votes: number;
  /** Id of the player who raided this player's camp. */
  campRaid?: string;
}

/** A Tribal Council that was in progress. It is called off on restore. */
interface SavedTribalCouncil {
  number: number;
  drawer?: string;
  leader?: string;
  leaderChangedByCard: boolean;
  /** Players knocked out of the game at this council, whose hands aren't settled yet. */
  eliminated: string[];
}

/** Saved once the game reaches the final two. */
interface SavedFinalTribalCouncil {
  /** Juror id -> finalist id. */
  votes: Record<string, string>;
  /** The votes were being read, or a tie was waiting on the leader. */
  votingClosed: boolean;
}

export interface SavedGame {
  version: number;
  active: boolean;
  channelId: string | null;
  discussionMs: number;
  players: SavedPlayer[];
  /** The draw pile, bottom first: the last card is drawn next. */
  deck: SavedCard[];
  currentPlayerIndex: number;
  tribalCouncilCount: number;
  finalTribalLeader: string | null;
  winner: string | null;
  tribalCouncil: SavedTribalCouncil | null;
  finalTribalCouncil: SavedFinalTribalCouncil | null;
}

function saveCard(card: Card): SavedCard {
  return {
    name: card.name,
    description: card.description,
    compactDescription: card.compactDescription,
    imageUrl: card.imageUrl,
    tribalValue: card.tribalValue,
    inheritancePlayer: card.inheritancePlayer?.id,
  };
}

function saveCastaway(castaway: Castaway): SavedCastaway {
  return {
    name: castaway.name,
    lost: castaway.lost,
    lostAtTribal: castaway.lostAtTribal,
    chosen: castaway.chosen,
    image: castaway.image?.toString("base64"),
  };
}

function savePlayer(player: Player): SavedPlayer {
  return {
    id: player.id,
    username: player.username,
    color: player.color,
    avatarUrl: player.avatarUrl,
    castaways: player.castaways.map(saveCastaway),
    hand: player.hand.map(saveCard),
    votes: player.votes,
    campRaid: player.campRaid?.id,
  };
}

/** The game as plain JSON data, or null when there's no game to save. */
export function serializeGame(): SavedGame | null {
  if (Game.players.length === 0) return null;
  const council = Game.tribalCouncil;
  const final = Game.finalTribalCouncil;
  return {
    version: SAVE_VERSION,
    active: Game.active,
    channelId: Game.channel?.id ?? null,
    discussionMs: Game.discussionMs,
    players: Game.players.map(savePlayer),
    deck: Game.deck.peekAll().map(saveCard),
    currentPlayerIndex: Game.currentPlayerIndex,
    tribalCouncilCount: Game.tribalCouncilCount,
    finalTribalLeader: Game.finalTribalLeader?.id ?? null,
    winner: Game.winner?.id ?? null,
    tribalCouncil: council && {
      number: council.number,
      drawer: council.drawer?.id,
      leader: council.leader?.id,
      leaderChangedByCard: council.leaderChangedByCard,
      eliminated: council.eliminated.map((player) => player.id),
    },
    // Saved as soon as two players remain, even before the council has opened.
    finalTribalCouncil:
      Game.tribalCouncilState === TribalCouncilState.FINAL
        ? {
            votes: Object.fromEntries(
              [...(final?.votes ?? [])].map(([jurorId, finalist]) => [jurorId, finalist.id]),
            ),
            votingClosed: final ? !final.votingOpen : false,
          }
        : null,
  };
}

function check(ok: unknown, problem: string): asserts ok {
  if (!ok) throw new Error(`Invalid save file: ${problem}`);
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function loadCastaway(saved: SavedCastaway): Castaway {
  check(
    typeof saved?.name === "string" && typeof saved.lost === "boolean",
    "a castaway is missing its name or whether it was voted out",
  );
  return {
    name: saved.name,
    lost: saved.lost,
    lostAtTribal: saved.lostAtTribal,
    chosen: saved.chosen,
    image: saved.image === undefined ? undefined : Buffer.from(saved.image, "base64"),
  };
}

/** A player without their hand or camp raid, which point at other players. */
function loadPlayer(saved: SavedPlayer): Player {
  check(
    typeof saved?.id === "string" && typeof saved.username === "string",
    "a player is missing their id or name",
  );
  check(
    Array.isArray(saved.castaways) && Array.isArray(saved.hand),
    `player ${saved.id} is missing their castaways or hand`,
  );
  const player = new Player(saved.id, saved.username);
  player.color = saved.color;
  player.avatarUrl = saved.avatarUrl;
  player.castaways = saved.castaways.map(loadCastaway);
  player.votes = saved.votes;
  return player;
}

type PickUp = (client: Client) => Promise<void>;

/** A restored game, waiting for its channel before carrying on. */
export interface RestoredGame {
  gameId: number;
  channelId: string | null;
  /** Posts a restart notice and picks up whatever the restart interrupted. */
  pickUp: PickUp;
}

interface InterruptedCouncil {
  number: number;
  drawer?: Player;
  /** Set if someone took over with I'm the Leader Now (they get the next turn). */
  newLeader?: Player;
  eliminated: Player[];
}

/** Restored flows post in the game's channel: there's no interaction to reply to. */
const say: Announcer = (payload) => Game.announce(payload);

/**
 * Calls off the Tribal Council the restart interrupted, like one that fails:
 * votes are reset, anyone already knocked out hands over their cards, and play
 * moves on.
 */
function callOffTribalCouncil(council: InterruptedCouncil): PickUp {
  const next = Game.endTribalCouncil(council.drawer, council.newLeader);
  const settlements = Game.settleEliminatedHands(council.eliminated);
  const lostTonight = Game.players.some((player) =>
    player.castaways.some((castaway) => castaway.lostAtTribal === council.number),
  );
  return async (client) => {
    await say(
      `🔄 The bot restarted in the middle of Tribal Council #${council.number}, so it has been called off and everyone's votes are reset.` +
        (lostTonight ? " Castaways already voted out tonight stay out." : "") +
        (next ? ` It's <@${next.id}>'s turn.` : ""),
    );
    await announceHandSettlements(settlements, say, client);
    if (!next) {
      const started = await startFinalTribalCouncil(say);
      if (typeof started === "string") {
        console.warn(`Final Tribal Council didn't start: ${started}`);
      }
    }
  };
}

/**
 * Brings back the Final Tribal Council with the votes the jury already cast.
 * If voting was open, the vote buttons are posted again; otherwise the votes
 * are read.
 */
function reopenFinalTribalCouncil(
  votes: [Player, Player][],
  votingClosed: boolean,
): PickUp {
  const council = createFinalTribalCouncil(say);
  if (typeof council === "string") {
    console.warn(`Couldn't restore the Final Tribal Council: ${council}`);
    return async () => undefined;
  }
  for (const [juror, finalist] of votes) council.recordVote(juror, finalist);
  return async () => {
    if (votingClosed || council.allVoted) {
      await say(
        "🔄 The bot restarted during the Final Tribal Council. Voting is over, so here come the votes.",
      );
      await council.reveal();
      return;
    }
    const cast = council.votes.size;
    await say(
      "🔄 The bot restarted during the Final Tribal Council." +
        (cast > 0 ? ` The jury's votes are safe (${cast}/${council.jury.length} cast).` : "") +
        " Jurors who haven't voted yet can use the new buttons below.",
    );
    await council.open();
  };
}

function welcomeBack(): PickUp {
  return async () => {
    const current = Game.currentPlayer();
    await say(
      "🔄 The bot restarted, but the game was saved and picks up where it left off." +
        (current ? ` It's <@${current.id}>'s turn.` : "") +
        " Card menus and Sorry for You countdowns that were open have been cancelled.",
    );
  };
}

/** Rebuilding the game from its save isn't a change worth saving. */
let restoring = false;

/**
 * Replaces the current game with a saved one. The save is checked before
 * anything changes, so a bad save throws and leaves the game alone. Call
 * pickUp() on the result once the game's channel is back.
 */
export function restoreGame(saved: SavedGame): RestoredGame {
  check(saved?.version === SAVE_VERSION, `unsupported version ${saved?.version}`);
  check(Array.isArray(saved.players) && saved.players.length > 0, "there are no players");

  const players = saved.players.map(loadPlayer);
  const playersById = new Map(players.map((player) => [player.id, player]));
  check(playersById.size === players.length, "two players have the same id");
  const playerById = (id: string): Player => {
    const player = playersById.get(id);
    check(player, `there is no player with id ${id}`);
    return player;
  };
  const optionalPlayer = (id: string | null | undefined) =>
    typeof id === "string" ? playerById(id) : undefined;
  const loadCard = (card: SavedCard): Card => {
    check(typeof card?.name === "string", "a card has no name");
    return new Card(
      card.name,
      card.description ?? null,
      card.compactDescription ?? null,
      card.imageUrl ?? null,
      card.tribalValue,
      optionalPlayer(card.inheritancePlayer),
    );
  };

  saved.players.forEach((data, i) => {
    players[i].hand = data.hand.map(loadCard);
    players[i].campRaid = optionalPlayer(data.campRaid);
  });
  check(Array.isArray(saved.deck), "there is no draw pile");
  const deck = Deck.fromCards(saved.deck.map(loadCard));
  check(
    isCount(saved.currentPlayerIndex) && saved.currentPlayerIndex < players.length,
    "it's the turn of a player who doesn't exist",
  );
  check(
    isCount(saved.tribalCouncilCount) && isCount(saved.discussionMs),
    "the Tribal Council count or discussion time is invalid",
  );
  const finalTribalLeader = optionalPlayer(saved.finalTribalLeader) ?? null;
  const winner = optionalPlayer(saved.winner) ?? null;

  const savedCouncil = saved.tribalCouncil;
  check(
    !savedCouncil || (isCount(savedCouncil.number) && Array.isArray(savedCouncil.eliminated)),
    "the Tribal Council in progress is incomplete",
  );
  const council: InterruptedCouncil | null = savedCouncil && {
    number: savedCouncil.number,
    drawer: optionalPlayer(savedCouncil.drawer),
    newLeader: savedCouncil.leaderChangedByCard
      ? optionalPlayer(savedCouncil.leader)
      : undefined,
    eliminated: savedCouncil.eliminated.map(playerById),
  };
  const savedFinal = saved.finalTribalCouncil;
  check(
    !savedFinal || (typeof savedFinal.votes === "object" && savedFinal.votes !== null),
    "the Final Tribal Council is incomplete",
  );
  check(
    !savedFinal || !saved.active || players.filter((p) => p.isAlive()).length === 2,
    "the Final Tribal Council doesn't have two finalists",
  );
  const juryVotes = Object.entries(savedFinal?.votes ?? {}).map(
    ([jurorId, finalistId]): [Player, Player] => [playerById(jurorId), playerById(finalistId)],
  );

  let pickUp: PickUp;
  restoring = true;
  try {
    Game.reset();
    Game.players = players;
    Game.deck = deck;
    Game.currentPlayerIndex = saved.currentPlayerIndex;
    Game.discussionMs = saved.discussionMs;
    Game.tribalCouncilCount = saved.tribalCouncilCount;
    Game.finalTribalLeader = finalTribalLeader;
    Game.winner = winner;
    Game.active = saved.active === true;
    Game.tribalCouncilState = savedFinal
      ? TribalCouncilState.FINAL
      : TribalCouncilState.NotStarted;

    if (!Game.active) {
      pickUp = async () => undefined; // a finished game only needs its final board back
    } else if (council) {
      pickUp = callOffTribalCouncil(council);
    } else if (savedFinal) {
      pickUp = reopenFinalTribalCouncil(juryVotes, savedFinal.votingClosed === true);
    } else {
      pickUp = welcomeBack();
    }
  } finally {
    restoring = false;
  }

  const gameId = Game.id;
  console.log(`Restored the saved game (${players.length} players).`);
  return {
    gameId,
    channelId: saved.channelId ?? null,
    pickUp: async (client) => {
      // Skip it if the game was ended or replaced in the meantime.
      if (Game.isCurrentGame(gameId)) await pickUp(client);
    },
  };
}

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the game is saved: SAVE_FILE if it's set, otherwise data/game.json. */
export function saveFilePath(): string {
  const configured = process.env.SAVE_FILE?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(projectDir, "data", "game.json");
}

let saveFile: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;
/** Saves are written one at a time, in order. */
let writes: Promise<void> = Promise.resolve();
/** The last thing written (null: the file was deleted), to skip writes that change nothing. */
let lastWrite: { file: string; json: string | null } | null = null;

/** Saves the game to `file` shortly after every change. */
export function enableAutosave(file = saveFilePath()): void {
  saveFile = file;
  lastWrite = null;
  Game.onChange = scheduleSave;
}

/** Stops saving. Call flushSave() first to keep changes that are still pending. */
export function disableAutosave(): void {
  Game.onChange = null;
  saveFile = null;
  cancelScheduledSave();
}

function cancelScheduledSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function scheduleSave(): void {
  if (restoring || !saveFile) return;
  if (Game.players.length === 0) {
    // The game was ended or reset: delete the save straight away.
    cancelScheduledSave();
    queueWrite(null);
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  saveTimer.unref();
}

function saveNow(): void {
  saveTimer = null;
  // During a Sorry for You window a card can be up for grabs (a raided draw
  // belongs to nobody yet), so wait until it lands. Until then the file keeps
  // the game from before the action, which is what a restart goes back to.
  if (Game.interruption) {
    scheduleSave();
    return;
  }
  const saved = serializeGame();
  queueWrite(saved && JSON.stringify(saved, null, 2));
}

function queueWrite(json: string | null): void {
  const file = saveFile;
  if (!file) return;
  writes = writes
    .then(async () => {
      if (lastWrite?.file === file && lastWrite.json === json) return;
      if (json === null) {
        await fs.promises.rm(file, { force: true });
      } else {
        // Write a temporary file and swap it in, so a crash can't leave half a save.
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(`${file}.tmp`, json);
        await fs.promises.rename(`${file}.tmp`, file);
      }
      lastWrite = { file, json };
    })
    .catch((error) => console.error("Couldn't save the game:", error));
}

/** Writes any pending change now, and resolves once the save file is up to date. */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    cancelScheduledSave();
    saveNow();
  }
  await writes;
}

/** Reads and restores the save file, if there is one. A save that can't be restored is moved aside. */
function restoreSaveFile(file: string): RestoredGame | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Couldn't read the saved game at ${file}:`, error);
    }
    return null;
  }
  try {
    return restoreGame(JSON.parse(text));
  } catch (error) {
    const aside = `${file}.broken`;
    console.error(`Couldn't restore the saved game, so it was moved to ${aside}:`, error);
    try {
      fs.renameSync(file, aside);
    } catch (renameError) {
      console.error(`Couldn't move the broken save out of the way:`, renameError);
    }
    return null;
  }
}

async function fetchChannel(
  client: Client,
  channelId: string | null,
): Promise<SendableChannels | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch((error) => {
    console.error(`Couldn't fetch the game's channel (${channelId}):`, error);
    return null;
  });
  if (channel?.isSendable()) return channel;
  console.warn(`The game's channel (${channelId}) isn't available, so game announcements are off.`);
  return null;
}

/**
 * Picks up the saved game when the bot starts, then saves every change from
 * then on. Runs in the ready event, where the client can fetch the channel.
 */
export async function resumeSavedGame(
  client: Client,
  file = saveFilePath(),
): Promise<void> {
  // Restored before the first await, so the game is back before the bot
  // handles any interactions.
  const restored = restoreSaveFile(file);
  if (restored) {
    const channel = await fetchChannel(client, restored.channelId);
    if (Game.isCurrentGame(restored.gameId)) Game.channel = channel;
  }
  // Only now, so a save can't drop the channel while it's being fetched.
  enableAutosave(file);
  if (!restored) return;
  Game.changed();
  await restored.pickUp(client);
}
