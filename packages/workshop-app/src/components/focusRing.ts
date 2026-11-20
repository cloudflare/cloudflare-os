/**
 * The browser's own focus ring, in its colour, but drawn as a plain line just inside the element's
 * rounded edge: `outline: auto` traces whatever is inside too (a visually hidden label), and a line
 * outside it is cut off by a list that scrolls. For a row or a tile whose highlight is its shape.
 */
export const FOCUS_RING = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:[outline-color:-webkit-focus-ring-color]'
