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
  it('writes a report to `at` with `w`, once the reports stop', async () => {
    await render({})
    focus!.onFocusChange({ anchor: 'cell/B6', label: 'B6' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS / 2)
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B7' }]])
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

  it('never lands a report pending from the previously selected gadget', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    await render({ search: { w: 2 }, selectedGadgetId: 2 })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch).not.toHaveBeenCalled()
  })

  it('never lands a report pending from the previous workspace', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    await render({ workspaceId: 'budget' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch).not.toHaveBeenCalled()
  })

  it('lets `at` set elsewhere win over a pending report', async () => {
    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({ search: { w: 1, at: 'cell/D4' } })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch).not.toHaveBeenCalled()
  })

  it('lets `at` removed elsewhere win over a pending report', async () => {
    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({ search: { w: 1 } })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch).not.toHaveBeenCalled()
  })

  it('lets `at` set elsewhere back to an anchor it wrote win over a pending report', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    await render({})
    await render({ search: { w: 1, at: 'cell/D4' } })
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({ search: { w: 1, at: 'cell/B7' } })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B7' }]])
  })

  it('keeps a newer report pending when its own earlier write lands', async () => {
    await render({ search: { w: 1 } })
    focus!.onFocusChange({ anchor: 'cell/B7', label: 'B7' })
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    focus!.onFocusChange({ anchor: 'cell/C1', label: 'C1' })
    await render({})
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)

    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: 'cell/B7' }], [{ w: 1, at: 'cell/C1' }]])
  })

  it('clears `at` on a null report, and leaves a URL without one alone', async () => {
    await render({})
    focus!.onFocusChange(null)
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    expect(replaceSearch).not.toHaveBeenCalled()

    await render({ search: { w: 1, at: 'cell/B7' } })
    focus!.onFocusChange(null)
    vi.advanceTimersByTime(FOCUS_URL_WRITE_DELAY_MS)
    expect(replaceSearch.mock.calls).toEqual([[{ w: 1, at: undefined }]])
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
