import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  MessageComponentInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Game, InterruptionOutcome } from "../../game/game";
import type Player from "../../game/player";
import { CardName } from "../../game/cards";
import { GameConfig, formatDuration } from "../../game/config";
import { replyEphemeral, runSorryForYouWindow, sendDM } from "../../util/discord";

const REQUIRED_CARD = CardName.FormAnAlliance;
const PICK_PREFIX = "form_alliance:";

/** One of the alliance's two steals. */
interface Steal {
  thief: Player;
  victim: Player;
  /** Starts each public message about the steal. */
  heading: string;
}

/** The game the alliance was played in is over, or a new one has started. */
function isOver(gameId: number): boolean {
  return !Game.isCurrentGame(gameId) || !Game.active;
}

function describeAttempt({ thief, victim, heading }: Steal) {
  return (seconds: number) =>
    `${heading} <@${thief.id}> is attempting to steal from <@${victim.id}>... (They have ~${seconds} seconds remaining to play "Sorry For You")`;
}

/**
 * Finishes a steal once its Sorry for You window closes: the thief takes a
 * random card unless the victim blocked it. `interaction` is the thief's, so
 * the private messages go to them.
 */
async function settleSteal(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction,
  window: { outcome: InterruptionOutcome; secondsLeft: number },
  gameId: number,
  { thief, victim, heading }: Steal,
) {
  const announce = (text: string) =>
    interaction.editReply({ content: `${heading} ${text}` });

  // Checked first: ending the game closes the window as if it were blocked
  if (isOver(gameId)) {
    await announce(`The game ended before <@${thief.id}> could steal from <@${victim.id}>.`);
    return;
  }
  if (window.outcome === "stopped") {
    await announce(
      `<@${thief.id}>'s steal from <@${victim.id}> was interrupted with ${window.secondsLeft} seconds remaining.`,
    );
    await interaction.followUp({
      content: "Your steal attempt was interrupted!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // A Tribal Council can start while the partner is picking
  if (!thief.isAlive() || !victim.isAlive()) {
    await announce(
      `<@${thief.id}>'s steal from <@${victim.id}> fell through: one of them was voted out.`,
    );
    return;
  }
  if (victim.hand.length === 0) {
    await announce(
      `<@${thief.id}> tried to steal from <@${victim.id}>, but there was nothing left to take.`,
    );
    return;
  }

  const randomIndex = Math.floor(Math.random() * victim.hand.length);
  const [card] = victim.hand.splice(randomIndex, 1);
  thief.hand.push(card);
  await announce(`<@${thief.id}> has stolen a card from <@${victim.id}>!!!`);
  await interaction.followUp({
    content: `You successfully stole *${card.getName()}* from <@${victim.id}>!`,
    flags: MessageFlags.Ephemeral,
  });
  await sendDM(
    interaction.client,
    victim.id,
    `<@${thief.id}> stole **${card.getName()}** from you in the Survivor game!`,
  );
}

/**
 * Posts a button for each player the partner could steal from. Only the
 * partner can use them, and if they don't pick in time they don't steal.
 */
async function offerPartnerSteal(
  interaction: ChatInputCommandInteraction,
  gameId: number,
  player: Player,
  partner: Player,
) {
  // Both partners can steal from the same player, but not from each other
  const victims = Game.getAlivePlayers().filter(
    (p) => p !== player && p !== partner && p.hand.length > 0,
  );
  if (victims.length === 0) {
    await interaction.followUp({
      content: `🤝 <@${partner.id}> would steal next, but nobody they can steal from has any cards.`,
    });
    return;
  }

  const buttons = victims.map((victim) =>
    new ButtonBuilder()
      .setCustomId(`${PICK_PREFIX}${victim.id}`)
      .setLabel(victim.username)
      .setStyle(ButtonStyle.Primary),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    // Discord fits at most 5 buttons in a row
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  const picker = await interaction.followUp({
    content: `🤝 <@${partner.id}>, you're <@${player.id}>'s alliance partner! Pick who you want to steal a random card from. You have ${formatDuration(GameConfig.timings.menuMs)}.`,
    components: rows,
  });

  const collector = picker.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: GameConfig.timings.menuMs,
  });
  // True once a click has taken over the message. Set before stopping the
  // collector, because stopping it fires "end" straight away.
  let settled = false;
  const closedText = () =>
    isOver(gameId)
      ? `🤝 The game ended before <@${partner.id}> picked who to steal from.`
      : !partner.isAlive()
        ? `🤝 <@${partner.id}> was voted out before picking who to steal from.`
        : `⏳ <@${partner.id}> didn't pick in time, so they don't get to steal.`;

  collector.on("collect", async (click) => {
    try {
      if (click.user.id !== partner.id) {
        await replyEphemeral(click, `Only <@${partner.id}> can pick who they steal from.`);
        return;
      }
      if (collector.ended) {
        // A click can still arrive just after the pick or the timeout
        await replyEphemeral(click, "It's too late to pick who to steal from.");
        return;
      }
      if (isOver(gameId) || !partner.isAlive()) {
        settled = true;
        collector.stop("closed");
        await click.update({ content: closedText(), components: [] });
        return;
      }
      const victim = Game.getPlayerFromUserId(click.customId.slice(PICK_PREFIX.length));
      if (!victim?.isAlive()) {
        await replyEphemeral(click, "That player has been voted out. Pick someone else.");
        return;
      }
      if (victim.hand.length === 0) {
        await replyEphemeral(click, `<@${victim.id}> has no cards to steal! Pick someone else.`);
        return;
      }
      if (Game.interruption) {
        await replyEphemeral(
          click,
          "Someone else's steal is in progress. Wait a moment and try again.",
        );
        return;
      }

      settled = true;
      collector.stop("picked");
      const steal: Steal = { thief: partner, victim, heading: "🤝" };
      // No window was open a moment ago, so this one opens
      const window = (await runSorryForYouWindow(
        click,
        partner,
        victim,
        describeAttempt(steal),
      ))!;
      await settleSteal(click, window, gameId, steal);
    } catch (error) {
      console.error("The alliance partner's steal failed:", error);
    }
  });

  collector.on("end", async () => {
    if (settled) return;
    await picker.edit({ content: closedText(), components: [] }).catch(() => undefined);
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName("form_alliance")
    .setDescription("Play Let's Form an Alliance - You and a partner each steal a random card")
    .addUserOption((option) =>
      option
        .setName("partner")
        .setDescription("Your alliance partner (they pick who they steal from)")
        .setRequired(true),
    )
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("The player you steal a random card from (not your partner)")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    // Checks the `target` option; the partner is checked below
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
      interruptible: true,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "You must specify a player to steal from.");
    }
    const partner = Game.getPlayerFromUserId(interaction.options.getUser("partner", true).id);
    if (!partner) {
      return replyEphemeral(interaction, "Your partner must be a player in the game!");
    }
    if (partner === player) {
      return replyEphemeral(interaction, "You can't form an alliance with yourself!");
    }
    if (!partner.isAlive()) {
      return replyEphemeral(interaction, `<@${partner.id}> has already been voted out of the game.`);
    }
    if (targetPlayer === partner) {
      return replyEphemeral(
        interaction,
        "You and your partner can't steal from each other! Pick someone else to steal from.",
      );
    }
    if (targetPlayer.hand.length === 0) {
      // Checked before the card is played, so you keep it
      return replyEphemeral(interaction, `<@${targetPlayer.id}> has no cards to steal!`);
    }

    const gameId = Game.id;
    const steal: Steal = {
      thief: player,
      victim: targetPlayer,
      heading: `🤝 <@${player.id}> played **Let's Form an Alliance** with <@${partner.id}>!`,
    };
    // The card is played now, whether or not the steals get blocked
    const played = player.removeCard(REQUIRED_CARD)!;
    let window;
    try {
      window = await runSorryForYouWindow(
        interaction,
        player,
        targetPlayer,
        describeAttempt(steal),
      );
    } catch (error) {
      player.hand.push(played); // Discord failed: give the card back
      throw error;
    }
    if (!window) {
      player.hand.push(played);
      return replyEphemeral(
        interaction,
        "This action cannot be played at this time. Wait a moment and try again.",
      );
    }
    await settleSteal(interaction, window, gameId, steal);

    // Blocked or not, the partner still gets their steal
    if (!isOver(gameId)) {
      await offerPartnerSteal(interaction, gameId, player, partner);
    }
  },
};
