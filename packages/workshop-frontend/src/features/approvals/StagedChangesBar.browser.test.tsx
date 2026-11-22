/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { Toasty, TooltipProvider } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { StagedChangesBar } from './StagedChangesBar'
import '../../styles.css'

const requests = Array.from({ length: 12 }, (_, id) => ({ id }) as ActionLogEntry)

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

let host: HTMLDivElement | undefined, root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

async function render(overseer: Partial<Overseer>, width: number) {
  host = document.body.appendChild(document.createElement('div'))
  host.style.width = `${width}px`
  root = createRoot(host)
  await act(async () => root!.render(
    <TooltipProvider><Toasty>
      <StagedChangesBar overseer={overseer as RpcStub<Overseer>} requests={requests} />
    </Toasty></TooltipProvider>,
  ))
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label)

it('keeps both decisions on the bar in the narrowest chat pane', async () => {
  // 280px is the narrowest chat pane GadgetEditor supports.
  await render({}, 280)
  const bar = host!.firstElementChild!.getBoundingClientRect()
  for (const label of ['Discard…', 'Accept changes']) {
    const rect = button(label)!.getBoundingClientRect()
    expect(rect.right).toBeLessThanOrEqual(bar.right + 1)
    expect(rect.top).toBeGreaterThanOrEqual(bar.top)
    expect(rect.bottom).toBeLessThanOrEqual(bar.bottom + 1)
  }
})

it('discards what staging holds only once confirmed', async () => {
  const discardStagedActions = vi.fn<Overseer['discardStagedActions']>(async () => {})
  await render({ discardStagedActions }, 480)

  await input(() => userEvent.click(button('Discard…')!))
  expect(document.body.textContent).toContain('Discard the held changes?')
  expect(discardStagedActions).not.toHaveBeenCalled()

  await input(() => userEvent.click(button('Discard changes')!))
  expect(discardStagedActions).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(button('Discard changes')).toBeUndefined())
})

it('leaves the held requests alone when the confirmation is cancelled', async () => {
  const discardStagedActions = vi.fn<Overseer['discardStagedActions']>(async () => {})
  await render({ discardStagedActions }, 480)

  await input(() => userEvent.click(button('Discard…')!))
  await input(() => userEvent.click(button('Cancel')!))
  await vi.waitFor(() => expect(button('Discard changes')).toBeUndefined())
  expect(discardStagedActions).not.toHaveBeenCalled()
})
