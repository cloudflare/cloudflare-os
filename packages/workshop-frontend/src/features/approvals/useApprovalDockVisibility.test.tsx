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

const Probe = ({ pending }: { pending: readonly ActionLogEntry[] }) => {
  dock = useApprovalDockVisibility(pending)
  return null
}

const renderWith = (ids: number[]) => view.render(<Probe pending={ids.map(id => entry(id))} />)

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

  it('shows again once show() is called', async () => {
    await renderWith([1, 2])
    act(() => dock.hide())
    act(() => dock.show())
    expect(dock.shown).toBe(true)
  })
})
