// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'
import { GatekeeperSettings } from './GatekeeperSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Setting = NonNullable<AdminResourceVendor['settings']>[number]

// Web Search's two settings, with the choices `provider` and `fallback` in effect.
const webSearch = (provider: string, fallback = 'none'): Setting[] => [
  {
    id: 'provider', label: 'Search provider', help: 'Where web searches run.',
    options: [
      { value: 'ceramic', label: 'Ceramic' }, { value: 'linkup', label: 'Linkup' },
      { value: 'exa', label: 'Exa' }, { value: 'model', label: 'The model’s provider' },
    ],
    defaultValue: 'ceramic', value: provider,
  },
  {
    id: 'fallback', label: 'Fallback search provider',
    help: 'Runs the searches that a model’s provider cannot.',
    options: [{ value: 'none', label: 'None' }, { value: 'ceramic', label: 'Ceramic' }],
    defaultValue: 'none', shownWhen: { settingId: 'provider', value: 'model' }, value: fallback,
  },
]

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

const show = async (settings: Setting[]) => {
  const onChoose = vi.fn<(settingId: string, value: string) => void>()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <GatekeeperSettings vendorName="Web Search" settings={settings} disabled={false} onChoose={onChoose} />)
  })
  return onChoose
}

const selects = () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="combobox"]'))

const select = (name: string) => {
  const element = selects().find((candidate) => candidate.getAttribute('aria-label') === name)
  if (!element) throw new Error(`No select ${name}`)
  return element
}

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom lacks,
// so the window has a stand-in for as long as the choice takes.
const choose = async (from: HTMLElement, label: string) => {
  await act(async () => { from.click() })
  const list = document.getElementById(from.getAttribute('aria-controls') ?? '')
  const option = Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    .find((element) => element.textContent === label)
  if (!option) throw new Error(`No option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    delete view.PointerEvent
  }
}

it('shows a setting only under the value of the setting it depends on', async () => {
  await show(webSearch('ceramic', 'ceramic'))
  expect(selects().map((element) => element.getAttribute('aria-label')))
    .toEqual(['Search provider for Web Search'])

  act(() => root?.unmount())
  await show(webSearch('model', 'ceramic'))
  expect(selects().map((element) => element.getAttribute('aria-label')))
    .toEqual(['Search provider for Web Search', 'Fallback search provider for Web Search'])
  expect(select('Fallback search provider for Web Search').textContent).toBe('Ceramic')
})

it('reports the option an admin picks, and not the one in effect', async () => {
  const onChoose = await show(webSearch('ceramic'))
  await choose(select('Search provider for Web Search'), 'Ceramic')
  expect(onChoose).not.toHaveBeenCalled()

  await choose(select('Search provider for Web Search'), 'The model’s provider')
  expect(onChoose).toHaveBeenCalledExactlyOnceWith('provider', 'model')
})

it('chooses nothing for a letter typed while a select is closed', async () => {
  const onChoose = await show(webSearch('ceramic'))
  const provider = select('Search provider for Web Search')
  // A focused select learns its options a moment later, and matches letters against them.
  await act(async () => { provider.focus() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

  await act(async () => {
    provider.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }))
  })

  expect(provider.getAttribute('aria-expanded')).toBe('false')
  expect(onChoose).not.toHaveBeenCalled()
})

it('shows a stored value that the gatekeeper no longer offers', async () => {
  await show(webSearch('brave'))
  expect(select('Search provider for Web Search').textContent).toContain('brave')
})
