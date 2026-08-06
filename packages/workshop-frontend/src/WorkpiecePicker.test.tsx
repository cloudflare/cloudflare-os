// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import WorkpiecePicker from './WorkpiecePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('WorkpiecePicker', () => {
  let root: Root | undefined

  afterEach(() => act(() => root?.unmount()))

  async function render(expanded: boolean) {
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkpiecePicker
        gadgets={[
          { id: 1, type: 'gadget', title: 'Hooked' },
          { id: 2, type: 'gadget', title: 'Ordinary' },
        ]}
        selectedId={null}
        expanded={expanded}
        hookedGadgetIds={new Set([1])}
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
        onSelect={vi.fn<(id: number) => void>()}
        onRename={vi.fn<(id: number, title: string) => void>()}
        pendingActivityCount={0}
        onOpenActivity={vi.fn<() => void>()}
      />,
    ))
    return container
  }

  // `role="img"` is what makes the label reachable; a bare span would be named nothing.
  const HOOK_BADGE = '[role="img"][aria-label="Hooks enabled"]'

  it('names the badge only on gadgets with an enabled hook', async () => {
    const container = await render(true)
    const labelled = container.querySelectorAll(HOOK_BADGE)

    expect(labelled).toHaveLength(1)
    expect(labelled[0].closest('button')?.textContent).toContain('Hooked')
  })

  it('keeps the badge named when collapsed, where no title is rendered', async () => {
    const container = await render(false)

    expect(container.textContent).not.toContain('Hooked')
    expect(container.querySelectorAll(HOOK_BADGE)).toHaveLength(1)
  })
})
