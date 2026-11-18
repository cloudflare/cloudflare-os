import { describe, expect, it } from 'vitest'
import { MAX_MENU_OVERFLOW, placeFrame } from './framePlacement'

// A dialog's scrolled body, and the room for a form 200px tall at its top.
const bounds = { top: 100, right: 600, bottom: 500, left: 100 }
const room = (top: number, height = 200) => ({ top, right: 600, bottom: top + height, left: 100 })

describe('placeFrame', () => {
  it('lays the frame over its room, cut to it', () => {
    expect(placeFrame({ room: room(120), bounds, drawn: 208, layout: 200, windowHeight: 900 })).toEqual({
      top: 120, left: 100, width: 500, clip: { top: 0, right: 0, bottom: 8, left: 0 },
    })
  })

  it('cuts off what has scrolled out of what it is in', () => {
    const { clip } = placeFrame({ room: room(50), bounds, drawn: 200, layout: 200, windowHeight: 900 })
    expect(clip).toEqual({ top: 50, right: 0, bottom: 0, left: 0 })
    expect(placeFrame({ room: room(400), bounds, drawn: 200, layout: 200, windowHeight: 900 }).clip.bottom).toBe(100)
  })

  it('lets an open menu draw past what it is in by a menu, and never past the window', () => {
    // The form ends at 420, in sight, and its menu draws on to 720.
    expect(placeFrame({ room: room(220), bounds, drawn: 500, layout: 200, windowHeight: 900 }).clip.bottom).toBe(0)
    const tall = placeFrame({ room: room(220), bounds, drawn: 1000, layout: 200, windowHeight: 900 })
    expect(220 + 1000 - tall.clip.bottom).toBe(Math.min(420 + MAX_MENU_OVERFLOW, 500 + MAX_MENU_OVERFLOW))
    const short = placeFrame({ room: room(220), bounds, drawn: 500, layout: 200, windowHeight: 600 })
    expect(220 + 500 - short.clip.bottom).toBe(600)
  })

  it('keeps a menu in what it is in while the end of its form is out of sight', () => {
    // The form ends at 550, past the body's end at 500.
    const { clip } = placeFrame({ room: room(150, 400), bounds, drawn: 700, layout: 400, windowHeight: 900 })
    expect(150 + 700 - clip.bottom).toBe(500)
  })

  it('shows no more of a growing form than its room has grown to', () => {
    const { clip } = placeFrame({ room: room(120, 24), bounds, drawn: 208, layout: 200, windowHeight: 900 })
    expect(120 + 208 - clip.bottom).toBe(144)
  })
})
