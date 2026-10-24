// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contrastRatio, highlightColorFor, HIGHLIGHT_ACCENT, slideBackdrop } from "../files/lib/highlight.ts";
import { deckLogoBox, isEmptyLogoSlot, isLogoImageData, logoAlt, logoBlockBox, logoShowsOn, newLogoBlockBox } from "../files/lib/logo.ts";
import { clampView, isFit, stepScale, wheelZoomFactor, zoomAt, type ZoomView } from "../files/lib/zoom.ts";
import type { DeckLogo, Slide } from "../files/lib/protocol.ts";

// The pure rules the browser renderer and the PowerPoint export share: where logos go, which
// colour a title highlight gets, and the editor's zoom math.

const COVER = { color: "#F6821F", inset: false, coverOrange: true };
const slide = (background: Slide["background"]): Slide => ({ id: "s", background, blocks: [] });
// The slide point under a screen point (relative to the stage's centre).
const at = (view: ZoomView, x: number, y: number) => [(x - view.panX) / view.scale, (y - view.panY) / view.scale];
const WHITE = { color: "#FFFFFF", inset: false, dotGrid: 0 };

describe("title highlight colour", () => {
  it("keeps the accent where it reads well, as on white content slides", () => {
    expect(highlightColorFor(WHITE, "#000000")).toBe(HIGHLIGHT_ACCENT);
    expect(highlightColorFor({ color: "#000000", inset: false }, "#FFFFFF")).toBe(HIGHLIGHT_ACCENT);
  });

  it("picks black for a white title on the orange cover, where the accent all but vanishes", () => {
    expect(contrastRatio(HIGHLIGHT_ACCENT, slideBackdrop(COVER))).toBeLessThan(1.5);
    const color = highlightColorFor(COVER, "#FFFFFF");
    expect(color).toBe("#000000");
    expect(contrastRatio(color, slideBackdrop(COVER))).toBeGreaterThanOrEqual(3);
  });

  it("goes by the slide's own colour, and never picks the title's own colour", () => {
    // A slide painted in the accent: white text gets black, black text gets white.
    expect(highlightColorFor({ color: "#FF5F2E", inset: false }, "#FFFFFF")).toBe("#000000");
    expect(highlightColorFor({ color: "#1A1A1A", inset: false }, "#FFFFFF")).toBe(HIGHLIGHT_ACCENT);
    expect(highlightColorFor({ color: "#FF5F2E", inset: false }, "#000000")).toBe("#FFFFFF");
  });

  it("reads the backdrop as the inset surface when it is on", () => {
    expect(slideBackdrop({ color: "#000000" })).toBe("#FFF9EF");
    expect(slideBackdrop(undefined)).toBe("#FFF9EF");
    expect(slideBackdrop({ color: "not a colour", inset: false })).toBe("#F5F1EB");
  });
});

describe("logos", () => {
  const logo: DeckLogo = { src: "data:image/png;base64,AAAA", position: "top-right", onCover: true };

  it("places the deck logo in each corner, the same size, pinned to that corner", () => {
    expect(deckLogoBox("top-left")).toEqual({ x: 36, y: 28, w: 140, h: 40, objectPosition: "left top" });
    expect(deckLogoBox("top-right")).toEqual({ x: 1024, y: 28, w: 140, h: 40, objectPosition: "right top" });
    expect(deckLogoBox("bottom-left")).toEqual({ x: 36, y: 607, w: 140, h: 40, objectPosition: "left bottom" });
    expect(deckLogoBox("bottom-right")).toEqual({ x: 1024, y: 607, w: 140, h: 40, objectPosition: "right bottom" });
  });

  it("shows the deck logo on every slide, and on covers unless they are left out", () => {
    expect(logoShowsOn(logo, slide(WHITE))).toBe(true);
    expect(logoShowsOn(logo, slide(COVER))).toBe(true);
    expect(logoShowsOn({ ...logo, onCover: false }, slide(COVER))).toBe(false);
    expect(logoShowsOn({ ...logo, onCover: false }, slide(WHITE))).toBe(true);
    expect(logoShowsOn(null, slide(WHITE))).toBe(false);
  });

  it("takes PNG, JPEG and SVG data only", () => {
    expect(isLogoImageData("data:image/png;base64,AAAA")).toBe(true);
    expect(isLogoImageData("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isLogoImageData("data:image/svg+xml;utf8,<svg/>")).toBe(true);
    expect(isLogoImageData("data:image/gif;base64,AAAA")).toBe(false);
    expect(isLogoImageData("https://example.com/logo.png")).toBe(false);
  });

  it("sizes a logo block's picture by its box, else the deck logo's box times its scale", () => {
    expect(logoBlockBox({ x: 10, y: 20, props: { scale: 0.5 } })).toEqual({ x: 10, y: 20, w: 70, h: 20, objectPosition: "left center" });
    expect(logoBlockBox({ x: 10, y: 20, w: 200, h: 50, props: { align: "right" } })).toEqual({ x: 10, y: 20, w: 200, h: 50, objectPosition: "right center" });
  });

  it("puts a new logo block in the top-right corner, or the next one clear of the deck logo", () => {
    expect(newLogoBlockBox()).toEqual({ x: 1024, y: 28, w: 140, h: 40, align: "right" });
    expect(newLogoBlockBox("top-left")).toEqual({ x: 1024, y: 28, w: 140, h: 40, align: "right" });
    expect(newLogoBlockBox("top-right")).toEqual({ x: 1024, y: 607, w: 140, h: 40, align: "right" });
  });

  it("tells an empty slot from an unnamed wordmark", () => {
    expect(isEmptyLogoSlot({ text: "", src: "" })).toBe(true);
    expect(isEmptyLogoSlot({ text: "  " })).toBe(true);
    expect(isEmptyLogoSlot({})).toBe(false);
    expect(isEmptyLogoSlot({ text: "Acme" })).toBe(false);
    expect(isEmptyLogoSlot({ text: "", src: "asset:abc" })).toBe(false);
    expect(logoAlt("")).toBe("Logo");
    expect(logoAlt(" Acme ")).toBe("Acme");
  });
});

describe("zoom", () => {
  const viewport = { w: 1120, h: 647.5 };
  const fit = 0.9;

  it("keeps the slide point under the fingers where it is", () => {
    const start = { scale: fit, panX: 0, panY: 0 };
    const anchor = { x: -480, y: -50 };
    let view = start;
    for (let i = 0; i < 20; i++) view = zoomAt(view, view.scale * wheelZoomFactor(-8), anchor, fit, viewport);
    expect(view.scale).toBeGreaterThan(1.5);
    const [x0, y0] = at(start, anchor.x, anchor.y), [x1, y1] = at(view, anchor.x, anchor.y);
    expect(x1).toBeCloseTo(x0, 6);
    expect(y1).toBeCloseTo(y0, 6);
  });

  it("never goes below fit or past 400%, and lands centred at fit", () => {
    const zoomed = zoomAt({ scale: fit, panX: 0, panY: 0 }, 3, { x: 400, y: 200 }, fit, viewport);
    expect(zoomed.scale).toBe(3);
    expect(zoomAt(zoomed, 99, { x: 0, y: 0 }, fit, viewport).scale).toBe(4);
    const back = zoomAt(zoomed, 0.1, { x: 400, y: 200 }, fit, viewport);
    expect(back).toEqual({ scale: fit, panX: 0, panY: 0 });
    expect(isFit(back.scale, fit)).toBe(true);
  });

  it("keeps the slide on screen however far it is panned", () => {
    const view = clampView({ scale: 2, panX: 1e6, panY: -1e6 }, fit, viewport);
    const halfW = 1200 * 2 / 2, halfH = 675 * 2 / 2;
    // The slide's left edge stays left of the stage's middle; its bottom below the stage's middle.
    expect(view.panX - halfW).toBeLessThan(0);
    expect(view.panY + halfH).toBeGreaterThan(0);
    // ...and at most the margin past the fitted slide's edge.
    expect(view.panX - halfW).toBeLessThanOrEqual(-1200 * fit / 2 + 48);
  });

  it("steps through the zoom levels and back to fit", () => {
    expect(stepScale(fit, fit, 1)).toBe(1);
    expect(stepScale(1, fit, 1)).toBe(1.25);
    expect(stepScale(4, fit, 1)).toBe(4);
    expect(stepScale(1.25, fit, -1)).toBe(1);
    expect(stepScale(1, fit, -1)).toBe(fit);
    expect(stepScale(1.1, fit, -1)).toBe(1);
  });

  it("zooms in on a pinch out, and caps a big mouse-wheel notch", () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(-1000)).toBeCloseTo(Math.exp(0.3), 6);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(Math.exp(0.3), 6);
  });
});
