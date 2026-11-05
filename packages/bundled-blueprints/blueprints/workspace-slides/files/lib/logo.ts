// Logos: where the deck logo sits and how big it is, which slides show it,
// and how a `logo` block sizes its picture. The browser renderer (client.ts),
// the server (server.ts) and the PowerPoint export (lib/pptx.ts) all place
// logos from these numbers, so a logo lands on the same pixels everywhere.

import type { Block, DeckLogo, LogoPosition, Slide } from "./protocol.ts";

/** The corners the deck logo can sit in, in the order the editor offers them. */
export const LOGO_POSITIONS: readonly LogoPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
/** Where a deck logo set without a position goes. */
export const DEFAULT_LOGO_POSITION: LogoPosition = "top-right";
/** The alt text a logo without its own gets. */
const LOGO_ALT = "Logo";
/** The image types a logo may be: the ones PowerPoint embeds (SVG with a PNG fallback). */
export const LOGO_IMAGE_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];

// The deck logo is fitted (aspect kept) into a 140 × 40 box inset 36px from
// the side, on the content margin, and 28px from the top or bottom edge, and
// pinned to its corner within it. Top right clears the 984px headline; the
// bottom corners clear the brand bar.
const BOX_W = 140, BOX_H = 40, INSET_X = 36, INSET_Y = 28;

/** A logo's box in slide coordinates, and the CSS `object-position` that pins the picture in it. */
export interface LogoBox {
  x: number;
  y: number;
  w: number;
  h: number;
  objectPosition: string;
}

/** Whether `value` is one of the deck logo's corners. */
export function isLogoPosition(value: unknown): value is LogoPosition {
  return typeof value === "string" && (LOGO_POSITIONS as readonly string[]).includes(value);
}

/** Whether `src` is image data a logo may hold: a PNG, JPEG or SVG `data:` URI. */
export function isLogoImageData(src: string): boolean {
  const type = /^data:([^;,]*)[;,]/.exec(src.slice(0, 64))?.[1];
  return !!type && LOGO_IMAGE_TYPES.includes(type);
}

/** The deck logo's box at `position`. */
export function deckLogoBox(position: LogoPosition): LogoBox {
  const right = position.endsWith("right"), bottom = position.startsWith("bottom");
  return {
    x: right ? 1200 - INSET_X - BOX_W : INSET_X,
    y: bottom ? 675 - INSET_Y - BOX_H : INSET_Y,
    w: BOX_W,
    h: BOX_H,
    objectPosition: `${right ? "right" : "left"} ${bottom ? "bottom" : "top"}`,
  };
}

/** Whether the deck logo shows on `slide`: on every slide, except cover slides when `onCover` is off. */
export function logoShowsOn(logo: DeckLogo | null | undefined, slide: Slide): logo is DeckLogo {
  return !!logo?.src && (!slide.background?.coverOrange || logo.onCover !== false);
}

/** What a logo's picture is announced as: its own alt text, else "Logo". */
export function logoAlt(alt: unknown): string {
  return typeof alt === "string" && alt.trim() ? alt.trim() : LOGO_ALT;
}

/**
 * A `logo` block with an image: the picture is fitted into the block's box, which without a size
 * of its own is the deck logo's 140 × 40 times the block's `scale`, and pinned to the box's left
 * edge, or its right with `align: "right"`.
 */
export function logoBlockBox(block: { x?: unknown; y?: unknown; w?: number; h?: number; props?: { scale?: unknown; align?: unknown } | null }): LogoBox {
  const scale = Number(block.props?.scale) > 0 ? Number(block.props?.scale) : 1;
  return {
    x: Number(block.x) || 0,
    y: Number(block.y) || 0,
    w: block.w ?? BOX_W * scale,
    h: block.h ?? BOX_H * scale,
    objectPosition: `${block.props?.align === "right" ? "right" : "left"} center`,
  };
}

/**
 * Where the editor puts a new logo block: the deck logo's box in the top-right corner, or, when
 * the deck logo already sits there, the next free corner (bottom right, bottom left, top left),
 * with the picture pinned to the corner's side.
 */
export function newLogoBlockBox(deckLogo?: LogoPosition | null): { x: number; y: number; w: number; h: number; align: "left" | "right" } {
  const corner = (["top-right", "bottom-right", "bottom-left", "top-left"] as const).find((c) => c !== deckLogo) ?? "top-right";
  const { x, y, w, h } = deckLogoBox(corner);
  return { x, y, w, h, align: corner.endsWith("right") ? "right" : "left" };
}

/**
 * Whether a `logo` block is an empty slot: no image and an emptied wordmark. The editor shows it
 * as "Add your logo"; it draws nothing anywhere else. (A block with no `text` at all is an
 * unnamed wordmark, which shows the default name.)
 */
export function isEmptyLogoSlot(props: Block["props"] | null | undefined): boolean {
  return !props?.src && props?.text != null && !String(props.text).trim();
}
