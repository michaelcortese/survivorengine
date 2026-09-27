import {
  Attachment,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Game } from "../../game/game";
import {
  CASTAWAY_NAME_MAX_LENGTH,
  sanitizeCastawayName,
  searchLegendaryCastaways,
} from "../../game/castaways";
import { canDecodeImage } from "../../render/board_image";
import { buildBoardMessage } from "../../game/board";
import { replyEphemeral, userInfo } from "../../util/discord";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const SLOTS = ["first", "second"] as const;

/** Downloads an uploaded photo now, because Discord attachment links expire. */
async function downloadPhoto(attachment: Attachment): Promise<Buffer | string> {
  const type = attachment.contentType ?? "";
  if (!PHOTO_TYPES.some((allowed) => type.startsWith(allowed))) {
    return `"${attachment.name}" isn't a PNG, JPEG, WebP or GIF image.`;
  }
  if (attachment.size > MAX_PHOTO_BYTES) {
    return `"${attachment.name}" is too big (8 MB max).`;
  }
  try {
    const response = await fetch(attachment.url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return `Couldn't download "${attachment.name}".`;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!(await canDecodeImage(bytes))) {
      return `"${attachment.name}" couldn't be read as an image.`;
    }
    return bytes;
  } catch {
    return `Couldn't download "${attachment.name}".`;
  }
}

function describe(
  castaways: ({ name: string; image?: Buffer; lost?: boolean } | undefined)[],
): string {
  return castaways
    .map((castaway, i) => {
      if (!castaway) return `#${i + 1}: *random legend*`;
      const status = castaway.lost ? "💀 voted out" : "🔥";
      return `#${i + 1}: **${castaway.name}** ${status}${castaway.image ? " 📷" : ""}`;
    })
    .join("\n");
}

export default {
  data: new SlashCommandBuilder()
    .setName("castaways")
    .setDescription("Pick the two Survivor players who are your lives (leave blank to see yours)")
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
      option.setName("first_photo").setDescription("Optional photo for castaway #1"),
    )
    .addAttachmentOption((option) =>
      option.setName("second_photo").setDescription("Optional photo for castaway #2"),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const typed = interaction.options.getFocused();
    const typedName = sanitizeCastawayName(typed);
    const suggestions = searchLegendaryCastaways(typed, 25);
    const choices =
      typedName &&
      !suggestions.some((name) => name.toLowerCase() === typedName.toLowerCase())
        ? [typedName, ...suggestions.slice(0, 24)]
        : suggestions;
    await interaction.respond(choices.map((name) => ({ name, value: name })));
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const lobby = !Game.active && Game.lobby && !Game.lobby.closed ? Game.lobby : null;
    const player = Game.active ? Game.getPlayerFromUserId(interaction.user.id) : undefined;
    if (!lobby && !player) {
      return replyEphemeral(
        interaction,
        Game.active
          ? "You are not a player in the current game!"
          : "No game is being set up right now. Start one with /setup.",
      );
    }

    const names = SLOTS.map((slot) => interaction.options.getString(slot));
    const photos = SLOTS.map((slot) => interaction.options.getAttachment(`${slot}_photo`));

    // No options: show the current picks
    if (names.every((name) => name === null) && photos.every((photo) => photo === null)) {
      const current = player ? player.castaways : lobby?.find(interaction.user.id)?.picks;
      return replyEphemeral(
        interaction,
        current
          ? `Your castaways:\n${describe(current)}`
          : "You haven't joined the game being set up yet. Click **Join** on the lobby message.",
      );
    }

    const cleaned = names.map((name) => (name === null ? null : sanitizeCastawayName(name)));
    if (cleaned.some((name) => name === "")) {
      return replyEphemeral(
        interaction,
        "Castaway names can only use letters, numbers and basic punctuation.",
      );
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const images: (Buffer | undefined)[] = [];
    for (let i = 0; i < SLOTS.length; i++) {
      const photo = photos[i];
      if (!photo) continue;
      const downloaded = await downloadPhoto(photo);
      if (typeof downloaded === "string") {
        await interaction.editReply(downloaded);
        return;
      }
      images[i] = downloaded;
    }

    if (lobby) {
      let entry = lobby.find(interaction.user.id);
      if (!entry) {
        const joined = lobby.join(userInfo(interaction.user));
        if ("error" in joined) {
          await interaction.editReply(joined.error);
          return;
        }
        entry = joined.entry;
      }
      for (let i = 0; i < SLOTS.length; i++) {
        const previous = entry.picks[i];
        const name = cleaned[i] ?? previous?.name;
        if (!name) {
          if (images[i]) {
            await interaction.editReply(
              `Give castaway #${i + 1} a name too, so the photo has someone to belong to.`,
            );
            return;
          }
          continue;
        }
        const keepPhoto = previous?.name === name ? previous.image : undefined;
        entry.picks[i] = { name, image: images[i] ?? keepPhoto };
      }
      await lobby.message?.edit(lobby.render()).catch(() => undefined);
      await interaction.editReply(`Your castaways:\n${describe(entry.picks)}`);
      return;
    }

    if (!player) return;
    player.castaways.forEach((castaway, i) => {
      const name = cleaned[i];
      if (name !== null && name !== castaway.name) {
        castaway.name = name;
        castaway.image = undefined; // a new castaway doesn't keep the old photo
      }
      castaway.chosen = true;
      if (images[i]) castaway.image = images[i];
    });
    await interaction.editReply({
      ...(await buildBoardMessage()),
      content: `Your castaways are updated:\n${describe(player.castaways)}`,
    });
  },
};
