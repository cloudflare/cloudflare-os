// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetFocus, GadgetSummary } from '@gadgets/workshop-shared/api'
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

type State = { gadget: GadgetSummary | undefined; showsGadget: boolean }

let container: HTMLDivElement
let root: Root
let state: State
// What the hook last returned.
let uiFocus: GadgetUIFocus | undefined
let paneFocus: PaneFocus | undefined
const urlFocusChange = vi.fn<(focus: GadgetFocus | null) => void>()

const Harness = () => {
  ({ uiFocus, paneFocus } = usePaneFocus({
    uiFocus: state.gadget && { anchor: undefined, onFocusChange: urlFocusChange },
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

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  state = { gadget: budget, showsGadget: true }
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
    await act(() => uiFocus!.onFocusReset!())
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
})
