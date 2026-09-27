import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Message,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { CASTAWAY_NAME_MAX_LENGTH } from "./castaways";
import { GameConfig, formatDuration } from "./config";

export interface CastawayPick {
  name: string;
  image?: Buffer;
}

export interface LobbyEntry {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  /** picks[0] is castaway #1 (voted out first), picks[1] is castaway #2. */
  picks: (CastawayPick | undefined)[];
}

export type LobbyAction = "join" | "pick" | "leave" | "start" | "cancel";

let nextLobbyId = 1;

/** A game being set up with /setup: players join and pick their castaways. */
export class Lobby {
  readonly id = nextLobbyId++;
  readonly entries: LobbyEntry[] = [];
  message: Message | null = null;
  closed = false;
  private onDispose: ((reason: string) => void) | null = null;

  constructor(
    readonly hostId: string,
    readonly discussionMs?: number,
  ) {}

  get isFull(): boolean {
    return this.entries.length >= GameConfig.maxPlayers;
  }

  find(userId: string): LobbyEntry | undefined {
    return this.entries.find((entry) => entry.userId === userId);
  }

  join(user: {
    id: string;
    displayName: string;
    avatarUrl?: string;
  }): { entry: LobbyEntry } | { error: string } {
    const existing = this.find(user.id);
    if (existing) return { entry: existing };
    if (this.isFull) {
      return { error: `The tribe is full (${GameConfig.maxPlayers} players max).` };
    }
    const entry: LobbyEntry = {
      userId: user.id,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      picks: [undefined, undefined],
    };
    this.entries.push(entry);
    return { entry };
  }

  leave(userId: string): boolean {
    const index = this.entries.findIndex((entry) => entry.userId === userId);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    return true;
  }

  customId(action: LobbyAction): string {
    return `lobby:${this.id}:${action}`;
  }

  modalId(userId: string): string {
    return `lobby:${this.id}:modal:${userId}`;
  }

  private describeEntry(entry: LobbyEntry, index: number): string {
    const picks = entry.picks.map((pick) =>
      pick ? `🔥 ${pick.name}${pick.image ? " 📷" : ""}` : "*random legend*",
    );
    return `${index + 1}. <@${entry.userId}> — ${picks.join(" · ")}`;
  }

  render(): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const roster =
      this.entries.length > 0
        ? this.entries.map((entry, i) => this.describeEntry(entry, i)).join("\n")
        : "*Nobody yet. Click **Join** to get in the game!*";
    const discussion = formatDuration(
      this.discussionMs ?? GameConfig.timings.discussionMs,
    );
    const embed = new EmbedBuilder()
      .setTitle("🏝️ A new game of Survivor is being set up")
      .setColor(0xf4b942)
      .setDescription(
        [
          `Hosted by <@${this.hostId}>.`,
          "",
          "**Join** the tribe, then **Pick Castaways** to choose the two Survivor players who'll be your lives. " +
            "Every time you're voted out, one of them is grayed out on the tribe board. Lose both and your torch is snuffed.",
          "",
          "Don't want to pick? You'll get two random legends. Use `/castaways` to add photos.",
        ].join("\n"),
      )
      .addFields({
        name: `Tribe (${this.entries.length}/${GameConfig.maxPlayers})`,
        value: roster.slice(0, 1024),
      })
      .setFooter({
        text: `Tribal Council discussion: ${discussion} · ${GameConfig.minPlayers}-${GameConfig.maxPlayers} players · Only the host can start`,
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(this.customId("join"))
        .setLabel("Join")
        .setEmoji("🏝️")
        .setStyle(ButtonStyle.Success)
        .setDisabled(this.isFull),
      new ButtonBuilder()
        .setCustomId(this.customId("pick"))
        .setLabel("Pick Castaways")
        .setEmoji("🔥")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(this.customId("leave"))
        .setLabel("Leave")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(this.customId("start"))
        .setLabel("Start Game")
        .setEmoji("▶️")
        .setStyle(ButtonStyle.Success)
        .setDisabled(this.entries.length < GameConfig.minPlayers),
      new ButtonBuilder()
        .setCustomId(this.customId("cancel"))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );
    return { embeds: [embed], components: [row] };
  }

  renderClosed(reason: string): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const embed = new EmbedBuilder()
      .setTitle("🏝️ Survivor game setup")
      .setColor(0x6b5e52)
      .setDescription(reason);
    if (this.entries.length > 0) {
      embed.addFields({
        name: "Tribe",
        value: this.entries
          .map((entry, i) => this.describeEntry(entry, i))
          .join("\n")
          .slice(0, 1024),
      });
    }
    return { embeds: [embed], components: [] };
  }

  buildCastawayModal(entry: LobbyEntry): ModalBuilder {
    const input = (id: string, label: string, current?: CastawayPick) => {
      const field = new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(CASTAWAY_NAME_MAX_LENGTH)
        .setPlaceholder("e.g. Parvati Shallow. Leave blank for a random legend.");
      if (current) field.setValue(current.name);
      return new ActionRowBuilder<TextInputBuilder>().addComponents(field);
    };
    return new ModalBuilder()
      .setCustomId(this.modalId(entry.userId))
      .setTitle("Pick your two castaways")
      .addComponents(
        input("first", "Castaway #1 (voted out first)", entry.picks[0]),
        input("second", "Castaway #2 (your last life)", entry.picks[1]),
      );
  }

  /** Runs when the lobby is closed from outside (e.g. /end_game or /start). */
  setDisposer(onDispose: (reason: string) => void) {
    this.onDispose = onDispose;
  }

  dispose(reason = "This game setup was closed.") {
    if (this.closed) return;
    this.closed = true;
    this.onDispose?.(reason);
  }
}
