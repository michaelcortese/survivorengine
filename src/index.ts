/**
 * Bootstrap. The only file that owns a process, a filesystem path or an environment variable.
 *
 * Five audit findings live and die here, and each one is a named function below:
 *
 *   #57/#61/#103  THE LOADER. The old loader filtered directory entries for `.ts`, so a
 *                 compiled build registered ZERO commands and the bot came up looking perfectly
 *                 healthy with every command dead. `loadModules()` accepts every extension Node
 *                 can execute and REPORTS what it found, so "no commands" is a startup failure
 *                 with a line number rather than a mystery in production.
 *   #41/#43       PROCESS RESILIENCE. There was no `unhandledRejection` or `uncaughtException`
 *                 handler at all, so one dead webhook killed the bot and every game on it.
 *                 Both are installed BEFORE login, both log, both flush snapshots synchronously,
 *                 and neither exits: a game that is fine must not die because a message failed.
 *   #60           FLUSH ON EXIT. Autosave is debounced, so up to `debounceInterval` of committed
 *                 state is unwritten at any instant. SIGINT and SIGTERM drain it before exiting.
 *   #95           CONFIG. Every duration and limit comes from `config.ts`; a typo in a
 *                 deployment variable fails at startup instead of wedging a council at 1am.
 *   #37/#74       BOOT CHECKS. The card catalog and the custom_id intent codes are verified
 *                 before login, because a duplicated action code silently routes one card's
 *                 button into another card's handler.
 *
 * `main()` runs only when this file is the process entry point, so `deploy-commands.ts` can
 * import `loadCommands()` — one loader, one place for the `.ts`/`.js` bug to not exist — without
 * starting a bot.
 */

import "dotenv/config";

import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client, Events, GatewayIntentBits } from "discord.js";

import {
  config,
  validateConfig,
  type Environment,
  type SurvivorConfig,
} from "./config.js";
import { validateCatalog } from "./engine/cards.js";
import {
  collectWindowPrompts,
  type BotContext,
  type Command,
  type ComponentHandler,
  type EventModule,
} from "./discord/interactions.js";
import { SessionRegistry, type WindowPrompter } from "./discord/registry.js";
import type { PendingKind } from "./engine/types.js";
import { assertIntentCodesAreDisjoint } from "./discord/ui.js";
import { createLogger, describeCause, type Logger } from "./logger.js";
import { PortraitStore } from "./persistence/portraits.js";
import { SaveStore } from "./persistence/store.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * The variables the bot cannot run without, and the ones it merely likes.
 *
 * The canonical names come from `config.discord` so there is one spelling of each. The legacy
 * names are the ones in the repository's own `.env.example` from before the rewrite; accepting
 * both means an existing deployment does not silently fail to start, and the error message
 * below names BOTH so nobody has to guess which one this build wants.
 */
export interface Secrets {
  readonly token: string;
  readonly clientId: string;
  /** Set for instant, development-speed command registration in one server. */
  readonly guildId: string | null;
}

const LEGACY_NAMES: Readonly<Record<"token" | "clientId" | "guildId", string>> = {
  token: "TOKEN",
  clientId: "CLIENT_ID",
  guildId: "GUILD_ID",
};

function readVar(env: Environment, primary: string, legacy: string): string | null {
  const value = env[primary]?.trim() ?? env[legacy]?.trim() ?? "";
  return value === "" ? null : value;
}

/**
 * Read the secrets, or say exactly which ones are missing.
 *
 * A `Result`-shaped return rather than a throw so the caller can print every missing variable at
 * once. Nothing here is ever logged: a token in a log line is a token on a screen share.
 */
export function readSecrets(
  env: Environment,
  settings: SurvivorConfig,
):
  | { readonly ok: true; readonly secrets: Secrets }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const discord = settings.discord;
  const token = readVar(env, discord.tokenEnvVar, LEGACY_NAMES.token);
  const clientId = readVar(env, discord.clientIdEnvVar, LEGACY_NAMES.clientId);
  const guildId = readVar(env, discord.devGuildIdEnvVar, LEGACY_NAMES.guildId);

  const missing: string[] = [];
  if (token === null) missing.push(`${discord.tokenEnvVar} (or ${LEGACY_NAMES.token})`);
  if (clientId === null)
    missing.push(`${discord.clientIdEnvVar} (or ${LEGACY_NAMES.clientId})`);
  if (token === null || clientId === null) return { ok: false, missing };

  return { ok: true, secrets: { token, clientId, guildId } };
}

// ---------------------------------------------------------------------------
// The module loader
// ---------------------------------------------------------------------------

/**
 * Every extension Node will execute, plus the TypeScript ones `tsx` adds.
 *
 * THE audit #103 bug, in one constant: the old loader hardcoded `.ts`, so `npm run build &&
 * node dist/index.js` registered nothing and reported nothing. A loader that names both worlds
 * cannot be right in development and silently wrong in production.
 */
const MODULE_EXTENSIONS: readonly string[] = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
];

/** Declaration files, source maps and tests are not modules to load. */
function isLoadable(fileName: string): boolean {
  if (
    fileName.endsWith(".d.ts") ||
    fileName.endsWith(".d.mts") ||
    fileName.endsWith(".d.cts")
  ) {
    return false;
  }
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(fileName)) return false;
  return MODULE_EXTENSIONS.includes(extname(fileName));
}

/**
 * Every module file under `directory`, recursively, de-duplicated by base name.
 *
 * The de-duplication matters when a build has been emitted next to its source (`x.ts` and `x.js`
 * side by side): loading both would register the same command twice and, worse, register the
 * stale one second. The tie is broken in favour of the extension THIS file is running as, which
 * is the one the runtime can definitely execute.
 */
async function findModules(
  directory: string,
  preferred: string,
): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return []; // A missing directory is "no modules", not a crash.
  }

  const byBaseName = new Map<string, string>();
  const nested: Promise<readonly string[]>[] = [];

  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      nested.push(findModules(full, preferred));
      continue;
    }
    if (!entry.isFile() || !isLoadable(entry.name)) continue;

    const extension = extname(entry.name);
    const base = join(directory, entry.name.slice(0, -extension.length));
    const existing = byBaseName.get(base);
    if (existing === undefined || extension === preferred) byBaseName.set(base, full);
  }

  const here = [...byBaseName.values()].sort();
  const deeper = (await Promise.all(nested)).flat();
  return [...here, ...deeper];
}

/** Import a path as an ES module. The `as` is what keeps `any` out of the rest of the file. */
async function importModule(path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { data?: unknown; execute?: unknown };
  if (typeof candidate.execute !== "function") return false;
  const data = candidate.data as { name?: unknown; toJSON?: unknown } | undefined;
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.name === "string" &&
    typeof data.toJSON === "function"
  );
}

function isEventModule(value: unknown): value is EventModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; execute?: unknown };
  return typeof candidate.name === "string" && typeof candidate.execute === "function";
}

export interface LoadedCommands {
  readonly commands: ReadonlyMap<string, Command>;
  /** Component route key -> handler. See `ComponentRoutes` in `discord/interactions.ts`. */
  readonly components: ReadonlyMap<string, ComponentHandler>;
  /** Every command's window prompts, merged. See `Command.prompts`. */
  readonly prompter: WindowPrompter;
  /** Anything that stops the bot being correct. Non-empty means do not start. */
  readonly problems: readonly string[];
}

/**
 * Every kind of window the engine can open. `config.ts` keys a timing by each one, and
 * `PendingWindowsCoverEveryPendingKind` in `engine/types.ts` fails to compile if the two lists
 * ever drift — so this is the whole list, at runtime, without a third copy of it.
 */
const PENDING_KINDS = Object.keys(
  config.engine.timings.pendingWindows,
) as PendingKind[];

/**
 * Load `<baseDir>/commands/**`.
 *
 * Shared with `deploy-commands.ts` on purpose: registering a command with Discord and having a
 * handler for it are the same list, and the one way to guarantee that is one function.
 *
 * A duplicate command name or a duplicate component route key is a PROBLEM, not a warning. Two
 * commands claiming one component key is audit #37 (two things sharing an identifier and one of
 * them silently winning) and it is far cheaper to fail at boot than to debug at a council. So is
 * a kind of window with no prompt, or with two (`collectWindowPrompts`).
 */
export async function loadCommands(
  baseDir: string,
  log: Logger,
): Promise<LoadedCommands> {
  const commands = new Map<string, Command>();
  const components = new Map<string, ComponentHandler>();
  const problems: string[] = [];
  const owners = new Map<string, string>();

  const preferred = extname(fileURLToPath(import.meta.url));
  const files = await findModules(join(baseDir, "commands"), preferred);

  for (const file of files) {
    let module: Record<string, unknown>;
    try {
      module = await importModule(file);
    } catch (cause) {
      problems.push(`${file}: could not be imported (${describeCause(cause)})`);
      continue;
    }

    const exported = module["default"];
    if (!isCommand(exported)) {
      problems.push(`${file}: does not default-export a Command { data, execute }`);
      continue;
    }

    const name = exported.data.name;
    if (commands.has(name)) {
      problems.push(`${file}: /${name} is already defined by another file`);
      continue;
    }
    commands.set(name, exported);

    for (const [key, handler] of Object.entries(exported.components ?? {})) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        problems.push(
          `${file}: component route "${key}" is already claimed by /${owner}. Add a flow tag (args[0]) so the two are distinguishable.`,
        );
        continue;
      }
      owners.set(key, name);
      components.set(key, handler);
    }

    log.debug("command loaded", {
      command: name,
      routes: Object.keys(exported.components ?? {}).length,
    });
  }

  if (commands.size === 0) {
    problems.push(
      `no commands were found under ${join(baseDir, "commands")} — a build that registers zero commands is audit #103, so this is fatal rather than a warning`,
    );
  }
  const prompts = collectWindowPrompts(commands.values(), PENDING_KINDS);
  problems.push(...prompts.problems);
  return { commands, components, prompter: prompts.prompter, problems };
}

export interface LoadedEvents {
  readonly events: readonly EventModule[];
  readonly problems: readonly string[];
}

/** Load `<baseDir>/events/**`. Same rules, same reporting. */
export async function loadEvents(baseDir: string, log: Logger): Promise<LoadedEvents> {
  const events: EventModule[] = [];
  const problems: string[] = [];

  const preferred = extname(fileURLToPath(import.meta.url));
  for (const file of await findModules(join(baseDir, "events"), preferred)) {
    let module: Record<string, unknown>;
    try {
      module = await importModule(file);
    } catch (cause) {
      problems.push(`${file}: could not be imported (${describeCause(cause)})`);
      continue;
    }
    const exported = module["default"];
    if (!isEventModule(exported)) {
      problems.push(
        `${file}: does not default-export an EventModule { name, execute }`,
      );
      continue;
    }
    events.push(exported);
    log.debug("event loaded", { event: exported.name, once: exported.once === true });
  }

  if (events.length === 0)
    problems.push(`no events were found under ${join(baseDir, "events")}`);
  return { events, problems };
}

// ---------------------------------------------------------------------------
// Wiring events to the client
// ---------------------------------------------------------------------------

/**
 * discord.js types each event's arguments precisely, and a loader necessarily holds a list of
 * modules for DIFFERENT events. The adaptation is done once, here, so that an event module can
 * still be written with exact types (`EventModule<Events.InteractionCreate>`) and never has to
 * think about this.
 */
interface LooseEmitter {
  on(name: string, listener: (...args: readonly unknown[]) => void): void;
  once(name: string, listener: (...args: readonly unknown[]) => void): void;
}

type LooseExecute = (bot: BotContext, ...args: readonly unknown[]) => Promise<void>;

function registerEvents(
  client: Client,
  bot: BotContext,
  events: readonly EventModule[],
): void {
  const emitter = client as unknown as LooseEmitter;

  for (const module of events) {
    const run: LooseExecute = module.execute.bind(module) as LooseExecute;
    const listener = (...args: readonly unknown[]): void => {
      // Every handler is already total, but an event listener is the one place a rejected
      // promise has nowhere to go, so it is caught here as well (audit #22/#46).
      run(bot, ...args).catch((cause: unknown) => {
        bot.log.error("event handler rejected", cause, { event: String(module.name) });
      });
    };

    if (module.once === true) emitter.once(module.name, listener);
    else emitter.on(module.name, listener);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Everything that must be true before the bot is allowed to accept a click. */
function preflight(settings: SurvivorConfig): readonly string[] {
  return [
    ...validateConfig(settings),
    ...validateCatalog(),
    ...assertIntentCodesAreDisjoint(),
  ];
}

async function main(): Promise<void> {
  const log = createLogger(config.discord.logLevel, { app: "survivor" });

  const problems = preflight(config);
  if (problems.length > 0) {
    for (const problem of problems)
      log.error("startup check failed", undefined, { problem });
    process.exit(1);
  }

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

  const store = new SaveStore({ config: config.autosave, logger: log });
  const client = new Client({
    // Slash commands and components arrive over the interactions gateway; `Guilds` is what puts
    // channels in the cache so a restored game can find its channel. No message-content intent:
    // the bot never reads a message a player wrote.
    intents: [GatewayIntentBits.Guilds],
  });

  const baseDir = dirname(fileURLToPath(import.meta.url));
  const loadedCommands = await loadCommands(baseDir, log);
  const loadedEvents = await loadEvents(baseDir, log);
  const loadProblems = [...loadedCommands.problems, ...loadedEvents.problems];
  if (loadProblems.length > 0) {
    for (const problem of loadProblems)
      log.error("could not load a module", undefined, { problem });
    process.exit(1);
  }

  // After the commands, because the sessions post the prompts the commands declare.
  const registry = new SessionRegistry({
    config,
    store,
    logger: log,
    client,
    prompter: loadedCommands.prompter,
    portraits: new PortraitStore({ config: config.autosave, logger: log }),
  });

  const bot: BotContext = {
    client,
    config,
    registry,
    store,
    log,
    commands: loadedCommands.commands,
    components: loadedCommands.components,
  };

  registerEvents(client, bot, loadedEvents.events);
  installProcessHandlers(bot);

  // An EventEmitter that emits `error` with no listener THROWS, which is one of the ways a
  // single failed request used to take the whole process with it.
  client.on(Events.Error, (cause: Error) => {
    log.error("discord client error", cause);
  });
  client.on(Events.Warn, (message: string) => {
    log.warn("discord client warning", { message });
  });

  log.info("logging in", {
    commands: loadedCommands.commands.size,
    events: loadedEvents.events.length,
    saves: store.directory,
  });

  try {
    await client.login(secrets.secrets.token);
  } catch (cause) {
    // A bot that cannot log in must not sit there looking healthy to a supervisor
    // (ARCHITECTURE.md §9).
    log.error("login failed", cause);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Process-level resilience
// ---------------------------------------------------------------------------

function installProcessHandlers(bot: BotContext): void {
  const { log, store, registry, client } = bot;

  /**
   * Neither of these exits.
   *
   * Audit #41/#43: one dead webhook killed the bot AND every unrelated game on it. The engine is
   * pure and its state is immutable, so a throw in a renderer or a transport cannot have left a
   * game half-mutated — the blast radius really is one message. Snapshots are flushed
   * SYNCHRONOUSLY anyway, so that if the process does go down next, nothing is lost.
   */
  process.on("unhandledRejection", (reason: unknown) => {
    log.error("unhandled rejection", reason, { flushed: store.flushAllSync() });
  });

  process.on("uncaughtException", (cause: Error) => {
    log.error("uncaught exception", cause, { flushed: store.flushAllSync() });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return; // A second Ctrl-C must not race the first one's flush.
    shuttingDown = true;
    log.info("shutting down", { signal, games: registry.size });

    // `disposeAll` flushes each game's save and drains its render queue, so a message already
    // on its way out still goes out. It does NOT end the games: `/survivor resume` brings each
    // one back exactly where it was (audit #27/#60).
    //
    // `flushAll` reports how many games did NOT reach the disk. A shutdown that lost a council
    // must not print "goodbye" and exit 0: the operator would never know, and the next
    // `/survivor resume` would silently restore a game from before the last Tribal Council.
    let lost = 0;
    void registry
      .disposeAll()
      .then(() => store.flushAll())
      .then((failed) => {
        lost = failed;
        // Anything a failed write put back in the queue gets one synchronous retry, which is
        // the path that survives an event loop about to stop turning.
        if (failed > 0 || store.hasPendingWrites) {
          const written = store.flushAllSync();
          log.error("some saves did not reach the disk on the first pass", undefined, {
            failed,
            rewrittenSynchronously: written,
          });
          if (!store.hasPendingWrites) lost = 0;
        }
      })
      .catch((cause: unknown) => {
        log.error("could not flush cleanly on shutdown", cause);
        // Last resort: the synchronous path cannot be interrupted by the event loop dying.
        store.flushAllSync();
        lost = store.hasPendingWrites ? 1 : 0;
      })
      .finally(() => {
        void client.destroy().finally(() => {
          if (lost > 0) {
            log.error("shut down with unsaved games", undefined, { games: lost });
            process.exit(1);
          }
          log.info("goodbye");
          process.exit(0);
        });
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Only run the bot when this file IS the process. `deploy-commands.ts` imports `loadCommands`
 * from here so that there is exactly one loader in the codebase, and importing it must not
 * start a Discord client.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void main().catch((cause: unknown) => {
    console.error("survivor: failed to start", cause);
    process.exit(1);
  });
}
