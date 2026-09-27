import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Canvas, Image, SKRSContext2D } from "@napi-rs/canvas";

/**
 * Draws the tribe board: every player's two castaways, with voted-out
 * castaways grayed out. Uses @napi-rs/canvas when it's available; callers fall
 * back to a text board when renderBoardImage returns null.
 */

export interface BoardCastawayView {
  name: string;
  image?: Buffer;
  lost: boolean;
  /** Voted out at the Tribal Council this board is reporting on. */
  justLost: boolean;
}

export type BoardPlayerStatus = "alive" | "jury" | "finalist" | "winner";

export interface BoardPlayerView {
  name: string;
  color: string;
  avatar?: Buffer | null;
  handCount: number;
  lives: number;
  status: BoardPlayerStatus;
  isTurn: boolean;
  isLeader: boolean;
  castaways: BoardCastawayView[];
}

export interface BoardView {
  title: string;
  subtitle: string;
  players: BoardPlayerView[];
  footer: string;
}

type CanvasModule = typeof import("@napi-rs/canvas");

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(moduleDir, "..", "..", "assets", "fonts");
const DISPLAY_FONT = "SurvivorDisplay";
const TEXT_FONT = "SurvivorText";

let canvasModule: Promise<CanvasModule | null> | undefined;

function loadCanvas(): Promise<CanvasModule | null> {
  canvasModule ??= import("@napi-rs/canvas")
    .then((mod) => {
      mod.GlobalFonts.registerFromPath(
        path.join(FONT_DIR, "Oswald-Bold.ttf"),
        DISPLAY_FONT,
      );
      mod.GlobalFonts.registerFromPath(
        path.join(FONT_DIR, "Oswald-Medium.ttf"),
        TEXT_FONT,
      );
      return mod;
    })
    .catch((error) => {
      console.warn(
        "Tribe board images are disabled because @napi-rs/canvas could not be loaded:",
        error,
      );
      return null;
    });
  return canvasModule;
}

/** True if this image can be decoded (used to validate uploaded portraits). */
export async function canDecodeImage(bytes: Buffer): Promise<boolean> {
  const mod = await loadCanvas();
  if (!mod) return true; // can't check, and it won't be drawn anyway
  try {
    const image = await mod.loadImage(bytes);
    return image.width > 0 && image.height > 0;
  } catch {
    return false;
  }
}

// Layout
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

// Palette
const TEXT = "#f5ead9";
const MUTED = "#b3a18c";
const GOLD = "#f4b942";
const RED = "#e0342b";
const PANEL_BG = "#211811";

function columnsFor(count: number): number {
  if (count <= 3) return Math.max(1, count);
  if (count === 4) return 2;
  return 3;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function shade(hex: string, amount: number): string {
  // amount > 0 lightens toward white, < 0 darkens toward black
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) =>
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
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function initials(name: string): string {
  const words = name.split(/[\s-]+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words.map((word) => [...word.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "");
  if (letters.length === 0) return "?";
  if (letters.length === 1) return letters[0].toUpperCase();
  return (letters[0] + letters[letters.length - 1]).toUpperCase();
}

function fitText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed.trimEnd()}…`;
}

/** Word-wraps into at most `maxLines`, ending with an ellipsis if it overflows. */
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < words.length; i++) {
    const candidate = current ? `${current} ${words[i]}` : words[i];
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = words[i];
    if (lines.length === maxLines - 1) {
      current = words.slice(i).join(" ");
      break;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines).map((line) => fitText(ctx, line, maxWidth));
}

function drawFlame(ctx: SKRSContext2D, cx: number, cy: number, size: number) {
  const outer = ctx.createLinearGradient(cx, cy - size, cx, cy + size * 0.6);
  outer.addColorStop(0, "#ffd166");
  outer.addColorStop(1, "#e4572e");
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.bezierCurveTo(cx + size * 0.75, cy - size * 0.2, cx + size * 0.6, cy + size * 0.6, cx, cy + size * 0.6);
  ctx.bezierCurveTo(cx - size * 0.6, cy + size * 0.6, cx - size * 0.75, cy - size * 0.2, cx, cy - size);
  ctx.fill();
  ctx.fillStyle = "#fff3b0";
  ctx.beginPath();
  ctx.moveTo(cx, cy - size * 0.25);
  ctx.bezierCurveTo(cx + size * 0.35, cy + size * 0.1, cx + size * 0.3, cy + size * 0.55, cx, cy + size * 0.55);
  ctx.bezierCurveTo(cx - size * 0.3, cy + size * 0.55, cx - size * 0.35, cy + size * 0.1, cx, cy - size * 0.25);
  ctx.fill();
}

function drawChip(
  ctx: SKRSContext2D,
  text: string,
  right: number,
  centerY: number,
  colors: { bg: string; fg: string },
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

function statusChip(player: BoardPlayerView): { text: string; bg: string; fg: string } {
  switch (player.status) {
    case "winner":
      return { text: "SOLE SURVIVOR", bg: GOLD, fg: "#2b1a05" };
    case "finalist":
      return { text: "FINALIST", bg: "rgba(244, 185, 66, 0.2)", fg: GOLD };
    case "jury":
      return { text: "JURY", bg: "rgba(255, 255, 255, 0.08)", fg: "#9c8f82" };
    default:
      return player.lives === 1
        ? { text: "1 LIFE LEFT", bg: "rgba(241, 196, 15, 0.16)", fg: "#f6d55c" }
        : { text: `${player.lives} LIVES`, bg: "rgba(39, 174, 96, 0.2)", fg: "#7be09b" };
  }
}

async function tryLoadImage(mod: CanvasModule, bytes?: Buffer | null): Promise<Image | null> {
  if (!bytes) return null;
  try {
    return await mod.loadImage(bytes);
  } catch {
    return null;
  }
}

/** Draws the castaway's portrait (photo or generated) onto its own canvas. */
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
    const scale = Math.max(w / photo.width, h / photo.height);
    const sw = w / scale;
    const sh = h / scale;
    const sx = (photo.width - sw) / 2;
    const sy = (photo.height - sh) * 0.35; // favor the top, where faces usually are
    ctx.drawImage(photo, sx, sy, sw, sh, 0, 0, w, h);
    return canvas;
  }

  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, shade(color, 0.12));
  background.addColorStop(1, shade(color, -0.55));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  // Buff-style stripes
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

  // Vignette
  const vignette = ctx.createRadialGradient(w / 2, h * 0.45, w * 0.1, w / 2, h * 0.5, w * 0.95);
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
) {
  const portrait = paintPortrait(mod, castaway, color, photo, width, portraitHeight);

  ctx.save();
  if (castaway.justLost) {
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
  if (castaway.lost) {
    // The grayed-out look for a castaway who has been voted out.
    ctx.filter = "grayscale(100%) brightness(55%) contrast(90%)";
  }
  ctx.drawImage(portrait, x, y, width, portraitHeight);
  ctx.filter = "none";
  ctx.restore();

  // Border
  roundRectPath(ctx, x, y, width, portraitHeight, 12);
  ctx.lineWidth = castaway.justLost ? 4 : 3;
  ctx.strokeStyle = castaway.justLost ? RED : castaway.lost ? "#4a423b" : color;
  ctx.stroke();

  if (castaway.lost) {
    // "VOTED OUT" stamp
    ctx.save();
    ctx.translate(x + width / 2, y + portraitHeight * 0.72);
    ctx.rotate(-0.18);
    ctx.font = `${Math.round(width * 0.15)}px ${DISPLAY_FONT}`;
    const label = "VOTED OUT";
    const labelWidth = ctx.measureText(label).width;
    const stampW = labelWidth + width * 0.12;
    const stampH = width * 0.24;
    roundRectPath(ctx, -stampW / 2, -stampH / 2, stampW, stampH, 6);
    ctx.fillStyle = "rgba(20, 10, 8, 0.55)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = castaway.justLost ? RED : "rgba(224, 52, 43, 0.75)";
    ctx.stroke();
    ctx.fillStyle = castaway.justLost ? "#ff5a4f" : "rgba(235, 90, 80, 0.85)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 2);
    ctx.restore();
  } else {
    // Torch badge for a castaway still in the game
    const r = Math.max(13, width * 0.1);
    const cx = x + width - r - 8;
    const cy = y + r + 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15, 10, 8, 0.7)";
    ctx.fill();
    drawFlame(ctx, cx, cy + r * 0.12, r * 0.62);
  }

  // Name plate
  ctx.font = `${Math.round(Math.min(20, width * 0.12))}px ${TEXT_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const lines = wrapText(ctx, castaway.name, width - 8, 2);
  const lineHeight = Math.min(22, width * 0.135);
  const firstBaseline = y + portraitHeight + 22;
  lines.forEach((line, i) => {
    const baseline = firstBaseline + i * lineHeight;
    ctx.fillStyle = castaway.lost ? "#7d7268" : TEXT;
    ctx.fillText(line, x + width / 2, baseline);
    if (castaway.lost) {
      const lineWidth = ctx.measureText(line).width;
      ctx.fillRect(x + width / 2 - lineWidth / 2, baseline - lineHeight * 0.32, lineWidth, 2);
    }
  });
}

function drawAvatar(
  ctx: SKRSContext2D,
  avatar: Image | null,
  player: BoardPlayerView,
  cx: number,
  cy: number,
  r: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  if (avatar) {
    ctx.clip();
    if (player.status === "jury") ctx.filter = "grayscale(100%) brightness(70%)";
    ctx.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
    ctx.filter = "none";
  } else {
    ctx.fillStyle = player.status === "jury" ? "#4a423b" : player.color;
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `${Math.round(r * 1.1)}px ${DISPLAY_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(player.name).slice(0, 1), cx, cy + 1);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = player.status === "jury" ? "#4a423b" : player.color;
  ctx.stroke();
}

function drawCardIcon(ctx: SKRSContext2D, x: number, y: number, color: string) {
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

export async function renderBoardImage(view: BoardView): Promise<Buffer | null> {
  const mod = await loadCanvas();
  if (!mod) return null;

  const count = view.players.length;
  const columns = columnsFor(count);
  const rows = Math.ceil(count / columns);
  const panelWidth = (WIDTH - MARGIN * 2 - GAP * (columns - 1)) / columns;
  const cardWidth = Math.min(200, (panelWidth - PANEL_PAD * 2 - CARD_GAP) / 2);
  const portraitHeight = Math.round(cardWidth * 1.2);
  const panelHeight =
    PANEL_BAND + PANEL_PAD + PANEL_HEADER + 8 + portraitHeight + NAMEPLATE + PANEL_FOOTER + PANEL_PAD;
  const height =
    HEADER_HEIGHT + rows * panelHeight + (rows - 1) * GAP + FOOTER_HEIGHT + MARGIN / 2;

  const canvas = mod.createCanvas(WIDTH, Math.round(height));
  const ctx = canvas.getContext("2d");

  // Background: night sky over the fire
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

  // Header
  ctx.textAlign = "center";
  ctx.font = `56px ${DISPLAY_FONT}`;
  ctx.fillStyle = GOLD;
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 12;
  const title = view.title.toUpperCase();
  ctx.fillText(title, WIDTH / 2, 78);
  ctx.shadowBlur = 0;
  const titleWidth = ctx.measureText(title).width;
  drawFlame(ctx, WIDTH / 2 - titleWidth / 2 - 34, 58, 20);
  drawFlame(ctx, WIDTH / 2 + titleWidth / 2 + 34, 58, 20);
  ctx.font = `22px ${TEXT_FONT}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(fitText(ctx, view.subtitle, WIDTH - MARGIN * 2), WIDTH / 2, 118);

  // Preload images in parallel
  const photos = await Promise.all(
    view.players.map((player) =>
      Promise.all(player.castaways.map((c) => tryLoadImage(mod, c.image))),
    ),
  );
  const avatars = await Promise.all(
    view.players.map((player) => tryLoadImage(mod, player.avatar)),
  );

  view.players.forEach((player, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const rowCount = row === rows - 1 ? count - row * columns : columns;
    // Center a short last row
    const rowOffset = ((columns - rowCount) * (panelWidth + GAP)) / 2;
    const px = MARGIN + rowOffset + col * (panelWidth + GAP);
    const py = HEADER_HEIGHT + row * (panelHeight + GAP);
    const highlight =
      player.status === "winner" ? GOLD : player.isTurn ? GOLD : null;

    // Panel
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
    ctx.fillStyle = player.status === "jury" ? "#4a423b" : player.color;
    ctx.fillRect(px, py, panelWidth, PANEL_BAND);
    ctx.restore();
    roundRectPath(ctx, px, py, panelWidth, panelHeight, 18);
    ctx.lineWidth = highlight ? 3 : 1;
    ctx.strokeStyle = highlight ?? "rgba(255, 255, 255, 0.09)";
    ctx.stroke();

    // Player header
    const headerTop = py + PANEL_BAND + PANEL_PAD;
    const avatarR = 21;
    const avatarCx = px + PANEL_PAD + avatarR;
    const headerCy = headerTop + 24;
    drawAvatar(ctx, avatars[index], player, avatarCx, headerCy, avatarR);

    const chip = statusChip(player);
    const chipWidth = drawChip(ctx, chip.text, px + panelWidth - PANEL_PAD, headerCy, chip);
    ctx.font = `26px ${DISPLAY_FONT}`;
    ctx.textAlign = "left";
    ctx.fillStyle = player.status === "jury" ? MUTED : TEXT;
    const nameX = avatarCx + avatarR + 12;
    const nameMax = px + panelWidth - PANEL_PAD - chipWidth - 10 - nameX;
    ctx.fillText(fitText(ctx, player.name, nameMax), nameX, headerCy + 9);

    // Castaways
    const cardsTop = headerTop + PANEL_HEADER + 8;
    const cardsWidth = cardWidth * 2 + CARD_GAP;
    const cardsLeft = px + (panelWidth - cardsWidth) / 2;
    player.castaways.forEach((castaway, i) => {
      drawCastawayCard(
        mod,
        ctx,
        castaway,
        player.color,
        photos[index][i],
        cardsLeft + i * (cardWidth + CARD_GAP),
        cardsTop,
        cardWidth,
        portraitHeight,
      );
    });

    // Footer: hand size and turn / leader markers
    const footerCy = cardsTop + portraitHeight + NAMEPLATE + PANEL_FOOTER / 2;
    if (player.status !== "jury") {
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
        drawChip(ctx, "THEIR TURN", chipRight, footerCy, { bg: GOLD, fg: "#2b1a05" }, true) + 8;
    }
    if (player.isLeader) {
      drawChip(ctx, "TRIBAL LEADER", chipRight, footerCy, {
        bg: "rgba(224, 52, 43, 0.2)",
        fg: "#ff8a80",
      });
    }
  });

  // Footer
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
