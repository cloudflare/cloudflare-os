// Stage zoom: the pure math behind pinch, ⌘/Ctrl + wheel, ⌘/Ctrl + / − and
// two-finger panning in the editor (client.ts applies it). A view is the
// slide's on-screen scale and the offset of its centre from the stage's
// centre, in screen pixels. "Fit" is the scale that shows the whole slide;
// a view never goes below it, and the pan is clamped so the slide stays on
// screen: it can scroll as far as it has grown past its fitted size (so an
// edge comes at most a small margin past the stage's padding).

/** The slide's on-screen scale and its centre's offset from the stage's centre, in screen pixels. */
export interface ZoomView {
  scale: number;
  panX: number;
  panY: number;
}
/** The stage's size in screen pixels. */
export interface Viewport {
  w: number;
  h: number;
}

const SLIDE_W = 1200, SLIDE_H = 675;
/** The largest zoom, as a scale of the slide's own pixels (400%). */
const MAX_ZOOM = 4;
/** The zoom levels ⌘/Ctrl + and − step through (above fit). */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** How far past its edge a zoomed slide can be scrolled. */
const PAN_MARGIN = 48;
// Within this of fit, a view snaps back to fit.
const FIT_EPSILON = 1.002;

/** The scale range a view may take: fit up to 400% (or fit, on a stage bigger than that). */
function zoomRange(fit: number): [number, number] {
  return [fit, Math.max(MAX_ZOOM, fit)];
}

/** Whether a view at `scale` is (as good as) fit. */
export function isFit(scale: number, fit: number): boolean {
  return scale <= fit * FIT_EPSILON;
}

/** `view` with its scale in range and its pan clamped so the slide stays on screen. */
export function clampView(view: ZoomView, fit: number, viewport: Viewport): ZoomView {
  const [lo, hi] = zoomRange(fit);
  const scale = Math.min(hi, Math.max(lo, view.scale));
  // How far the slide has grown past its fitted size on each side: enough to
  // keep any point of it under the fingers while zooming, and (since the
  // fitted slide fits the stage) to scroll to any edge, plus a margin. It
  // shrinks to nothing at fit, so zooming out lands centred.
  const limit = (size: number, room: number) => {
    const grown = Math.max(0, (size * scale - Math.min(room, size * fit)) / 2);
    return grown + Math.min(grown, PAN_MARGIN);
  };
  const lx = limit(SLIDE_W, viewport.w), ly = limit(SLIDE_H, viewport.h);
  return {
    scale,
    panX: Math.min(lx, Math.max(-lx, view.panX)),
    panY: Math.min(ly, Math.max(-ly, view.panY)),
  };
}

/**
 * `view` zoomed to `scale`, keeping the slide point under `anchor` (relative to the stage's
 * centre, in screen pixels) where it is, then clamped.
 */
export function zoomAt(view: ZoomView, scale: number, anchor: { x: number; y: number }, fit: number, viewport: Viewport): ZoomView {
  const [lo, hi] = zoomRange(fit);
  const next = Math.min(hi, Math.max(lo, scale));
  const k = next / view.scale;
  return clampView({
    scale: next,
    panX: anchor.x - (anchor.x - view.panX) * k,
    panY: anchor.y - (anchor.y - view.panY) * k,
  }, fit, viewport);
}

/**
 * The zoom factor for one wheel event with ⌘/Ctrl held (a trackpad pinch arrives as one):
 * smooth for a pinch's small deltas, and a big mouse-wheel notch is capped so it doesn't leap.
 * Negative deltaY (pinching out, or wheeling up) zooms in.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = wheelPixels(deltaY, deltaMode);
  return Math.exp(-Math.max(-30, Math.min(30, px)) * 0.01);
}

/** A wheel event's scroll in pixels (lines and pages converted). */
export function wheelPixels(delta: number, deltaMode = 0): number {
  return deltaMode === 1 ? delta * 16 : deltaMode === 2 ? delta * 400 : delta;
}

/** The scale ⌘/Ctrl + (dir 1) or − (dir -1) goes to from `scale`: the next step past it, or fit. */
export function stepScale(scale: number, fit: number, dir: 1 | -1): number {
  const [lo, hi] = zoomRange(fit);
  const levels = [lo, ...ZOOM_STEPS.filter((s) => s > lo * FIT_EPSILON && s < hi), hi];
  if (dir > 0) return levels.find((s) => s > scale * FIT_EPSILON) ?? hi;
  return levels.toReversed().find((s) => s < scale / FIT_EPSILON) ?? lo;
}
