/**
 * Register the slash commands with Discord.
 *
 * Two audiences, one list:
 *
 *   GUILD (when GUILD_ID is set)  — instant. Discord applies a guild command the moment this
 *                                   returns, which is the only sane way to iterate on a command
 *                                   surface. Development.
 *   GLOBAL (otherwise)            — up to an hour to propagate to every server. Production.
 *
 * The command list comes from `loadCommands()` in `src/index.ts` rather than from a second
 * scan of the directory. That is deliberate: registering a command with Discord and having a
 * handler for it are the same list, and audit #103 — a loader that filtered for `.ts`, so a
 * compiled build registered zero commands — is exactly what happens when they are two lists
 * that only look alike. Importing `index.ts` does NOT start a bot; `main()` runs only when that
 * file is the process entry point.
 *
 * Exits non-zero on any failure, so `npm run deploy` in CI fails the pipeline instead of
 * printing a stack trace and returning 0.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { loadCommands, readSecrets } from "./index.js";

async function deploy(): Promise<void> {
  const log = createLogger(config.discord.logLevel, {
    app: "survivor",
    tool: "deploy",
  });

  const secrets = readSecrets(process.env, config);
  if (!secrets.ok) {
    log.error("missing required environment variables", undefined, {
      missing: secrets.missing.join(", "),
    });
    console.error(
      `\nSet these in .env (see .env.example):\n${secrets.missing.map((name) => `  ${name}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  const { token, clientId, guildId } = secrets.secrets;

  // `src/deploy-commands.ts` and `src/commands/` are siblings under tsx; `dist/deploy-commands.js`
  // and `dist/commands/` are siblings after a build. One expression covers both.
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const loaded = await loadCommands(baseDir, log);
  if (loaded.problems.length > 0) {
    for (const problem of loaded.problems)
      log.error("could not load a command", undefined, { problem });
    process.exit(1);
  }

  const body: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [];
  for (const command of loaded.commands.values()) {
    try {
      body.push(command.data.toJSON());
    } catch (cause) {
      // A builder throws on an invalid name, an over-length description, too many options. Say
      // which command, or the operator is left bisecting the directory by hand.
      log.error("command definition is invalid", cause, { command: command.data.name });
      process.exit(1);
    }
  }

  const route =
    guildId === null
      ? Routes.applicationCommands(clientId)
      : Routes.applicationGuildCommands(clientId, guildId);
  const scope = guildId === null ? "globally" : `to guild ${guildId}`;

  const rest = new REST().setToken(token);

  console.info(`Registering ${body.length} command(s) ${scope}:`);
  for (const command of body)
    console.info(`  /${command.name} — ${command.description}`);

  try {
    // PUT, not POST: the full set replaces whatever was there, so a command deleted from the
    // repository disappears from Discord instead of lingering as a dead entry that answers
    // "The application did not respond" (audit #42) for the rest of its life.
    const registered = (await rest.put(route, { body })) as readonly unknown[];
    console.info(
      `\nRegistered ${registered.length} command(s) ${scope}.${
        guildId === null
          ? " Global commands can take up to an hour to appear; set GUILD_ID for instant updates while developing."
          : " Guild commands are live immediately."
      }`,
    );
  } catch (cause) {
    log.error("could not register commands", cause, { scope });
    console.error(
      "\nCheck that the token belongs to the application named by CLIENT_ID, and that the bot was invited with the applications.commands scope.\n",
    );
    process.exit(1);
  }
}

await deploy();
