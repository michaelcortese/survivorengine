/**
 * The one logger.
 *
 * Audit #41/#43 (both HIGH): "there was no logging or ops story at all" — a dead webhook killed
 * the process and nothing said why. ARCHITECTURE.md §9 asks for structured logs keyed by event
 * `type` and `seq`, at a level set by `config.discord.logLevel`, so a bug report can be replayed
 * from the `seed` echoed in `game_started`.
 *
 * Deliberately tiny and dependency-free: it is imported by every file in the Discord layer, so
 * it must never be able to fail. `child()` binds context (game id, channel, actor) once instead
 * of threading it through forty call sites.
 *
 * NOTE on `console`: eslint's `no-console` allows exactly `info`/`warn`/`error`, so `debug`
 * writes through `console.info` with a level tag rather than through `console.debug`.
 */

import type { LogLevel } from "./config.js";

/** Values a structured field may hold. Never an object: logs must stay one line and greppable. */
export type LogFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  /** `cause` is `unknown` because a `catch` binding is: never assume it is an Error. */
  error(message: string, cause?: unknown, fields?: LogFields): void;
  /** A logger with these fields merged into every line it writes. */
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** `Error` is the common case; a thrown string or a DiscordAPIError-shaped object is not. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const code =
      "code" in cause &&
      (typeof cause.code === "string" || typeof cause.code === "number")
        ? ` code=${String(cause.code)}`
        : "";
    return `${cause.name}: ${cause.message}${code}`;
  }
  if (typeof cause === "string") return cause;
  if (cause === undefined) return "";
  try {
    return JSON.stringify(cause) ?? describeByType(cause);
  } catch {
    // A cycle, a BigInt, or a `toJSON` that threw. The type name still beats nothing.
    return describeByType(cause);
  }
}

/**
 * Last-resort description of a value that is not an Error, not a string and did not serialise.
 *
 * Deliberately NOT `String(cause)`: an object with no `toString` renders as the useless
 * `[object Object]`, which is exactly the log line audit #41 complained about. Every branch here
 * produces something a reader can act on, and none of them can throw.
 */
function describeByType(cause: unknown): string {
  if (cause === null) return "null";
  switch (typeof cause) {
    case "string":
      return cause;
    case "undefined":
      return "";
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return cause.toString();
    case "function":
      return cause.name === "" ? "[function]" : `[function ${cause.name}]`;
    case "object":
    default:
      return Object.prototype.toString.call(cause);
  }
}

function renderFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : String(value);
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function createLogger(level: LogLevel, base: LogFields = {}): Logger {
  const threshold = LEVEL_RANK[level];

  const write = (at: LogLevel, message: string, fields: LogFields): void => {
    if (LEVEL_RANK[at] < threshold) return;
    const line = `${new Date().toISOString()} ${at.toUpperCase().padEnd(5)} ${message}${renderFields({ ...base, ...fields })}`;
    if (at === "error") console.error(line);
    else if (at === "warn") console.warn(line);
    else console.info(line);
  };

  return {
    debug: (message, fields = {}) => write("debug", message, fields),
    info: (message, fields = {}) => write("info", message, fields),
    warn: (message, fields = {}) => write("warn", message, fields),
    error: (message, cause, fields = {}) => {
      const described = describeCause(cause);
      write(
        "error",
        message,
        described === "" ? fields : { ...fields, cause: described },
      );
      if (
        cause instanceof Error &&
        cause.stack !== undefined &&
        threshold <= LEVEL_RANK.debug
      ) {
        console.error(cause.stack);
      }
    },
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
