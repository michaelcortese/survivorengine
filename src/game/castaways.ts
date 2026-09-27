/**
 * Castaways are the two Survivor Character Cards each player puts in front of
 * them. They are the player's lives: every time the player is voted out, one of
 * their castaways is turned over (grayed out on the tribe board). When both are
 * gone, the player is out of the game and joins the jury.
 */
export interface Castaway {
  name: string;
  /** Optional portrait uploaded by the player (raw image bytes). */
  image?: Buffer;
  /** Turned over after a vote-out. */
  lost: boolean;
  /** Which Tribal Council (1-based) this castaway was voted out at. */
  lostAtTribal?: number;
  /** False for placeholder castaways the player never picked. */
  chosen: boolean;
}

export const CASTAWAY_NAME_MAX_LENGTH = 40;

/** Iconic castaways, offered as suggestions and used for random picks. */
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

/** Tribe colors, handed out by seat. */
export const TRIBE_COLORS: readonly string[] = [
  "#E4572E", // red
  "#2E86DE", // blue
  "#27AE60", // green
  "#F1C40F", // yellow
  "#9B59B6", // purple
  "#F39C12", // orange
];

/**
 * Cleans a user-supplied castaway name: keeps letters, numbers and a little
 * punctuation, so names can't carry markdown, mentions or pings.
 */
export function sanitizeCastawayName(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N} .'’&!?,()-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CASTAWAY_NAME_MAX_LENGTH)
    .trim();
}

/** Random legendary castaways, avoiding names already in use (case-insensitive). */
export function pickRandomCastaways(
  count: number,
  taken: Iterable<string> = [],
): string[] {
  const used = new Set(Array.from(taken, (name) => name.toLowerCase()));
  const pool = LEGENDARY_CASTAWAYS.filter((name) => !used.has(name.toLowerCase()));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picks = pool.slice(0, count);
  // Only reachable if a game ever uses more castaways than the roster has.
  for (let n = 1; picks.length < count; n++) {
    const fallback = `Castaway ${n}`;
    if (!used.has(fallback.toLowerCase())) picks.push(fallback);
  }
  return picks;
}

/** Legendary castaways matching what the user has typed so far. */
export function searchLegendaryCastaways(query: string, limit = 25): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return LEGENDARY_CASTAWAYS.slice(0, limit);
  const startsWith = LEGENDARY_CASTAWAYS.filter((name) =>
    name.toLowerCase().split(/[\s-]+/).some((word) => word.startsWith(needle)) ||
    name.toLowerCase().startsWith(needle),
  );
  const contains = LEGENDARY_CASTAWAYS.filter(
    (name) => !startsWith.includes(name) && name.toLowerCase().includes(needle),
  );
  return [...startsWith, ...contains].slice(0, limit);
}
