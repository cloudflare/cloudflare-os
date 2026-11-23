// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkpieceId } from '@gadgets/workshop-shared/api'
import type { GadgetUIFocus } from '../../GadgetUI'
import { FOCUS_URL_WRITE_DELAY_MS, useFocusUrl, withWorkpiece } from './useFocusUrl'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type Search = { w?: WorkpieceId; at?: string }
type State = {
  workspaceId: string
  search: Search
  selectedGadgetId: WorkpieceId | null
  selectionSettled: boolean
}

let container: HTMLDivElement
let root: Root
let state: State
// The focus the hook last gave the selected gadget's GadgetUI.
let focus: GadgetUIFocus | undefined
const replaceSearch = vi.fn<(changes: Search) => void>()

const Harness = () => {
  focus = useFocusUrl({
    workspaceId: state.workspaceId,
    urlWorkpieceId: state.search.w ?? null,
    at: state.search.at,
    selectedGadgetId: state.selectedGadgetId,
    selectionSettled: state.selectionSettled,
    replaceSearch: changes => {
      replaceSearch(changes)
      state = { ...state, search: { ...state.search, ...changes } }
    },
  })
  return null
}

const render = async (changes: Partial<State>) => {
  state = { ...state, ...changes }
  await act(async () => root.render(<Harness />))
}

beforeEach(() => {
  vi.useFakeTimers()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  state = { workspaceId: 'trips', search: {}, selectedGadgetId: 1, selectionSettled: true }
  replaceSearch.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useFocusUrl', () => {
  it('writes a report to `at` with `w` at once, and only the last of a burst after it', async () => {
    await render({})
    focus!.onFocusChange({ anchor: 'cell/B5', label: 'B5' })
    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B5' }]])

    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS / 2)
    focus!.onFocusChange({ anchor: 'cell/B6', label: 'B6' })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    expect(replaceSearch).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS / 2)
    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B5' }], [{ w: 1, at: 'cell/B7' }]])
    await render({})

    // That write holds back reports in turn, until they pause.
    focus!.onFocusChange({ anchor: 'cell/B8', label: 'B8' })
    expect(replaceSearch).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    expect(replaceSearch).toHaveBeenLastCalledWith({ w: 1, at: 'cell/B8' })
    await render({})

    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    expect(replaceSearch).toHaveBeenCalledTimes(4)
    expect(replaceSearch).toHaveBeenLastCalledWith({ w: 1, at: 'cell/C1' })
  })

  it('gives the frame `at` only for the gadget `w` names', async () => {
    await render({ search: { w: 1, at: 'cell/B7' } })
    expect(focus?.anchor).toBe('cell/B7')

    await render({ search: { w: 2, at: 'cell/B7' }, selectionSettled: false })
    expect(focus?.anchor).toBeUndefined()
  })

  it('drops `at` without a selectable `w`, once the selection has settled', async () => {
    await render({ search: { at: 'cell/B7' }, selectionSettled: false })
    expect(replaceSearch).not.toHaveBeenCalled()
    await render({ selectionSettled: true })
    expect(replaceSearch.mock.calls).toEqual([[{ at: undefined }]])
    await render({})

    replaceSearch.mockClear()
    // `w` names a workpiece that isn't the selected gadget: one that's gone, or a worktree.
    await render({ search: { w: 9, at: 'cell/B7' } })
    expect(focus?.anchor).toBeUndefined()
    expect(replaceSearch.mock.calls).toEqual([[{ at: undefined }]])
  })

  it('never lands a report pending from the previously selected gadget, nor holds back the next', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B6', label: 'B6' })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    await render({ search: { w: 2 }, selectedGadgetId: 2 })
    focus!.onFocusChange({ anchor: 'trip/t_9', label: 'Lisbon' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B6' }], [{ w: 2, at: 'trip/t_9' }]])
  })

  it('never lands a report pending from the previous workspace', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B6', label: 'B6' })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    await render({ workspaceId: 'budget' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B6' }]])
  })

  it('lets `at` set elsewhere win over a pending report', async () => {
    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange({ anchor: 'cell/C0', label: 'C0' })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({ search: { w: 1, at: 'cell/D4' } })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/C0' }]])
  })

  it('lets `at` removed elsewhere win over a pending report', async () => {
    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange({ anchor: 'cell/C0', label: 'C0' })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({ search: { w: 1 } })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/C0' }]])
  })

  it('lets `at` set elsewhere back to an anchor it wrote win over a pending report', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    await render({})
    await render({ search: { w: 1, at: 'cell/D4' } })
    // A write that leaves `at` as it is, so it expects nothing back from the URL.
    focus!.onFocusChange({ anchor: 'cell/D4', label: 'D4' })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({ search: { w: 1, at: 'cell/B7' } })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B7' }], [{ w: 1, at: 'cell/D4' }]])
  })

  it('keeps a newer report pending when its own earlier write lands', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({})
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B7' }], [{ w: 1, at: 'cell/C1' }]])
  })

  it('gives the latest anchor as the last report, ahead of the URL', async () => {
    await render({ search: { w: 1, at: 'cell/A1' } })
    expect(focus!.latestAnchor()).toBe('cell/A1')

    // Written, but not yet shown by the URL.
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    expect(focus!.latestAnchor()).toBe('cell/B7')
    // Held back by that write.
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    expect(focus!.latestAnchor()).toBe('cell/C1')
    focus!.onFocusChange(null)
    expect(focus!.latestAnchor()).toBeUndefined()

    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    await render({})
    expect(focus!.anchor).toBeUndefined()
    expect(focus!.latestAnchor()).toBeUndefined()
  })

  it('clears `at` on a null report, and leaves a URL without one alone', async () => {
    await render({})
    focus!.onFocusChange(null)
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    expect(replaceSearch).not.toHaveBeenCalled()

    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange(null)
    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: undefined }]])
  })

  it('clears `at` on a null report before its own write of one has come back', async () => {
    await render({})
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    focus!.onFocusChange(null)
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B7' }], [{ w: 1, at: undefined }]])
  })

  it("never takes the previous workspace's unacknowledged write as this one's", async () => {
    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange(null)
    // Another workspace whose URL names the same spot, before the clear has come back.
    await render({ workspaceId: 'budget', search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange(null)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: undefined }], [{ w: 1, at: undefined }]])
  })

  describe('navigation', () => {
    it('changes when the anchor is set elsewhere, and not when its own write lands', async () => {
      await render({ search: { w: 1 } })
      const { navigation } = focus!
      focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
      await render({})
      expect(focus).toMatchObject({ anchor: 'cell/B7', navigation })

      await render({ search: { w: 1, at: 'cell/D4' } })
      expect(focus).toMatchObject({ anchor: 'cell/D4', navigation: navigation + 1 })
      await render({ search: { w: 1 } })
      expect(focus).toMatchObject({ anchor: undefined, navigation: navigation + 2 })
    })

    it('changes each time the anchor is set back to a spot the frame reported on being sent there', async () => {
      await render({ search: { w: 1 } })
      const { navigation } = focus!
      // As a chip clicked in each of two messages in turn would, with the gadget reporting from
      // navigate as it is asked to.
      for (const [index, at] of ['cell/B7', 'cell/C1', 'cell/B7', 'cell/C1'].entries()) {
        await render({ search: { w: 1, at } })
        expect(focus!.navigation).toBe(navigation + index + 1)
        focus!.onFocusChange({ anchor: at, label: at })
        vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
      }
    })

    it('changes for a spot the frame reported and left before the URL showed it', async () => {
      await render({ search: { w: 1 } })
      focus!.onFocusChange({ anchor: 'cell/A1', label: 'A1' })
      await render({})
      const { navigation } = focus!
      // Held back, and the first never written.
      focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
      focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })

      await render({ search: { w: 1, at: 'cell/B7' } })
      expect(focus).toMatchObject({ anchor: 'cell/B7', navigation: navigation + 1 })
      vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
      expect(replaceSearch).toHaveBeenCalledOnce()
    })

    it("doesn't change as the anchor catches up with writes the URL was slow to show", async () => {
      await render({ search: { w: 1 } })
      const { navigation } = focus!
      focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
      focus!.onFocusChange(null)
      vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
      focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
      vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
      expect(replaceSearch).toHaveBeenCalledTimes(3)

      for (const at of ['cell/B7', undefined, 'cell/C1']) {
        await render({ search: { w: 1, at } })
        expect(focus).toMatchObject({ anchor: at, navigation })
      }
      // Once it has caught up, an earlier spot is one set elsewhere.
      await render({ search: { w: 1, at: 'cell/B7' } })
      expect(focus!.navigation).toBe(navigation + 1)
    })

    it("doesn't change when the URL skips to the last of its writes", async () => {
      await render({ search: { w: 1 } })
      const { navigation } = focus!
      focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
      focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
      vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

      await render({})
      expect(focus).toMatchObject({ anchor: 'cell/C1', navigation })
      await render({ search: { w: 1, at: 'cell/B7' } })
      expect(focus!.navigation).toBe(navigation + 1)
    })
  })

  it('gives no focus without a selected gadget', async () => {
    await render({ selectedGadgetId: null })
    expect(focus).toBeUndefined()
  })
})

describe('withWorkpiece', () => {
  it('keeps `at` for the same workpiece and drops it for another', () => {
    const search = { chat: 3, w: 1, at: 'cell/B7' }
    expect(withWorkpiece(search, 1)).toEqual(search)
    expect(withWorkpiece(search, 2)).toEqual({ chat: 3, w: 2, at: undefined })
    expect(withWorkpiece(search, undefined)).toEqual({ chat: 3, w: undefined, at: undefined })
  })
})
