/**
 * `/castaways` — who is on your two Survivor Character Cards.
 *
 * Your two Survivor Character Cards are your lives, and each one carries a castaway: somebody
 * you would take to the island. Castaway #1 is on the card turned over the first time you are
 * voted out; castaway #2 is your last life. On the tribe board a castaway who has been voted out
 * is grayed out and stamped, so the board reads as the season does.
 *
 * Three ways in, one engine action (`name_castaways`) behind all of them:
 *
 *   - the **Castaways** button on the lobby card, which opens a form (and joins you, if you had
 *     not joined yet — the same courtesy a colour swatch extends);
 *   - `/castaways` with no options, which opens the same form anywhere in the game;
 *   - `/castaways first:… second:… first_photo:… second_photo:…`, which sets them directly and is
 *     the only way to give a castaway a photo. Names autocomplete from a roster of legends.
 *
 * Nothing here decides a rule. Which names may be printed, that no castaway appears twice at one
 * table, that a castaway already voted out stays who they were — those are the engine's answers,
 * and a refusal comes back as a `GameError` rendered from its code. This file only turns what a
 * player typed into the form the engine accepts (`sanitizeCastawayName`) and fetches photos.
 */

import {
  LabelBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
} from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { preparePortrait } from "../discord/board-image.js";
import { bold, italic, oxford } from "../discord/format.js";
import type {
  AutocompleteContext,
  Command,
  CommandContext,
  ComponentContext,
  ComponentHandler,
  Responder,
} from "../discord/interactions.js";
import type { GameSession } from "../discord/registry.js";
import { UI_INTENT, encodeOrThrow } from "../discord/ui.js";
import {
  CASTAWAY_NAME_MAX_LENGTH,
  LEGENDARY_CASTAWAYS,
  castawayKey,
  sanitizeCastawayName,
} from "../engine/castaways.js";
import type {
  Action,
  DispatchOutcome,
  GameError,
  PlayerId,
  Result,
} from "../engine/types.js";
import type { Logger } from "../logger.js";
import { lobbyPayload } from "./survivor.js";

/** `args[0]` of the form's submit, so it routes here and nowhere else. */
const FLOW = "cst";

/** The slash command's options, one per castaway, in the order the lives are lost. */
const NAME_OPTIONS = ["first", "second"] as const;
const PHOTO_OPTIONS = ["first_photo", "second_photo"] as const;

/** Text inputs on the form, one per castaway. */
const fieldId = (index: number): string => `castaway${index}`;

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const PHOTO_TIMEOUT_MS = 10_000;

const refusal = (code: GameError["code"], message: string): GameError => ({
  code,
  message,
});

// ---------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------

/** This player's castaways as they stand, one entry per card. */
function currentCastaways(
  session: GameSession,
  actor: PlayerId,
  config: SurvivorConfig,
): (string | null)[] {
  const slots = config.engine.limits.characterCardsPerPlayer;
  const mine = session.view().players.find((player) => player.id === actor);
  return Array.from(
    { length: slots },
    (_, index) => mine?.castaways[index]?.name ?? null,
  );
}

/** Castaways other players at this table already have, by `castawayKey`. */
function takenByOthers(session: GameSession, actor: PlayerId): ReadonlySet<string> {
  return new Set(
    session
      .view()
      .players.filter((player) => player.id !== actor)
      .flatMap((player) => player.castaways)
      .flatMap((castaway) =>
        castaway.name === null ? [] : [castawayKey(castaway.name)],
      ),
  );
}

/** Legends matching what has been typed so far: word starts first, then anything containing it. */
export function searchLegends(
  query: string,
  exclude: ReadonlySet<string>,
  limit: number,
): string[] {
  const needle = query.trim().toLowerCase();
  const pool = LEGENDARY_CASTAWAYS.filter((name) => !exclude.has(castawayKey(name)));
  if (needle === "") return pool.slice(0, limit);
  const starts = pool.filter((name) =>
    name
      .toLowerCase()
      .split(/[\s-]+/)
      .some((word) => word.startsWith(needle)),
  );
  const contains = pool.filter(
    (name) => !starts.includes(name) && name.toLowerCase().includes(needle),
  );
  return [...starts, ...contains].slice(0, limit);
}

/** "Your castaways: **A** 📷 and **B**." — what a player is told after any change. */
function describeMine(
  session: GameSession,
  actor: PlayerId,
  config: SurvivorConfig,
): string {
  const names = currentCastaways(session, actor, config).map((name, index) => {
    const text = name === null ? italic("a legend dealt at the start") : bold(name);
    return session.portrait(actor, index) === null ? text : `${text} 📷`;
  });
  return `Your castaways: ${oxford(names)}. Castaway #1 is the first to go if you are voted out.`;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function castawayForm(
  session: GameSession,
  actor: PlayerId,
  config: SurvivorConfig,
): ModalBuilder {
  const inLobby = session.view().status === "lobby";
  const current = currentCastaways(session, actor, config);
  const modal = new ModalBuilder()
    .setCustomId(
      encodeOrThrow(
        { ...session.uiContext(actor), intent: UI_INTENT.Confirm, args: [FLOW] },
        config.discord,
      ),
    )
    .setTitle("Your castaways");

  current.forEach((name, index) => {
    const input = new TextInputBuilder()
      .setCustomId(fieldId(index))
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(CASTAWAY_NAME_MAX_LENGTH)
      .setPlaceholder(
        inLobby
          ? "Leave blank to be dealt a random legend"
          : "Leave blank to keep this one",
      );
    if (name !== null) input.setValue(name);
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel(
          index === 0
            ? "Castaway #1 — the first to be voted out"
            : index === current.length - 1
              ? `Castaway #${index + 1} — your last life`
              : `Castaway #${index + 1}`,
        )
        .setTextInputComponent(input),
    );
  });
  return modal;
}

/** Open the form, or say why it could not be opened. */
async function openForm(
  reply: Responder,
  session: GameSession,
  actor: PlayerId,
  config: SurvivorConfig,
): Promise<void> {
  const shown = await reply.showModal(castawayForm(session, actor, config));
  if (!shown) {
    await reply.fail(
      "I could not open the castaway form. Try `/castaways first:<name> second:<name>` instead.",
    );
  }
}

/** The text typed into each field of a submitted form, in castaway order. */
function formValues(ctx: ComponentContext, slots: number): (string | null)[] {
  const interaction = ctx.interaction;
  return Array.from({ length: slots }, (_, index) => {
    if (!interaction.isModalSubmit()) return ctx.values[index] ?? null;
    try {
      return interaction.fields.getTextInputValue(fieldId(index));
    } catch {
      return ctx.values[index] ?? null;
    }
  });
}

// ---------------------------------------------------------------------------
// Turning what was typed into what the engine accepts
// ---------------------------------------------------------------------------

type Names =
  | { readonly ok: true; readonly names: (string | null)[] }
  | {
      readonly ok: false;
      readonly error: GameError;
    };

/**
 * Each typed name, cleaned; `null` for "not given". A field the cleaning empties — a name made
 * entirely of emoji, say — is refused rather than quietly treated as blank, because the player
 * clearly meant somebody.
 */
function cleaned(typed: readonly (string | null)[]): Names {
  const names: (string | null)[] = [];
  for (const raw of typed) {
    if (raw === null || raw.trim() === "") {
      names.push(null);
      continue;
    }
    const name = sanitizeCastawayName(raw);
    if (name === "") {
      return {
        ok: false,
        error: refusal(
          "castaway_name_invalid",
          "nothing printable was left of that name",
        ),
      };
    }
    names.push(name);
  }
  return { ok: true, names };
}

/**
 * The whole list to send to the engine: what was given, and for everything that was not — in
 * the lobby, a blank from the form means "deal me a legend"; anywhere else, it means "keep
 * this one".
 */
function merged(
  current: readonly (string | null)[],
  given: readonly (string | null)[],
  blankMeansRandom: boolean,
): (string | null)[] {
  return current.map((name, index) => {
    const next = given[index] ?? null;
    if (next !== null) return next;
    return blankMeansRandom ? null : name;
  });
}

/** Seat the presser if they are not at the fire yet — only ever in a lobby. */
function ensureSeated(
  session: GameSession,
  actor: PlayerId,
  displayName: string,
  dispatch: (action: Action) => Result<DispatchOutcome>,
): GameError | null {
  if (session.hasPlayer(actor)) return null;
  if (session.view().status !== "lobby") {
    return refusal("not_in_game", "only the players at this table have castaways");
  }
  const joined = dispatch({ type: "join_game", actor, displayName });
  return joined.ok ? null : joined.error;
}

/** A castaway whose name changed does not keep the old castaway's photo. */
async function dropStalePortraits(
  session: GameSession,
  actor: PlayerId,
  before: readonly (string | null)[],
  after: readonly (string | null)[],
  keep: ReadonlySet<number>,
): Promise<void> {
  for (const [index, name] of after.entries()) {
    if (name !== before[index] && !keep.has(index)) {
      await session.setPortrait(actor, index, null);
    }
  }
}

/** Re-render the lobby card, wherever it is, after a change made from somewhere else. */
async function refreshLobbyCard(
  session: GameSession,
  config: SurvivorConfig,
  nowMs: number,
  log: Logger,
): Promise<void> {
  const card = session.lobbyCard;
  if (card === null || session.view().status !== "lobby") return;
  const payload = lobbyPayload(session, config, nowMs);
  try {
    await card.edit({
      embeds: payload.embeds ? [...payload.embeds] : [],
      components: payload.components ? [...payload.components] : [],
    });
  } catch (cause) {
    log.debug("could not re-render the lobby card", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

type Photo =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly message: string;
    };

/**
 * Fetch an uploaded photo NOW — Discord's attachment links expire — and make it a portrait.
 * Every failure is a sentence the player can act on; none of them reaches the game.
 */
async function fetchPhoto(attachment: Attachment, log: Logger): Promise<Photo> {
  const name = attachment.name;
  const type = attachment.contentType ?? "";
  if (!PHOTO_TYPES.some((allowed) => type.startsWith(allowed))) {
    return {
      ok: false,
      message: `${bold(name)} is not a PNG, JPEG, WebP or GIF image.`,
    };
  }
  if (attachment.size > MAX_PHOTO_BYTES) {
    return { ok: false, message: `${bold(name)} is too big — 8 MB at most.` };
  }
  let bytes: Buffer;
  try {
    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
    });
    if (!response.ok)
      return { ok: false, message: `I could not download ${bold(name)}.` };
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    log.debug("photo download failed", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return { ok: false, message: `I could not download ${bold(name)}.` };
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    return { ok: false, message: `${bold(name)} is too big — 8 MB at most.` };
  }
  const portrait = await preparePortrait(bytes, log);
  if (portrait.ok) return { ok: true, bytes: portrait.bytes };
  switch (portrait.reason) {
    case "renderer_unavailable":
      return {
        ok: false,
        message:
          "This bot cannot draw the tribe board on this server, so photos are switched off. Names still work.",
      };
    case "too_large":
      return {
        ok: false,
        message: `${bold(name)} is too large an image — 24 megapixels at most.`,
      };
    case "not_an_image":
      return { ok: false, message: `${bold(name)} could not be read as an image.` };
    default:
      return { ok: false, message: `${bold(name)} could not be used.` };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** The lobby card's **Castaways** button. */
const pressCastaways: ComponentHandler = async (ctx) => {
  await openForm(ctx.reply, ctx.session, ctx.actor, ctx.config);
};

/** The form, submitted — from the lobby card or from `/castaways`. */
const submitForm: ComponentHandler = async (ctx) => {
  const session = ctx.session;
  const slots = ctx.config.engine.limits.characterCardsPerPlayer;
  const typed = cleaned(formValues(ctx, slots));
  if (!typed.ok) {
    await ctx.reply.fail(typed.error);
    return;
  }

  const seated = ensureSeated(session, ctx.actor, ctx.displayName(), (action) =>
    ctx.dispatch(action),
  );
  if (seated !== null) {
    await ctx.reply.fail(seated);
    return;
  }

  const inLobby = session.view().status === "lobby";
  const before = currentCastaways(session, ctx.actor, ctx.config);
  const after = merged(before, typed.names, inLobby);
  const outcome = ctx.dispatch({
    type: "name_castaways",
    actor: ctx.actor,
    castaways: after,
  });
  if (!outcome.ok) {
    await ctx.reply.fail(outcome.error);
    return;
  }
  await dropStalePortraits(session, ctx.actor, before, after, new Set());

  // Opened from the lobby card: re-render the card itself, which acknowledges the form.
  const fromLobbyCard =
    inLobby && ctx.interaction.isModalSubmit() && ctx.interaction.isFromMessage();
  if (fromLobbyCard) {
    await ctx.reply.update(lobbyPayload(session, ctx.config, ctx.nowMs));
    return;
  }
  if (inLobby) await refreshLobbyCard(session, ctx.config, ctx.nowMs, ctx.log);
  await ctx.reply.send({ content: describeMine(session, ctx.actor, ctx.config) });
};

async function execute(ctx: CommandContext): Promise<void> {
  const found = ctx.requireSession();
  if (!found.ok) return ctx.reply.fail(found.error);
  const session = found.value;
  const options = ctx.interaction.options;

  const typedNames = NAME_OPTIONS.map((option) => options.getString(option));
  const photos = PHOTO_OPTIONS.map((option) => options.getAttachment(option));

  // Nothing given: the form, prefilled with what you have. It must be the FIRST answer, so it
  // goes before anything that could be slow.
  if (
    typedNames.every((name) => name === null) &&
    photos.every((photo) => photo === null)
  ) {
    if (!session.hasPlayer(ctx.actor) && session.view().status !== "lobby") {
      return ctx.reply.fail(
        refusal("not_in_game", "only the players at this table have castaways"),
      );
    }
    await openForm(ctx.reply, session, ctx.actor, ctx.config);
    return;
  }

  const typed = cleaned(typedNames);
  if (!typed.ok) return ctx.reply.fail(typed.error);

  const seated = ensureSeated(session, ctx.actor, ctx.displayName(), (action) =>
    ctx.dispatch(session, action),
  );
  if (seated !== null) return ctx.reply.fail(seated);

  const before = currentCastaways(session, ctx.actor, ctx.config);
  // Options left out keep what is there: typing only `second:` does not re-roll the first.
  const after = merged(before, typed.names, false);

  // Every photo is fetched and checked BEFORE anything changes, so one bad upload cannot leave
  // the names changed and the photos half-applied.
  const portraits = new Map<number, Buffer>();
  for (const [index, attachment] of photos.entries()) {
    if (attachment === null) continue;
    if (after[index] === null || after[index] === undefined) {
      return ctx.reply.fail(
        `Give castaway #${index + 1} a name too, so the photo has somebody to belong to.`,
      );
    }
    const photo = await fetchPhoto(attachment, ctx.log);
    if (!photo.ok) return ctx.reply.fail(photo.message);
    portraits.set(index, photo.bytes);
  }

  const outcome = ctx.dispatch(session, {
    type: "name_castaways",
    actor: ctx.actor,
    castaways: after,
  });
  if (!outcome.ok) return ctx.reply.fail(outcome.error);

  let unsaved = false;
  for (const [index, bytes] of portraits) {
    if (!(await session.setPortrait(ctx.actor, index, bytes))) unsaved = true;
  }
  await dropStalePortraits(
    session,
    ctx.actor,
    before,
    after,
    new Set(portraits.keys()),
  );
  await refreshLobbyCard(session, ctx.config, ctx.nowMs, ctx.log);

  await ctx.reply.send({
    content: [
      describeMine(session, ctx.actor, ctx.config),
      unsaved
        ? "The photo is on the board, but I could not save it — it will not survive a restart."
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  });
}

/** Legends as you type, minus the ones taken; what you typed first if it is somebody new. */
async function autocomplete(ctx: AutocompleteContext): Promise<void> {
  const channelId = ctx.interaction.channelId;
  const session = channelId === null ? null : ctx.registry.get(channelId);
  const exclude =
    session === null ? new Set<string>() : takenByOthers(session, ctx.actor);
  const limit = ctx.config.discord.maxSelectMenuOptions;
  const suggestions = searchLegends(ctx.focused.value, exclude, limit);
  const typed = sanitizeCastawayName(ctx.focused.value);
  const choices =
    typed !== "" &&
    !exclude.has(castawayKey(typed)) &&
    !suggestions.some((name) => castawayKey(name) === castawayKey(typed))
      ? [typed, ...suggestions.slice(0, limit - 1)]
      : suggestions;
  await ctx.respond(choices.map((name) => ({ name, value: name })));
}

const castaways: Command = {
  data: new SlashCommandBuilder()
    .setName("castaways")
    .setDescription(
      "Pick the two castaways who are your lives — or run it bare to open the form.",
    )
    .addStringOption((option) =>
      option
        .setName("first")
        .setDescription("Castaway #1: the first to be voted out")
        .setAutocomplete(true)
        .setMaxLength(CASTAWAY_NAME_MAX_LENGTH),
    )
    .addStringOption((option) =>
      option
        .setName("second")
        .setDescription("Castaway #2: your last life")
        .setAutocomplete(true)
        .setMaxLength(CASTAWAY_NAME_MAX_LENGTH),
    )
    .addAttachmentOption((option) =>
      option
        .setName("first_photo")
        .setDescription("A photo for castaway #1 (optional)"),
    )
    .addAttachmentOption((option) =>
      option
        .setName("second_photo")
        .setDescription("A photo for castaway #2 (optional)"),
    ),

  execute,
  autocomplete,

  components: {
    name_castaways: pressCastaways,
    [`${UI_INTENT.Confirm}:${FLOW}`]: submitForm,
  },
};

export default castaways;
