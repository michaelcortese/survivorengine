import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import type Player from "../../game/player";
import { CardName } from "../../game/cards";
import { RewardChallenge, RewardChallengeCard } from "../../game/reward_challenge";
import { replyEphemeral } from "../../util/discord";

const CARDS: Record<string, RewardChallengeCard> = {
  numbers_game: CardName.NumbersGame,
  power_pair: CardName.PowerPair,
  do_or_die: CardName.DoOrDie,
};

export default {
  data: new SlashCommandBuilder()
    .setName("reward_challenge")
    .setDescription("Play a Reward Challenge card")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("numbers_game")
        .setDescription("It's a Numbers Game: everyone picks 1-5, the lowest unique number steals 2 cards"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("power_pair")
        .setDescription("Power Pair: you and 2 players pick 1-3, a matching pair steals from the third")
        .addUserOption((option) =>
          option.setName("player1").setDescription("The first player to take on").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("player2").setDescription("The second player to take on").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("do_or_die")
        .setDescription("Do or Die: Rock Paper Scissors, the winner steals 2 cards from the loser")
        .addUserOption((option) =>
          option.setName("player").setDescription("The player to challenge").setRequired(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const card = CARDS[interaction.options.getSubcommand()];
    if (!card) {
      return replyEphemeral(interaction, "That's not a Reward Challenge.");
    }
    const result = Game.validateAction(interaction, {
      requiredCard: card,
      target: card === CardName.DoOrDie,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;

    let players: Player[];
    if (card === CardName.NumbersGame) {
      players = Game.getAlivePlayers();
    } else if (card === CardName.DoOrDie) {
      if (!targetPlayer) {
        return replyEphemeral(interaction, "You must specify a player to challenge.");
      }
      players = [player, targetPlayer];
    } else {
      players = [player];
      for (const option of ["player1", "player2"]) {
        const target = Game.validateTarget(player, interaction.options.getUser(option, true));
        if ("error" in target) {
          return replyEphemeral(interaction, target.error);
        }
        if (players.includes(target.targetPlayer)) {
          return replyEphemeral(interaction, "Pick two different players for Power Pair.");
        }
        players.push(target.targetPlayer);
      }
    }

    if (Game.rewardChallenge) {
      return replyEphemeral(
        interaction,
        "A Reward Challenge is already being played. Wait for it to finish!",
      );
    }

    // The play is valid, so the card is used up
    const played = player.removeCard(card)!;
    const challenge = new RewardChallenge(interaction, card, player, players);
    Game.rewardChallenge = challenge;
    try {
      await challenge.run();
    } catch (error) {
      if (!challenge.started) player.hand.push(played); // Discord failed before it began: give the card back
      throw error;
    } finally {
      if (Game.rewardChallenge === challenge) Game.rewardChallenge = null;
    }
  },
};
