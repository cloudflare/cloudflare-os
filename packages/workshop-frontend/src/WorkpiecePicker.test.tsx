// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import WorkpiecePicker from './WorkpiecePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GADGETS: GadgetSummary[] = [
  { id: 1, type: 'gadget', title: 'Hooked' },
  { id: 2, type: 'gadget', title: 'Ordinary' },
]

// `role="img"` is what makes the label reachable; a bare span would be named nothing.
const HOOK_BADGE = '[role="img"][aria-label="Hooks enabled"]'

// Right-clicks `target` and picks Delete from the menu that opens.
const chooseDelete = async (target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(menuItem => menuItem.textContent === 'Delete')!
  await act(async () => item.click())
}

describe('WorkpiecePicker', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = undefined
    host = undefined
  })

  async function render({
    expanded = true,
    onDelete = vi.fn<(gadget: GadgetSummary) => void>(),
  }: {
    expanded?: boolean
    onDelete?: (gadget: GadgetSummary) => void
  } = {}) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(
      <WorkpiecePicker
        gadgets={GADGETS}
        worktrees={[]}
        selectedId={null}
        expanded={expanded}
        hookedGadgetIds={new Set([1])}
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
        onSelect={vi.fn<(id: number) => void>()}
        onRename={vi.fn<(id: number, title: string) => void>()}
        onDelete={onDelete}
        pendingActivityCount={0}
        onOpenActivity={vi.fn<() => void>()}
      />,
    ))
    return host
  }

  const rowButton = (title: string) => [...host!.querySelectorAll('button')]
    .find(button => button.textContent?.includes(title))!

  it('names the badge only on gadgets with an enabled hook', async () => {
    const container = await render()
    const labelled = container.querySelectorAll(HOOK_BADGE)

    expect(labelled).toHaveLength(1)
    expect(labelled[0].closest('button')?.textContent).toContain('Hooked')
  })

  it('keeps the badge named when collapsed, where no title is rendered', async () => {
    const container = await render({ expanded: false })

    expect(container.textContent).not.toContain('Hooked')
    expect(container.querySelectorAll(HOOK_BADGE)).toHaveLength(1)
  })

  it('asks to delete a gadget from its right-click menu', async () => {
    const onDelete = vi.fn<(gadget: GadgetSummary) => void>()
    await render({ onDelete })

    await chooseDelete(rowButton('Ordinary'))

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(GADGETS[1])
  })

  it('offers the menu on the collapsed rail too', async () => {
    const onDelete = vi.fn<(gadget: GadgetSummary) => void>()
    const container = await render({ expanded: false, onDelete })

    // Collapsed rows show no title; find the row by its badge instead.
    await chooseDelete(container.querySelector(HOOK_BADGE)!)

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(GADGETS[0])
  })
})
