// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { entry, makeTestRoot } from '../../action-test-harness'
import { useApprovalDockVisibility } from './useApprovalDockVisibility'

const view = makeTestRoot()

afterEach(() => view.cleanup())

let dock: ReturnType<typeof useApprovalDockVisibility>

const Probe = ({ pending, workspaceId }: { pending: readonly ActionLogEntry[], workspaceId: string }) => {
  dock = useApprovalDockVisibility(pending, workspaceId)
  return null
}

const renderWith = (ids: number[], workspaceId = 'a') =>
  view.render(<Probe pending={ids.map(id => entry(id))} workspaceId={workspaceId} />)

describe('useApprovalDockVisibility', () => {
  it('is shown while requests are pending', async () => {
    await renderWith([1, 2])
    expect(dock.shown).toBe(true)
  })

  it('is never shown with nothing pending', async () => {
    await renderWith([])
    expect(dock.shown).toBe(false)
    act(() => dock.show())
    expect(dock.shown).toBe(false)
  })

  it('hides until a newer request arrives', async () => {
    await renderWith([1, 2])
    act(() => dock.hide())
    expect(dock.shown).toBe(false)

    await renderWith([1, 2, 3])
    expect(dock.shown).toBe(true)
  })

  it('stays hidden while requests are resolved', async () => {
    await renderWith([1, 2, 3])
    act(() => dock.hide())
    await renderWith([2, 3])
    expect(dock.shown).toBe(false)
    await renderWith([3])
    expect(dock.shown).toBe(false)
  })

  it('hides only in the workspace it was hidden in', async () => {
    await renderWith([100])
    act(() => dock.hide())
    // Another workspace numbers its actions from the start.
    await renderWith([1, 2], 'b')
    expect(dock.shown).toBe(true)
    await renderWith([100], 'a')
    expect(dock.shown).toBe(false)
  })

  it('shows again once show() is called', async () => {
    await renderWith([1, 2])
    act(() => dock.hide())
    act(() => dock.show())
    expect(dock.shown).toBe(true)
  })
})
