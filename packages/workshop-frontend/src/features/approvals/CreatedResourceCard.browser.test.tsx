/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { TooltipProvider } from '@cloudflare/kumo'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { CreatedResourceCard } from './CreatedResourceCard'
import '../../styles.css'

let host: HTMLDivElement | undefined, root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

it('says why saving is disabled when the pointer is over it', async () => {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  const creation = { type: 'action', id: 1, state: 'pending', resourceTitle: 'Trip plan' } as
    ActionLogEntry & { type: 'action' }
  await act(async () => root!.render(
    <TooltipProvider>
      <CreatedResourceCard creation={creation} processing={false} onSave={() => {}} onDeny={() => {}} />
    </TooltipProvider>,
  ))
  const save = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.trim() === 'Save to account')!
  expect(save.disabled).toBe(true)

  await act(async () => { await userEvent.hover(save.parentElement!) })
  await expect.poll(() => document.body.textContent).toContain('Accept changes first')
})
