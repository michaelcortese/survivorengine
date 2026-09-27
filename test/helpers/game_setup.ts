import type { SendableChannels } from "discord.js";
import { Game, TribalCouncilState } from "../../src/game/game";
import Player from "../../src/game/player";
import { TribalCouncil, TribalCouncilType } from "../../src/game/tribal_council";
import { FakeChannel, FakeInteraction, FakeUser, fakeUser } from "./discord_fakes";

export interface TestGame {
  channel: FakeChannel;
  users: FakeUser[];
  players: Player[];
  userOf: (player: Player) => FakeUser;
  as: (player: Player, options?: Record<string, unknown>) => FakeInteraction;
}

/** Starts a game with players P1..Pn seated in order, each with named castaways. */
export function startTestGame(count: number): TestGame {
  Game.reset();
  const channel = new FakeChannel();
  const users = Array.from({ length: count }, (_, i) => fakeUser(String(i + 1), `P${i + 1}`));
  const players = users.map(
    (user) => new Player(user.id, user.displayName, [`${user.displayName} First`, `${user.displayName} Second`]),
  );
  Game.startGame(players, {
    channel: channel as unknown as SendableChannels,
    discussionMs: 0,
    shuffleSeats: false,
  });
  const userOf = (player: Player) => users.find((user) => user.id === player.id)!;
  return {
    channel,
    users,
    players,
    userOf,
    as: (player, options = {}) => new FakeInteraction(userOf(player), channel, options),
  };
}

/**
 * Runs a Tribal Council to completion (or until a tie needs breaking) with the
 * given votes already in the urn.
 */
export async function runTribalCouncil(
  game: TestGame,
  options: {
    drawer: Player;
    votes?: Player[];
    type?: TribalCouncilType;
    before?: (council: TribalCouncil) => void;
  },
): Promise<{ council: TribalCouncil; interaction: FakeInteraction }> {
  const interaction = game.as(options.drawer);
  Game.tribalCouncilState = TribalCouncilState.Discussion;
  const council = new TribalCouncil(
    interaction.asCommand(),
    options.type ?? TribalCouncilType.SINGLE,
    options.drawer,
  );
  Game.setTribalCouncil(council);
  council.votesArray.push(...(options.votes ?? []));
  options.before?.(council);
  await council.init();
  return { council, interaction };
}

/** Knocks a castaway off a player before a test (as if voted out earlier). */
export function takeLife(player: Player) {
  player.loseLife(0);
}
