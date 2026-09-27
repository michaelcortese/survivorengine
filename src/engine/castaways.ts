/**
 * Castaways: who each Survivor Character Card depicts.
 *
 * Every player has two Survivor Character Cards, and they are that player's lives — the first
 * vote-out turns one over, the second puts the player on the Jury. Giving each card a castaway
 * (a player you would take to the island: Boston Rob, Parvati, your cousin) is what turns "one
 * torch left" into "Sandra is gone, Tony is all I have". No rule reads a name, but the names are
 * TABLE state — public, chosen in the lobby, carried through a restart — so they live in the
 * engine with the rest of the state rather than beside it in the Discord layer.
 *
 * The order is the order of the lives: castaway #1 is on the first card to be turned over, and
 * castaway #2 is the last life (`nextUnflippedCharacter` always takes the first card still face
 * up, and a card is never moved once it is dealt).
 *
 * Anyone who has not picked by the time the game begins is dealt legends at random. That draw
 * comes from its OWN stream, seeded from the game's seed, and never from `ctx.rng`: taking even
 * one number from the game's stream would reshuffle every steal and every Tribal Council placement
 * after it, and would make every game that names its castaways play differently from the same
 * seed that does not.
 */

import { createRng } from "./rng.js";

/** Long enough for "Sandra Diaz-Twine" twice over; short enough to fit under a portrait. */
export const CASTAWAY_NAME_MAX_LENGTH = 40;

/** Iconic castaways. Offered as suggestions, and dealt to anyone who does not pick. */
export const LEGENDARY_CASTAWAYS: readonly string[] = [
  // Winners
  "Richard Hatch",
  "Tina Wesson",
  "Ethan Zohn",
  "Vecepia Towery",
  "Brian Heidik",
  "Jenna Morasca",
  "Sandra Diaz-Twine",
  "Amber Mariano",
  "Chris Daugherty",
  "Tom Westman",
  "Danni Boatwright",
  "Aras Baskauskas",
  "Yul Kwon",
  "Earl Cole",
  "Todd Herzog",
  "Parvati Shallow",
  "Bob Crowley",
  "J.T. Thomas",
  "Natalie White",
  "Fabio Birza",
  "Boston Rob Mariano",
  "Sophie Clarke",
  "Kim Spradlin",
  "Denise Stapley",
  "John Cochran",
  "Tyson Apostol",
  "Tony Vlachos",
  "Natalie Anderson",
  "Mike Holloway",
  "Jeremy Collins",
  "Michele Fitzgerald",
  "Adam Klein",
  "Sarah Lacina",
  "Ben Driebergen",
  "Wendell Holland",
  "Nick Wilson",
  "Chris Underwood",
  "Tommy Sheehan",
  "Erika Casupanan",
  "Maryanne Oketch",
  "Mike Gabler",
  "Yam Yam Arocho",
  "Dee Valladares",
  "Kenzie Petty",
  "Rachel LaMont",
  "Kyle Fraser",
  // Legends
  "Rob Cesternino",
  "Ozzy Lusth",
  "Cirie Fields",
  "Russell Hantz",
  "Coach Wade",
  "Rupert Boneham",
  "Colby Donaldson",
  "Jerri Manthey",
  "Stephenie LaGrossa",
  "Amanda Kimmel",
  "Malcolm Freberg",
  "Andrea Boehlke",
  "Kelley Wentworth",
  "Joe Anglim",
  "Stephen Fishbach",
  "Spencer Bledsoe",
  "Kelly Wiglesworth",
  "Lex van den Berghe",
  "Jonny Fairplay",
  "Shane Powers",
  "Courtney Yates",
  "Aubry Bracco",
  "David Wright",
  "Christian Hubicki",
  "Rick Devens",
  "Carolyn Wiger",
  "Q Burdette",
  "Jonathan Penner",
  "Rudy Boesch",
  "Sue Hawk",
  "Gervase Peterson",
  "Colleen Haskell",
  "Yau-Man Chan",
  "James Clement",
  "Terry Deitz",
  "Troyzan Robertson",
  "Abi-Maria Gomes",
  "Brenda Lowe",
  "Lisa Whelchel",
  "Kass McQuillen",
  "Tai Trang",
  "Zeke Smith",
  "Domenick Abbate",
  "Devon Pinto",
  "Kellee Kim",
  "Karishma Patel",
  "Shan Smith",
  "Ricard Foyé",
  "Carson Garrett",
  "Charlie Davis",
  "Maria Shrime Gonzalez",
  "Genevieve Mushaluk",
  "Sue Smey",
  "Teeny Chirichillo",
  "Andy Rueda",
  "Eva Erickson",
  "Joe Hunter",
];

/**
 * A name as the table will see it: letters, numbers, spaces and a little punctuation, at most
 * `CASTAWAY_NAME_MAX_LENGTH` characters.
 *
 * What it strips is the point. A name is printed in channel messages, so `@everyone`, `<@id>`,
 * `**bold**`, `` `code` `` and links must not survive it — none of `@ < > * _ ` ~ | # : /` is on
 * the list.
 */
export function sanitizeCastawayName(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N} .'’&!?,()-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, CASTAWAY_NAME_MAX_LENGTH).join("").trim();
}

/** True when `name` is already exactly what `sanitizeCastawayName` would make of it. */
export const isValidCastawayName = (name: string): boolean =>
  name.length > 0 && sanitizeCastawayName(name) === name;

/** The comparison key: two castaways are the same castaway regardless of capitalisation. */
export const castawayKey = (name: string): string => name.toLowerCase();

/**
 * Salt for the castaway stream. Any constant works; this one only has to differ from zero so the
 * stream is not the game's own stream under another name.
 */
const CASTAWAY_STREAM_SALT = 0x5ca57a3a;

/**
 * Every player's castaways with the blanks dealt from `LEGENDARY_CASTAWAYS`.
 *
 * Deterministic in `seed` and the input, never repeats a castaway already at the table (by
 * `castawayKey`), and deals in seat order so the result does not depend on who picked first. The
 * roster holds far more names than six players can use; the numbered fallback exists only so the
 * function is total.
 */
export function dealCastaways(
  castaways: readonly (readonly (string | null)[])[],
  seed: number,
): string[][] {
  const taken = new Set<string>();
  for (const names of castaways) {
    for (const name of names) if (name !== null) taken.add(castawayKey(name));
  }
  const rng = createRng((seed ^ CASTAWAY_STREAM_SALT) | 0);
  const pool = rng
    .shuffle(LEGENDARY_CASTAWAYS)
    .filter((name) => !taken.has(castawayKey(name)));
  let fallback = 0;

  const next = (): string => {
    const legend = pool.shift();
    if (legend !== undefined) {
      taken.add(castawayKey(legend));
      return legend;
    }
    for (;;) {
      fallback += 1;
      const name = `Castaway ${fallback}`;
      if (!taken.has(castawayKey(name))) {
        taken.add(castawayKey(name));
        return name;
      }
    }
  };

  return castaways.map((names) => names.map((name) => name ?? next()));
}
