/**
 * The bot is connected. Put the games back.
 *
 * Audit #60 and #27 together: the old bot saved only in `/end_turn`, and nothing ever read a
 * save back, so a restart — a deploy, a crash, a dyno cycling — silently ended every game in
 * progress with no announcement and no way to recover. Restoring is not a feature here, it is
 * the other half of autosaving; a save nobody loads is a log file.
 *
 * Everything in this file is REPORTED. A restore that half worked and said nothing is worse
 * than one that failed loudly: the channel would look like a live game and behave like an empty
 * one. So the boot line names how many came back, and every save that did not is named with the
 * reason it did not.
 *
 * The channel is NOT told "your game is back". The registry re-arms the game's timer and the
 * next command renders the current board; announcing into a channel that may have moved on
 * hours ago is noise. `/status` is one keystroke.
 */

import { Events, type Client } from "discord.js";

import type { BotContext, EventModule } from "../discord/interactions.js";

const ready: EventModule<Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,

  async execute(bot: BotContext, client: Client<true>): Promise<void> {
    const log = bot.log.child({ component: "ready" });

    log.info("logged in", {
      user: client.user.tag,
      id: client.user.id,
      guilds: client.guilds.cache.size,
      commands: bot.commands.size,
      componentRoutes: bot.components.size,
    });

    if (!bot.store.enabled) {
      log.warn("autosave is disabled: a restart will lose every game in progress", {
        directory: bot.store.directory,
      });
      return;
    }

    log.info("restoring saved games", { directory: bot.store.directory });

    // `restoreAll` fetches each save's channel, refuses anything already finished or abandoned,
    // and KEEPS a save whose channel it could not fetch — a channel that is momentarily
    // unavailable must not cost a game (see `SessionRegistry.restoreAll`).
    const report = await bot.registry.restoreAll();

    for (const gameId of report.restored) {
      log.info("game restored", { gameId });
    }
    for (const skipped of report.skipped) {
      // `channel_unavailable` is the ordinary case — the bot was removed from a server, or the
      // channel was deleted — and the save is deliberately left on disk. Anything else is a
      // real problem with a real file, and the code says which.
      log.warn("save not restored", { gameId: skipped.gameId, reason: skipped.reason });
    }

    log.info("ready", {
      restored: report.restored.length,
      skipped: report.skipped.length,
      live: bot.registry.size,
    });
  },
};

export default ready;
