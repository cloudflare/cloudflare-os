// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetFocus, GadgetSummary, MessageFocus } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'
import type { PaneFocus } from './paneFocus'
import { usePaneFocus, type PaneView } from './usePaneFocus'
import { closedWorkspaceView, selectWorkpiece, type WorkspaceView } from '../workspace-pane/workspaceView'

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
type State = { gadget: GadgetSummary | undefined; anchor: string | undefined; pane: PaneView; singlePane: boolean }

let container: HTMLDivElement
let root: Root
let state: State
// What the hook last returned.
let uiFocus: GadgetUIFocus | undefined
let paneFocus: PaneFocus | undefined
let onFocusOpened: (focus: MessageFocus) => void
let onWorkspaceChange: () => void
const urlFocusChange = vi.fn<(focus: GadgetFocus | null) => void>()

const Harness = () => {
  ({ uiFocus, paneFocus, onFocusOpened, onWorkspaceChange } = usePaneFocus({
    uiFocus: state.gadget && { anchor: state.anchor, navigation: 0, latestAnchor: () => state.anchor, onFocusChange: urlFocusChange },
    gadget: state.gadget,
    pane: state.pane,
    singlePane: state.singlePane,
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
  state = { gadget: budget, anchor: undefined, pane: 'workpiece', singlePane: false }
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
      offerId: expect.any(Number),
      pendingChatId: undefined,
    })

    await render({ gadget: gadget(5, 'Draft', 7) })
    expect(paneFocus?.pendingChatId).toBe(7)
  })

  it('offers nothing with activity, a worktree or nothing in the pane', async () => {
    await render({ pane: 'activity' })
    expect(paneFocus).toBeUndefined()
    await render({ pane: 'workpiece', gadget: undefined })
    expect(paneFocus).toBeUndefined()
    await render({ pane: null, gadget: budget })
    expect(paneFocus).toBeUndefined()
  })

  describe('on a single-pane layout, where the chat tab hides the pane', () => {
    beforeEach(() => { state.singlePane = true })

    it('offers the gadget the pane showed, with the spot its frame last reported', async () => {
      await render({})
      await report(q3)
      await render({ pane: null })
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget', spot: q3 })
    })

    it('offers the spot a sent message\'s chip opened', async () => {
      await render({ pane: null })
      await openChip({ gadgetId: 3, spot: q4 })
      await render({ pane: 'workpiece' })
      await reset()
      await render({ pane: null })
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 3, gadgetTitle: 'Budget', spot: q4 })
    })

    it('offers nothing when the pane last showed activity or a worktree', async () => {
      await render({ pane: 'activity' })
      await render({ pane: null })
      expect(paneFocus).toBeUndefined()

      // The selection then moving to a gadget, with the pane still closed, doesn't show it.
      await render({ pane: 'workpiece', gadget: undefined })
      await render({ pane: null, gadget: budget })
      expect(paneFocus).toBeUndefined()
    })

    it('offers nothing for a gadget the selection moved to while the pane was closed', async () => {
      await render({})
      await render({ pane: null, gadget: trips })
      expect(paneFocus).toBeUndefined()
    })

    it('offers a gadget other than the default, shown with no `w`, once the Chat tab closes the pane', async () => {
      // The selection as the editor makes it, from the pane's view.
      const selected = (view: WorkspaceView) => {
        const id = selectWorkpiece({
          urlWorkpieceId: null,
          view,
          visibleWorkpieces: [budget, trips],
          visibleGadgets: [budget, trips],
          defaultGadgetId: budget.id,
        })
        return [budget, trips].find(g => g.id === id)
      }
      const shown = selected({ mode: 'app', appId: trips.id })
      await render({ gadget: shown })
      await report(lisbon)
      await render({ pane: null, gadget: selected(closedWorkspaceView(shown?.id ?? null)) })
      expect(paneFocus?.focus).toStrictEqual({ gadgetId: 4, gadgetTitle: 'Trips', spot: lisbon })
    })

    it('offers nothing until the pane has been open in the workspace', async () => {
      await render({ pane: null })
      expect(paneFocus).toBeUndefined()

      await render({ pane: 'workpiece' })
      // The editor resets the pane's view as it does this, in the same update.
      state = { ...state, pane: null }
      await act(async () => {
        onWorkspaceChange()
        root.render(<Harness />)
      })
      expect(paneFocus).toBeUndefined()
    })

    it('still refuses a gadget pending in another chat', async () => {
      await render({ gadget: gadget(5, 'Draft', 7) })
      await render({ pane: null })
      expect(paneFocus?.pendingChatId).toBe(7)
    })

    it('follows the layout across the breakpoint', async () => {
      await render({ pane: 'workpiece' })
      await render({ pane: null })
      expect(paneFocus?.focus.gadgetId).toBe(3)
      await render({ singlePane: false })
      expect(paneFocus).toBeUndefined()
      await render({ singlePane: true })
      expect(paneFocus?.focus.gadgetId).toBe(3)
    })
  })

  it('offers nothing beside the chat once the pane is closed, whatever it showed', async () => {
    await render({})
    await report(q3)
    await render({ pane: null })
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

  // A dismissed chip comes back for a new offer.
  describe('makes a new offer', () => {
    const offerId = () => paneFocus!.offerId

    it('for another spot, or for going between none and one, but not for the same one again', async () => {
      await render({})
      let last = offerId()
      for (const [focus, isNew] of [
        [q3, true],
        [{ ...q3, label: 'Q3 › B7', context: '1,204,331' }, false],
        [q4, true],
        [null, true],
        [null, false],
      ] as const) {
        await report(focus)
        expect(offerId() !== last).toBe(isNew)
        last = offerId()
      }
    })

    it('not for a new frame restored to the spot', async () => {
      await render({ anchor: q3.anchor })
      await report(q3)
      const last = offerId()
      await reset()
      expect(offerId()).toBe(last)
      await report(q3)
      expect(offerId()).toBe(last)
    })

    it("when a sent message's chip is opened, even for the spot already shown", async () => {
      await render({ anchor: q3.anchor })
      await report(q3)
      const last = offerId()
      await openChip({ gadgetId: 3, spot: q3 })
      expect(offerId()).not.toBe(last)
    })

    it("when the gadget moves from a spot a sent message's chip opened back to the one it reported", async () => {
      await render({})
      await report(q3)
      await openChip({ gadgetId: 3, spot: q4 })
      await reset()
      const last = offerId()
      await report(q3)
      expect(offerId()).not.toBe(last)
    })

    it("not when another gadget first reports the spot a sent message's chip opened there", async () => {
      await render({})
      await report(q3)
      await openChip({ gadgetId: 4, spot: lisbon })
      await reset()
      await reset()
      const last = offerId()
      await report(lisbon)
      expect(offerId()).toBe(last)
    })

    it('when the gadget is selected again after another', async () => {
      await render({})
      await report(q3)
      const last = offerId()
      await render({ gadget: trips })
      await render({ gadget: budget })
      expect(offerId()).not.toBe(last)
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
