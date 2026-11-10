// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import { DeleteGadgetDialog } from './DeleteGadgetDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GADGET: GadgetSummary = { id: 2, type: 'gadget', title: 'Ordinary' }

// An alert dialog: a destructive confirmation that an outside click mustn't dismiss.
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]')

const dialogButton = (label: string) => [...dialog()?.querySelectorAll('button') ?? []]
  .find(button => button.textContent === label)

// Mounts the dialog while there is a target and drops it once closed, as GadgetEditor does.
const Harness = ({ onDelete }: { onDelete: (id: number) => Promise<void> }) => {
  const [gadget, setGadget] = useState<GadgetSummary | null>(GADGET)
  return gadget && (
    <DeleteGadgetDialog gadget={gadget} onDelete={onDelete} onClosed={() => setGadget(null)} />
  )
}

describe('DeleteGadgetDialog', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
  })

  async function render(onDelete: (id: number) => Promise<void>) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<Harness onDelete={onDelete} />))
  }

  it('deletes the gadget once confirmed', async () => {
    const onDelete = vi.fn<(id: number) => Promise<void>>(async () => {})
    await render(onDelete)

    expect(dialog()?.textContent).toContain('Delete “Ordinary”?')
    expect(onDelete).not.toHaveBeenCalled()

    await act(async () => dialogButton('Delete')!.click())

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(2)
    expect(dialog()).toBeNull()
  })

  it('stays open and busy until the deletion settles', async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    await render(vi.fn<(id: number) => Promise<void>>(() => promise))

    await act(async () => dialogButton('Delete')!.click())

    expect(dialog()?.textContent).toContain('Delete “Ordinary”?')
    expect(dialogButton('Delete')?.disabled).toBe(true)
    expect(dialogButton('Cancel')?.disabled).toBe(true)

    await act(async () => resolve())

    expect(dialog()).toBeNull()
  })

  it('deletes nothing when cancelled', async () => {
    const onDelete = vi.fn<(id: number) => Promise<void>>(async () => {})
    await render(onDelete)

    await act(async () => dialogButton('Cancel')!.click())

    expect(dialog()).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })
})
