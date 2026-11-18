// Where a configurator's frame is drawn (`ResourceConfiguratorFrame`). The frame is fixed to the
// window, over the room kept for it in what it is in, so that a menu in it can draw past what it is
// in, as a select's would, which a frame laid out in a scrolled dialog cannot. What it is in still
// clips it, by `clip-path`, except for that menu.

/** A box in the window, as `getBoundingClientRect` gives it. */
export type Box = { top: number; right: number; bottom: number; left: number }

/** How far past the room kept for it an open menu may draw: the runtime's menus are at most 240px tall, just under their field. */
export const MAX_MENU_OVERFLOW = 320

// A frame draws a little past its form (the runtime's margin), which is not a menu.
const MENU_THRESHOLD = 8

export type FramePlacement = {
  top: number
  left: number
  width: number
  /** As `clip-path` takes it: what is cut off each side. */
  clip: Box
}

/**
 * Where the frame goes, over `room` (the room kept for it, which is `layout` tall once its form is
 * drawn), as tall as it draws (`drawn`) and cut to what scrolls it (`bounds`). A menu drawn past its
 * form, while the form's end is in sight, may go past `bounds` by a menu's height, but never past
 * the window; anything else past the room is the form growing into it, and is cut off there.
 */
export const placeFrame = ({ room, bounds, drawn, layout, windowHeight }: { room: Box; bounds: Box; drawn: number; layout: number; windowHeight: number }): FramePlacement => {
  const formEnd = room.top + layout
  const menuOpen = drawn > layout + MENU_THRESHOLD && formEnd <= bounds.bottom + 1
  const end = menuOpen ? Math.min(formEnd + MAX_MENU_OVERFLOW, bounds.bottom + MAX_MENU_OVERFLOW, windowHeight) : Math.min(room.bottom, bounds.bottom)
  return {
    top: room.top,
    left: room.left,
    width: room.right - room.left,
    clip: {
      top: Math.max(0, bounds.top - room.top),
      right: Math.max(0, room.right - bounds.right),
      bottom: Math.max(0, room.top + drawn - end),
      left: Math.max(0, bounds.left - room.left),
    },
  }
}
