// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetFocus, GadgetSummary, MessageFocus } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'
import type { PaneFocus } from './paneFocus'
import { usePaneFocus } from './usePaneFocus'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const gadget = (id: number, title: string, chatId?: number) =>
  ({ type: 'gadget', id, title, chatId }) as GadgetSummary
const budget = gadget(3, 'Budget')
const trips = gadget(4, 'Trips')
const q3: GadgetFocus = { anchor: 'sheet/q3/cell/B7', label: 'Q3 › cell B7' }
const q4: GadgetFocus = { anchor: 'sheet/q4/cell/C2', label: 'Q4 › cell C2', context: 'Net revenue: 1,204,331' }
const lisbon: GadgetFocus = { anchor: 'trip/t_9', label: 'Lisbon', context: 'Flights booked, hotel pending' }

// `anchor` is the URL's `at` for the selected gadget.
type State = { gadget: GadgetSummary | undefined; anchor: string | undefined; showsGadget: boolean }

let container: HTMLDivElement
let root: Root
let state: State
// What the hook last returned.
let uiFocus: GadgetUIFocus | undefined
let paneFocus: PaneFocus | undefined
let onFocusOpened: (focus: MessageFocus) => void
const urlFocusChange = vi.fn<(focus: GadgetFocus | null) => void>()

const Harness = () => {
  ({ uiFocus, paneFocus, onFocusOpened } = usePaneFocus({
    uiFocus: state.gadget && { anchor: state.anchor, onFocusChange: urlFocusChange },
    gadget: state.gadget,
    showsGadget: state.showsGadget,
  }))
  return null
}

const render = async (changes: Partial<State>) => {
  state = { ...state, ...changes }
  await act(async () => root.render(<Harness />))
}
const report = (focus: GadgetFocus | null) => act(() => uiFocus!.onFocusChange(focus))
// What GadgetUI does as it replaces the frame or sends it to a spot it didn't report.
const reset = () => act(() => uiFocus!.onFocusReset!())
// A sent message's chip is clicked: the editor notes it, then sets `w` and `at`.
const openChip = async (focus: MessageFocus) => {
  await act(() => onFocusOpened(focus))
  await render({ gadget: focus.gadgetId === trips.id ? trips : budget, anchor: focus.spot?.anchor })
}

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  state = { gadget: budget, anchor: undefined, showsGadget: true }
  urlFocusChange.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('usePaneFocus', () => {
  it('offers the gadget whenever the pane shows one, even before or without a report', async () => {
    await render({})
    expect(paneFocus).toStrictEqual({
      focus: { gadgetId: 3, gadgetTitle: 'Budget' },
      pendingChatId: undefined,
    })

    await render({ gadget: gadget(5, 'Draft', 7) })
    expect(paneFocus?.pendingChatId).toBe(7)
  })

  it('offers nothing with activity, a worktree or nothing in the pane', async () => {
    await render({ showsGadget: false })
    expect(paneFocus).toBeUndefined()
    await render({ showsGadget: true, gadget: undefined })
    expect(paneFocus).toBeUndefined()
  })

  it('adds the spot the frame reports, and still passes the report on to the URL', async () => {
    await render({})
    await report(q3)
    expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget', spot: q3 })
    expect(urlFocusChange).toHaveBeenCalledExactlyOnceWith(q3)

    await report(null)
    expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget' })
  })

  it("drops the spot when the frame is replaced, so an old frame's label never shows", async () => {
    await render({})
    await report(q3)
    await reset()
    expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget' })
    expect(urlFocusChange).toHaveBeenCalledOnce()
  })

  it("never shows one gadget's spot on another", async () => {
    await render({})
    await report(q3)
    await render({ gadget: trips })
    expect(paneFocus?.focus).toStrictEqual({ gadgetId: 4, gadgetTitle: 'Trips' })
    await render({ gadget: budget })
    expect(paneFocus?.focus.spot).toBeUndefined()
  })

  describe('after a sent message\'s chip opens a spot', () => {
    it('offers that spot, context and all, though the gadget never reports it', async () => {
      await render({})
      await report(q3)
      await openChip({ gadgetId: 3, spot: q4 })
      // GadgetUI sends the frame to the new anchor.
      await reset()
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget', spot: q4 })
    })

    it("offers another gadget's spot across the new frame's reset", async () => {
      await render({})
      await report(q3)
      await openChip({ gadgetId: 4, spot: lisbon })
      // The old frame goes, then the new one starts and is sent to the anchor.
      await reset()
      await reset()
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 4, gadgetTitle: 'Trips', spot: lisbon })
    })

    it("lets the gadget's own report replace it", async () => {
      await render({})
      await openChip({ gadgetId: 3, spot: q4 })
      const fresh = { ...q4, context: 'Net revenue: 1,300,000' }
      await report(fresh)
      expect(paneFocus?.focus.spot).toStrictEqual(fresh)
    })

    it('drops it when the spot no longer resolves', async () => {
      await render({})
      await openChip({ gadgetId: 3, spot: q4 })
      // A false navigate reports null, which clears `at`.
      await report(null)
      await render({ anchor: undefined })
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget' })
    })

    it('drops it once the gadget is sent elsewhere without a chip, even if it comes back', async () => {
      await render({})
      await openChip({ gadgetId: 3, spot: q4 })
      await render({ anchor: 'sheet/q1/cell/A1' })
      await reset()
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget' })

      // A pasted link back to the spot isn't the chip, and the gadget hasn't said what it shows.
      await render({ anchor: q4.anchor })
      await reset()
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget' })
    })

    it('keeps it through a report from the gadget being left', async () => {
      await render({})
      await act(() => onFocusOpened({ gadgetId: 4, spot: lisbon }))
      await report(q3)
      await render({ gadget: trips, anchor: lisbon.anchor })
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 4, gadgetTitle: 'Trips', spot: lisbon })
    })

    it("leaves the frame's report standing when the chip names the spot already in the URL", async () => {
      // The URL still names q4, but the frame has since reported q3 and the write is pending.
      await render({ anchor: q4.anchor })
      await report(q3)
      await openChip({ gadgetId: 3, spot: q4 })
      expect(paneFocus?.focus.spot).toStrictEqual(q3)
    })

    it('shows the current title, not the one the message recorded', async () => {
      await render({})
      await openChip({ gadgetId: 3, spot: q4 })
      await render({ gadget: gadget(3, 'Budget 2027') })
      expect(paneFocus?.focus.gadgetTitle).toBe('Budget 2027')
    })
  })

  it('drops the reported spot when the frame is sent to one it did not report', async () => {
    await render({})
    await report(q3)
    await render({ anchor: 'sheet/q1/cell/A1' })
    await reset()
    expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget' })
  })
})
