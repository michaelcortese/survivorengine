/**
 * The tribe board as a picture: every player's two castaways side by side, lit while they are
 * in the game and grayed out — stamped VOTED OUT — once they have been voted out.
 *
 * Drawn with `@napi-rs/canvas`, which is a native module with prebuilt binaries for the common
 * platforms. It is loaded LAZILY and optionally: on a host where it cannot load, every function
 * here reports that (null / `renderer_unavailable`) and the caller falls back to the text board,
 * so a missing binary costs the picture and never the game.
 *
 * Platform code by the dependency rule — `node:` imports and a native module — so it lives in
 * the Discord layer and the engine never learns it exists. It reads nothing but the `BoardView`
 * it is handed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Canvas, Image, SKRSContext2D } from "@napi-rs/canvas";

import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// What gets drawn
// ---------------------------------------------------------------------------

export interface BoardCastawayView {
  readonly name: string;
  /** A portrait the player uploaded, already cropped by `preparePortrait`. */
  readonly image: Buffer | null;
  readonly votedOut: boolean;
  /** Voted out at the Tribal Council this board is reporting on: drawn with a red glow. */
  readonly justVotedOut: boolean;
}

export type BoardPlayerStatus = "playing" | "jury" | "left" | "finalist" | "winner";

export interface BoardPlayerView {
  readonly name: string;
  /** CSS colour, `#rrggbb`. */
  readonly color: string;
  readonly handCount: number;
  readonly lives: number;
  readonly status: BoardPlayerStatus;
  readonly isTurn: boolean;
  readonly isLeader: boolean;
  readonly castaways: readonly BoardCastawayView[];
}

export interface BoardView {
  readonly title: string;
  readonly subtitle: string;
  readonly players: readonly BoardPlayerView[];
  readonly footer: string;
}

// ---------------------------------------------------------------------------
// Loading the renderer
// ---------------------------------------------------------------------------

type CanvasModule = typeof import("@napi-rs/canvas");

const FONT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "assets",
  "fonts",
);
const DISPLAY_FONT = "SurvivorDisplay";
const TEXT_FONT = "SurvivorText";

/** One attempt per process: a binary that failed to load will not load on the next board. */
let canvasModule: Promise<CanvasModule | null> | undefined;

function loadCanvas(log?: Logger): Promise<CanvasModule | null> {
  canvasModule ??= import("@napi-rs/canvas")
    .then((mod) => {
      mod.GlobalFonts.registerFromPath(join(FONT_DIR, "Oswald-Bold.ttf"), DISPLAY_FONT);
      mod.GlobalFonts.registerFromPath(join(FONT_DIR, "Oswald-Medium.ttf"), TEXT_FONT);
      return mod;
    })
    .catch((cause: unknown) => {
      log?.warn("tribe board images are off: @napi-rs/canvas could not be loaded", {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    });
  return canvasModule;
}

/** Can this process draw boards at all? */
export async function boardImagesAvailable(log?: Logger): Promise<boolean> {
  return (await loadCanvas(log)) !== null;
}

// ---------------------------------------------------------------------------
// Portraits
// ---------------------------------------------------------------------------

/** Stored portrait size: a little over the largest card the board draws, at the card's 5:6. */
export const PORTRAIT_WIDTH = 240;
export const PORTRAIT_HEIGHT = 288;

/**
 * The most pixels an upload may decode to. A few-megabyte PNG can declare a 30000×30000 image
 * and decoding it would take gigabytes, so the size is read from the file's HEADER and checked
 * before anything is decoded. 24 megapixels admits any phone photo.
 */
const MAX_PORTRAIT_PIXELS = 24_000_000;
const MAX_PORTRAIT_SIDE = 12_000;

export type PortraitResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
      readonly ok: false;
      readonly reason: "renderer_unavailable" | "not_an_image" | "too_large";
    };

/**
 * Width and height from an image's header, for PNG, GIF, JPEG and WebP. Null for anything else
 * — which is also how a file that merely claims an image content type is caught.
 */
export function imageDimensions(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  // PNG: signature, then the IHDR chunk.
  if (
    bytes.length >= 24 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.readUInt32BE(4) === 0x0d0a1a0a
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  // GIF87a / GIF89a: the logical screen size.
  if (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "GIF") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      const length = bytes.readUInt16BE(at + 2);
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isFrame) {
        return {
          width: bytes.readUInt16BE(at + 7),
          height: bytes.readUInt16BE(at + 5),
        };
      }
      at += 2 + length;
    }
    return null;
  }
  // WebP: RIFF container, then one of three bitstream headers.
  if (
    bytes.length >= 30 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    const chunk = bytes.toString("latin1", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    }
    if (chunk === "VP8L") {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  return null;
}

/**
 * Turn an uploaded photo into a stored portrait: decoded, cropped to the card's shape (favouring
 * the top, where faces usually are) and re-encoded small. Whatever was uploaded, what is kept is
 * a JPEG this module drew itself — never the original bytes.
 */
export async function preparePortrait(
  bytes: Buffer,
  log?: Logger,
): Promise<PortraitResult> {
  const mod = await loadCanvas(log);
  if (!mod) return { ok: false, reason: "renderer_unavailable" };

  const size = imageDimensions(bytes);
  if (!size || size.width < 1 || size.height < 1)
    return { ok: false, reason: "not_an_image" };
  if (
    size.width > MAX_PORTRAIT_SIDE ||
    size.height > MAX_PORTRAIT_SIDE ||
    size.width * size.height > MAX_PORTRAIT_PIXELS
  ) {
    return { ok: false, reason: "too_large" };
  }

  let image: Image;
  try {
    image = await mod.loadImage(bytes);
  } catch {
    return { ok: false, reason: "not_an_image" };
  }
  if (image.width < 1 || image.height < 1) return { ok: false, reason: "not_an_image" };

  const canvas = mod.createCanvas(PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  drawCover(canvas.getContext("2d"), image, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  return { ok: true, bytes: await canvas.encode("jpeg", 85) };
}

/** Scale to cover `w`×`h`, cropping the overflow — a third from the top, the rest below. */
function drawCover(ctx: SKRSContext2D, image: Image, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (image.width - sw) / 2;
  const sy = (image.height - sh) * 0.35;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, w, h);
}

// ---------------------------------------------------------------------------
// Layout and palette
// ---------------------------------------------------------------------------

const WIDTH = 1200;
const MARGIN = 36;
const HEADER_HEIGHT = 150;
const FOOTER_HEIGHT = 58;
const GAP = 22;
const PANEL_PAD = 18;
const PANEL_BAND = 6;
const PANEL_HEADER = 58;
const CARD_GAP = 14;
const NAMEPLATE = 52;
const PANEL_FOOTER = 34;

const TEXT = "#f5ead9";
const MUTED = "#b3a18c";
const GOLD = "#f4b942";
const RED = "#e0342b";
const PANEL_BG = "#211811";
const ASH = "#4a423b";

function columnsFor(count: number): number {
  if (count <= 3) return Math.max(1, count);
  if (count === 4) return 2;
  return 3;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `amount` > 0 lightens toward white, < 0 darkens toward black. */
function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number): number =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** "Boston Rob Mariano" -> "BM"; "Q" -> "Q". */
export function initials(name: string): string {
  const letters = name
    .split(/[\s-]+/)
    .map((word) => [...word.replace(/[^\p{L}\p{N}]/gu, "")][0])
    .filter((letter): letter is string => letter !== undefined);
  const first = letters[0];
  const last = letters[letters.length - 1];
  if (first === undefined || last === undefined) return "?";
  return (letters.length === 1 ? first : first + last).toUpperCase();
}

function fitText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed.trimEnd()}…`;
}

/** Word-wrap into at most `maxLines`, ending with an ellipsis if it still overflows. */
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const [i, word] of words.entries()) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) {
      current = words.slice(i).join(" ");
      break;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines).map((line) => fitText(ctx, line, maxWidth));
}

function drawFlame(ctx: SKRSContext2D, cx: number, cy: number, size: number): void {
  const outer = ctx.createLinearGradient(cx, cy - size, cx, cy + size * 0.6);
  outer.addColorStop(0, "#ffd166");
  outer.addColorStop(1, "#e4572e");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.bezierCurveTo(
    cx + size * 0.75,
    cy - size * 0.2,
    cx + size * 0.6,
    cy + size * 0.6,
    cx,
    cy + size * 0.6,
  );
  ctx.bezierCurveTo(
    cx - size * 0.6,
    cy + size * 0.6,
    cx - size * 0.75,
    cy - size * 0.2,
    cx,
    cy - size,
  );
  ctx.fill();
  ctx.fillStyle = "#fff3b0";
  ctx.beginPath();
  ctx.moveTo(cx, cy - size * 0.25);
  ctx.bezierCurveTo(
    cx + size * 0.35,
    cy + size * 0.1,
    cx + size * 0.3,
    cy + size * 0.55,
    cx,
    cy + size * 0.55,
  );
  ctx.bezierCurveTo(
    cx - size * 0.3,
    cy + size * 0.55,
    cx - size * 0.35,
    cy + size * 0.1,
    cx,
    cy - size * 0.25,
  );
  ctx.fill();
}

function drawChip(
  ctx: SKRSContext2D,
  text: string,
  right: number,
  centerY: number,
  colors: { readonly bg: string; readonly fg: string },
  withTriangle = false,
): number {
  ctx.font = `15px ${DISPLAY_FONT}`;
  const textWidth = ctx.measureText(text).width;
  const triangle = withTriangle ? 12 : 0;
  const width = textWidth + 20 + triangle;
  const height = 26;
  const x = right - width;
  roundRectPath(ctx, x, centerY - height / 2, width, height, 13);
  ctx.fillStyle = colors.bg;
  ctx.fill();
  ctx.fillStyle = colors.fg;
  if (withTriangle) {
    ctx.beginPath();
    ctx.moveTo(x + 10, centerY - 5);
    ctx.lineTo(x + 18, centerY);
    ctx.lineTo(x + 10, centerY + 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 10 + triangle, centerY + 1);
  ctx.textBaseline = "alphabetic";
  return width;
}

function statusChip(player: BoardPlayerView): {
  readonly text: string;
  readonly bg: string;
  readonly fg: string;
} {
  switch (player.status) {
    case "winner":
      return { text: "SOLE SURVIVOR", bg: GOLD, fg: "#2b1a05" };
    case "finalist":
      return { text: "FINALIST", bg: "rgba(244, 185, 66, 0.2)", fg: GOLD };
    case "jury":
      return { text: "JURY", bg: "rgba(255, 255, 255, 0.08)", fg: "#9c8f82" };
    case "left":
      return { text: "LEFT THE GAME", bg: "rgba(255, 255, 255, 0.08)", fg: "#9c8f82" };
    case "playing":
      return player.lives === 1
        ? { text: "1 LIFE LEFT", bg: "rgba(241, 196, 15, 0.16)", fg: "#f6d55c" }
        : {
            text: `${player.lives} LIVES`,
            bg: "rgba(39, 174, 96, 0.2)",
            fg: "#7be09b",
          };
    default:
      return { text: "", bg: "transparent", fg: TEXT };
  }
}

/** Out of the running: drawn in ash rather than in the player's colour. */
const isOut = (player: BoardPlayerView): boolean =>
  player.status === "jury" || player.status === "left";

async function tryLoadImage(
  mod: CanvasModule,
  bytes: Buffer | null,
): Promise<Image | null> {
  if (!bytes) return null;
  try {
    return await mod.loadImage(bytes);
  } catch {
    return null;
  }
}

/** The castaway's portrait — their photo, or a buff-striped card with their initials. */
function paintPortrait(
  mod: CanvasModule,
  castaway: BoardCastawayView,
  color: string,
  photo: Image | null,
  width: number,
  height: number,
): Canvas {
  const canvas = mod.createCanvas(Math.round(width), Math.round(height));
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  if (photo) {
    drawCover(ctx, photo, w, h);
    return canvas;
  }

  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, shade(color, 0.12));
  background.addColorStop(1, shade(color, -0.55));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  // Buff stripes.
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = w * 0.07;
  for (let x = -h; x < w + h; x += w * 0.2) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h * 0.6, h);
    ctx.stroke();
  }
  ctx.restore();

  const vignette = ctx.createRadialGradient(
    w / 2,
    h * 0.45,
    w * 0.1,
    w / 2,
    h * 0.5,
    w * 0.95,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.font = `${Math.round(w * 0.36)}px ${DISPLAY_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 8;
  ctx.fillText(initials(castaway.name), w / 2, h * 0.47);
  return canvas;
}

function drawCastawayCard(
  mod: CanvasModule,
  ctx: SKRSContext2D,
  castaway: BoardCastawayView,
  color: string,
  photo: Image | null,
  x: number,
  y: number,
  width: number,
  portraitHeight: number,
): void {
  const portrait = paintPortrait(mod, castaway, color, photo, width, portraitHeight);

  ctx.save();
  if (castaway.justVotedOut) {
    ctx.shadowColor = "rgba(224, 52, 43, 0.9)";
    ctx.shadowBlur = 22;
  }
  roundRectPath(ctx, x, y, width, portraitHeight, 12);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRectPath(ctx, x, y, width, portraitHeight, 12);
  ctx.clip();
  // The whole point of the board: a castaway who has been voted out is grayed out.
  if (castaway.votedOut) ctx.filter = "grayscale(100%) brightness(55%) contrast(90%)";
  ctx.drawImage(portrait, x, y, width, portraitHeight);
  ctx.filter = "none";
  ctx.restore();

  roundRectPath(ctx, x, y, width, portraitHeight, 12);
  ctx.lineWidth = castaway.justVotedOut ? 4 : 3;
  ctx.strokeStyle = castaway.justVotedOut ? RED : castaway.votedOut ? ASH : color;
  ctx.stroke();

  if (castaway.votedOut) {
    ctx.save();
    ctx.translate(x + width / 2, y + portraitHeight * 0.72);
    ctx.rotate(-0.18);
    ctx.font = `${Math.round(width * 0.15)}px ${DISPLAY_FONT}`;
    const label = "VOTED OUT";
    const stampW = ctx.measureText(label).width + width * 0.12;
    const stampH = width * 0.24;
    roundRectPath(ctx, -stampW / 2, -stampH / 2, stampW, stampH, 6);
    ctx.fillStyle = "rgba(20, 10, 8, 0.55)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = castaway.justVotedOut ? RED : "rgba(224, 52, 43, 0.75)";
    ctx.stroke();
    ctx.fillStyle = castaway.justVotedOut ? "#ff5a4f" : "rgba(235, 90, 80, 0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 2);
    ctx.restore();
  } else {
    // A lit torch for a castaway still in the game.
    const r = Math.max(13, width * 0.1);
    const cx = x + width - r - 8;
    const cy = y + r + 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15, 10, 8, 0.7)";
    ctx.fill();
    drawFlame(ctx, cx, cy + r * 0.12, r * 0.62);
  }

  ctx.font = `${Math.round(Math.min(20, width * 0.12))}px ${TEXT_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const lines = wrapText(ctx, castaway.name, width - 8, 2);
  const lineHeight = Math.min(22, width * 0.135);
  const firstBaseline = y + portraitHeight + 22;
  lines.forEach((line, i) => {
    const baseline = firstBaseline + i * lineHeight;
    ctx.fillStyle = castaway.votedOut ? "#7d7268" : TEXT;
    ctx.fillText(line, x + width / 2, baseline);
    if (castaway.votedOut) {
      const lineWidth = ctx.measureText(line).width;
      ctx.fillRect(
        x + width / 2 - lineWidth / 2,
        baseline - lineHeight * 0.32,
        lineWidth,
        2,
      );
    }
  });
}

/** The player's own marker: a disc in their colour with their initial. */
function drawPlayerDisc(
  ctx: SKRSContext2D,
  player: BoardPlayerView,
  cx: number,
  cy: number,
  r: number,
): void {
  const color = isOut(player) ? ASH : player.color;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `${Math.round(r * 1.1)}px ${DISPLAY_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials(player.name).slice(0, 1), cx, cy + 1);
  ctx.restore();
}

function drawCardIcon(ctx: SKRSContext2D, x: number, y: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.5;
  roundRectPath(ctx, x + 5, y - 2, 12, 16, 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  roundRectPath(ctx, x, y, 12, 16, 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

/** The board as a PNG, or null when this process cannot draw. Never throws for a bad photo. */
export async function renderBoardImage(
  view: BoardView,
  log?: Logger,
): Promise<Buffer | null> {
  const mod = await loadCanvas(log);
  if (!mod) return null;

  const count = Math.max(1, view.players.length);
  const columns = columnsFor(count);
  const rows = Math.ceil(count / columns);
  const panelWidth = (WIDTH - MARGIN * 2 - GAP * (columns - 1)) / columns;
  const cardWidth = Math.min(200, (panelWidth - PANEL_PAD * 2 - CARD_GAP) / 2);
  const portraitHeight = Math.round(cardWidth * 1.2);
  const panelHeight =
    PANEL_BAND +
    PANEL_PAD +
    PANEL_HEADER +
    8 +
    portraitHeight +
    NAMEPLATE +
    PANEL_FOOTER +
    PANEL_PAD;
  const height =
    HEADER_HEIGHT + rows * panelHeight + (rows - 1) * GAP + FOOTER_HEIGHT + MARGIN / 2;

  const canvas = mod.createCanvas(WIDTH, Math.round(height));
  const ctx = canvas.getContext("2d");

  // Night sky over the fire.
  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "#110c09");
  background.addColorStop(1, "#2b1a0f");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, height);
  const glow = ctx.createRadialGradient(WIDTH / 2, 20, 10, WIDTH / 2, 20, 520);
  glow.addColorStop(0, "rgba(244, 140, 50, 0.28)");
  glow.addColorStop(1, "rgba(244, 140, 50, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, height);

  // Header.
  ctx.textAlign = "center";
  ctx.font = `56px ${DISPLAY_FONT}`;
  ctx.fillStyle = GOLD;
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 12;
  const title = fitText(ctx, view.title.toUpperCase(), WIDTH - MARGIN * 2 - 140);
  ctx.fillText(title, WIDTH / 2, 78);
  ctx.shadowBlur = 0;
  const titleWidth = ctx.measureText(title).width;
  drawFlame(ctx, WIDTH / 2 - titleWidth / 2 - 34, 58, 20);
  drawFlame(ctx, WIDTH / 2 + titleWidth / 2 + 34, 58, 20);
  ctx.font = `22px ${TEXT_FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(fitText(ctx, view.subtitle, WIDTH - MARGIN * 2), WIDTH / 2, 118);

  const photos = await Promise.all(
    view.players.map((player) =>
      Promise.all(
        player.castaways.map((castaway) => tryLoadImage(mod, castaway.image)),
      ),
    ),
  );

  view.players.forEach((player, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const rowCount = row === rows - 1 ? count - row * columns : columns;
    // A short last row is centred.
    const rowOffset = ((columns - rowCount) * (panelWidth + GAP)) / 2;
    const px = MARGIN + rowOffset + col * (panelWidth + GAP);
    const py = HEADER_HEIGHT + row * (panelHeight + GAP);
    const highlight = player.status === "winner" || player.isTurn ? GOLD : null;

    ctx.save();
    if (highlight) {
      ctx.shadowColor = withAlpha(GOLD, 0.55);
      ctx.shadowBlur = 24;
    }
    roundRectPath(ctx, px, py, panelWidth, panelHeight, 18);
    ctx.fillStyle = PANEL_BG;
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRectPath(ctx, px, py, panelWidth, panelHeight, 18);
    ctx.clip();
    ctx.fillStyle = isOut(player) ? ASH : player.color;
    ctx.fillRect(px, py, panelWidth, PANEL_BAND);
    ctx.restore();
    roundRectPath(ctx, px, py, panelWidth, panelHeight, 18);
    ctx.lineWidth = highlight ? 3 : 1;
    ctx.strokeStyle = highlight ?? "rgba(255, 255, 255, 0.09)";
    ctx.stroke();

    // Who.
    const headerTop = py + PANEL_BAND + PANEL_PAD;
    const discR = 21;
    const discCx = px + PANEL_PAD + discR;
    const headerCy = headerTop + 24;
    drawPlayerDisc(ctx, player, discCx, headerCy, discR);
    const chip = statusChip(player);
    const chipWidth = drawChip(
      ctx,
      chip.text,
      px + panelWidth - PANEL_PAD,
      headerCy,
      chip,
    );
    ctx.font = `26px ${DISPLAY_FONT}`;
    ctx.textAlign = "left";
    ctx.fillStyle = isOut(player) ? MUTED : TEXT;
    const nameX = discCx + discR + 12;
    const nameMax = px + panelWidth - PANEL_PAD - chipWidth - 10 - nameX;
    ctx.fillText(fitText(ctx, player.name, nameMax), nameX, headerCy + 9);

    // Their castaways.
    const cardsTop = headerTop + PANEL_HEADER + 8;
    const cardCount = Math.max(1, player.castaways.length);
    const cardsWidth = cardWidth * cardCount + CARD_GAP * (cardCount - 1);
    const cardsLeft = px + (panelWidth - cardsWidth) / 2;
    player.castaways.forEach((castaway, i) => {
      drawCastawayCard(
        mod,
        ctx,
        castaway,
        player.color,
        photos[index]?.[i] ?? null,
        cardsLeft + i * (cardWidth + CARD_GAP),
        cardsTop,
        cardWidth,
        portraitHeight,
      );
    });

    // Cards in hand, and whose move it is.
    const footerCy = cardsTop + portraitHeight + NAMEPLATE + PANEL_FOOTER / 2;
    if (!isOut(player)) {
      drawCardIcon(ctx, px + PANEL_PAD, footerCy - 8, MUTED);
      ctx.font = `16px ${DISPLAY_FONT}`;
      ctx.fillStyle = MUTED;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `${player.handCount} ${player.handCount === 1 ? "CARD" : "CARDS"}`,
        px + PANEL_PAD + 24,
        footerCy + 1,
      );
      ctx.textBaseline = "alphabetic";
    }
    let chipRight = px + panelWidth - PANEL_PAD;
    if (player.isTurn) {
      chipRight -=
        drawChip(
          ctx,
          "THEIR TURN",
          chipRight,
          footerCy,
          { bg: GOLD, fg: "#2b1a05" },
          true,
        ) + 8;
    }
    if (player.isLeader) {
      drawChip(ctx, "TRIBAL LEADER", chipRight, footerCy, {
        bg: "rgba(224, 52, 43, 0.2)",
        fg: "#ff8a80",
      });
    }
  });

  ctx.font = `18px ${TEXT_FONT}`;
  ctx.fillStyle = MUTED;
  ctx.textAlign = "center";
  ctx.fillText(
    fitText(ctx, view.footer, WIDTH - MARGIN * 2),
    WIDTH / 2,
    height - FOOTER_HEIGHT / 2 - MARGIN / 4 + 6,
  );

  return canvas.encode("png");
}
