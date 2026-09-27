import { cards } from "./cardlist.json";

/** Canonical card names. These must match the names in cardlist.json. */
export const CardName = {
  ExtraVote: "Extra Vote",
  ImmunityIdol: "Immunity Idol",
  IdolNullifier: "Idol Nullifier",
  SorryForYou: "Sorry for You",
  FormAnAlliance: "Let's Form an Alliance",
  NumbersGame: "Reward Challenge: It's a Numbers Game",
  PowerPair: "Reward Challenge: Power Pair",
  DoOrDie: "Reward Challenge: Do or Die",
  CampRaid: "Camp Raid",
  SpyShack: "The Spy Shack",
  KnowledgeIsPower: "Knowledge is Power",
  ControlTheVote: "Tribal Advantage: Control the Vote",
  GoodwillGamble: "Tribal Advantage: Goodwill Gamble",
  ImTheLeaderNow: "Tribal Advantage: I'm the Leader Now",
  TribalCouncil: "Tribal Council",
} as const;

export type CardNameValue = (typeof CardName)[keyof typeof CardName];

/**
 * Cards that are spread evenly through the deck instead of shuffled freely,
 * so idols and advantages don't all clump together early or late.
 */
export const HIGH_VALUE_CARDS: readonly string[] = [
  CardName.ImmunityIdol,
  CardName.IdolNullifier,
  CardName.ExtraVote,
  CardName.ControlTheVote,
  CardName.GoodwillGamble,
  CardName.ImTheLeaderNow,
];

export const INHERITANCE_PREFIX = "Inheritance: ";

export function inheritanceCardName(username: string): string {
  return `${INHERITANCE_PREFIX}${username}`;
}

/** Names of every card in the action deck (not Tribal Council or Inheritance). */
export const ACTION_CARD_NAMES: readonly string[] = cards.map((card) => card.name);
