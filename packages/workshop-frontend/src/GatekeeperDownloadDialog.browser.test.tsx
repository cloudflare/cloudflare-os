/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import GatekeeperDownloadDialog from './GatekeeperDownloadDialog'
import './styles.css'

let root: Root | undefined
let container: HTMLElement | undefined
afterEach(() => { act(() => root?.unmount()); container?.remove() })

it('announces the trusted download explanation with the real Kumo dialog', async () => {
  const decide = vi.fn<(accepted: boolean) => void>()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(<GatekeeperDownloadDialog onDecision={decide} />))
  const dialog = page.getByRole('dialog', {name: 'Download file?'})
  await expect.element(dialog).toHaveAccessibleDescription('This service wants to download a file to your device.')
  await userEvent.click(page.getByRole('button', {name: 'Download', exact: true}))
  expect(decide).toHaveBeenCalledExactlyOnceWith(true)
})
