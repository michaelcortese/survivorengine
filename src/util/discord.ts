import {
  BaseMessageOptions,
  Client,
  Message,
  MessageFlags,
  RepliableInteraction,
  SendableChannels,
  TextBasedChannel,
  User,
} from "discord.js";
import type Card from "../game/card";
import type Player from "../game/player";
import { Game, InterruptionOutcome } from "../game/game";
import { GameConfig } from "../game/config";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mention(player: { id: string }): string {
  return `<@${player.id}>`;
}

/** The bits of a Discord user a game or lobby needs. */
export function userInfo(user: User): {
  id: string;
  displayName: string;
  avatarUrl: string;
} {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.displayAvatarURL({ extension: "png", size: 128 }),
  };
}

export function sendableChannel(
  channel: TextBasedChannel | null,
): SendableChannels | null {
  return channel?.isSendable() ? channel : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Replies (or follows up) with a message only the user can see. */
export async function replyEphemeral(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  const payload = { content, flags: MessageFlags.Ephemeral } as const;
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

export type Announcer = (
  payload: string | BaseMessageOptions,
) => Promise<Message | null>;

/**
 * Posts public messages for a long-running flow. Prefers sending straight to
 * the channel, because interaction follow-ups stop working after 15 minutes.
 */
export function createAnnouncer(interaction: RepliableInteraction): Announcer {
  return async (payload) => {
    const options: BaseMessageOptions =
      typeof payload === "string" ? { content: payload } : payload;
    const channel = interaction.channel;
    if (channel?.isSendable()) {
      try {
        return await channel.send(options);
      } catch (error) {
        console.error("Couldn't post in the channel, using a follow-up:", error);
      }
    }
    try {
      return await interaction.followUp(options);
    } catch (error) {
      console.error("Couldn't post a follow-up message:", error);
      return null;
    }
  };
}

export async function sendDM(
  client: Client,
  userId: string,
  content: string,
): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
    return true;
  } catch (error) {
    console.log(`Could not send DM to <@${userId}>:`, error);
    return false;
  }
}

/**
 * Select-menu options for a hand, one per distinct card (Discord allows at most
 * 25 options). The option value is the card name.
 */
export function handSelectOptions(hand: Card[]) {
  const groups = new Map<string, { card: Card; count: number }>();
  for (const card of hand) {
    const group = groups.get(card.getName());
    if (group) {
      group.count++;
    } else {
      groups.set(card.getName(), { card, count: 1 });
    }
  }
  return [...groups.values()].slice(0, 25).map(({ card, count }) => ({
    label: truncate(
      count > 1 ? `${card.getName()} (x${count})` : card.getName(),
      100,
    ),
    description: truncate(card.compactDescription || "No description", 100),
    value: card.getName(),
  }));
}

/**
 * Where a Sorry for You countdown is shown: normally a command's reply, but
 * anything that can post a message and then edit it will do.
 */
export interface CountdownDisplay {
  readonly replied: boolean;
  readonly deferred: boolean;
  reply(options: { content: string }): Promise<unknown>;
  editReply(options: { content: string }): Promise<unknown>;
}

/**
 * Opens the Sorry for You window for `target` and counts it down in `display`,
 * usually the command's public reply (posting the reply if needed). Resolves
 * with "stopped" if the target blocks it in time. Returns null if another
 * window is already open.
 */
export async function runSorryForYouWindow(
  display: CountdownDisplay,
  attacker: Player,
  target: Player,
  describe: (secondsLeft: number) => string,
  onOpen?: () => Promise<unknown>,
): Promise<{ outcome: InterruptionOutcome; secondsLeft: number } | null> {
  const durationMs = GameConfig.timings.sorryForYouWindowMs;
  const pending = Game.openInterruptWindow(attacker, target, durationMs);
  if (!pending) return null;

  const startedAt = Date.now();
  let shown = Math.ceil(durationMs / 1000);
  try {
    if (display.replied || display.deferred) {
      await display.editReply({ content: describe(shown) });
    } else {
      await display.reply({ content: describe(shown) });
    }
    await onOpen?.();
  } catch (error) {
    Game.blockInterruption();
    throw error;
  }

  let inFlight: Promise<unknown> = Promise.resolve();
  let editing = false;
  const ticker = setInterval(() => {
    const left = Math.max(
      0,
      Math.ceil((durationMs - (Date.now() - startedAt)) / 1000),
    );
    if (left === shown || editing) return;
    shown = left;
    editing = true;
    inFlight = display
      .editReply({ content: describe(left) })
      .catch(() => undefined)
      .finally(() => {
        editing = false;
      });
  }, 250);

  const outcome = await pending;
  clearInterval(ticker);
  await inFlight; // make sure a late countdown edit can't overwrite the result
  return { outcome, secondsLeft: shown };
}
