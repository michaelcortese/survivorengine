import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";

const VOTING_DURATION = 10 * 60 * 1000; // 10 minutes
const COUNTDOWN_DURATION = 15 * 1000; // 15 seconds

class FinalTribalCouncil {
  interaction: ChatInputCommandInteraction;
  jury: any[];
  finalists: any[];
  leader: any;
  votes: Map<string, string>; // juryId -> finalistId
  votingTimer: NodeJS.Timeout | null;
  countdownTimer: NodeJS.Timeout | null;
  votingStarted: boolean;
  votingEndTime: number;

  constructor(interaction: ChatInputCommandInteraction) {
    this.interaction = interaction;
    this.jury = (Game.players as any[]).filter((p) => !p.isAlive());
    this.finalists = Game.getAlivePlayers();
    this.leader = Game.finalTribalLeader;
    this.votes = new Map();
    this.votingTimer = null;
    this.countdownTimer = null;
    this.votingStarted = false;
    this.votingEndTime = Date.now() + VOTING_DURATION;
    (Game as any).finalTribalCouncilInstance = this;
  }

  async start() {
    if (this.finalists.length !== 2) {
      return this.interaction.reply({
        content:
          "Final Tribal Council can only be started when exactly 2 players remain.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!this.leader || this.leader.isAlive()) {
      return this.interaction.reply({
        content:
          "The specified leader must be the most recently eliminated player (lives = 0).",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!this.jury.some((j) => j.id === this.leader.id)) {
      return this.interaction.reply({
        content: "Leader must be a member of the jury.",
        flags: MessageFlags.Ephemeral,
      });
    }

        Game.tribalCouncilState = TribalCouncilState.FINAL;
        Game.finalTribalLeader = this.leader;
      }
    }
    
    export default {
      data: new SlashCommandBuilder()
        .setName("final_tribal_council")
        .setDescription("Start the Final Tribal Council (only when 2 players remain)"),
      async execute(interaction: ChatInputCommandInteraction) {
        // Only allow if exactly 2 players alive
        const alivePlayers = Game.getAlivePlayers();
        if (alivePlayers.length !== 2) {
          return interaction.reply({
            content:
              "Final Tribal Council can only be started when exactly 2 players remain.",
            flags: MessageFlags.Ephemeral,
          });
        }
        // The leader must be the most recently eliminated player
        const leaderPlayer = Game.finalTribalLeader;
        if (!leaderPlayer || leaderPlayer.isAlive()) {
          return interaction.reply({
            content:
              "The specified leader must be the most recently eliminated player (lives = 0).",
            flags: MessageFlags.Ephemeral,
          });
        }
        // Set up jury: all eliminated players
        const jury = Game.players.filter((p) => !p.isAlive());
        if (!jury.some((j) => j.id === leaderPlayer.id)) {
          return interaction.reply({
            content: "Leader must be a member of the jury.",
            flags: MessageFlags.Ephemeral,
          });
        }
        // Unlock final tribal council singleton in Game
        Game.tribalCouncilState = TribalCouncilState.FINAL;
        Game.finalTribalLeader = leaderPlayer;
        (Game as any).finalTribalCouncil = {
          jury,
          finalists: alivePlayers,
          leader: leaderPlayer,
          votes: new Map(), // juryId -> finalistId
          votingStarted: true,
          votingEndTime: Date.now() + VOTING_DURATION,
        };
        await interaction.reply({
          content:
            `STOP PLAYING AND RUN THIS!\n\nFinal Tribal Council has begun. Jury: ${jury
              .map((j) => `<@${j.id}>`)
              .join(", ")}. Finalists: ${alivePlayers
              .map((p) => `<@${p.id}>`)
              .join(" vs ")}.\n\n<@${leaderPlayer.id}> is the Final Tribal Council Leader. Jury members, use /cast_vote to vote for the winner.`,
        });
      },
    };