// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { GatekeeperSettings } from './GatekeeperSettings'
import {
  SettingsPanel, webSearchSettings as webSearch, type Setting,
} from './gatekeeperSettingsTestHarness'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

const render = async (node: React.ReactNode) => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root?.render(node) })
}

const show = async (settings: Setting[], saving = false) => {
  const onChoose = vi.fn<(settingId: string, value: string) => void>()
  await render(
    <GatekeeperSettings vendorName="Web Search" settings={settings} saving={saving} onChoose={onChoose} />)
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

it('holds every other select while a pick is saved, and takes no second pick from that one', async () => {
  const save = Promise.withResolvers<void>()
  const onSave = vi.fn<(settingId: string, value: string) => Promise<void>>(() => save.promise)
  await render(<SettingsPanel initial={webSearch('ceramic')} onSave={onSave} />)
  const provider = () => select('Search provider for Web Search')
  const fallback = () => select('Fallback search provider for Web Search')

  await choose(provider(), 'The model’s provider')
  expect(provider().hasAttribute('disabled')).toBe(false)
  expect(fallback().hasAttribute('disabled')).toBe(true)
  await choose(provider(), 'Linkup')
  expect(onSave.mock.calls).toEqual([['provider', 'model']])

  await act(async () => { save.resolve() })
  expect(fallback().hasAttribute('disabled')).toBe(false)
  await choose(fallback(), 'Ceramic')
  expect(onSave.mock.calls).toEqual([['provider', 'model'], ['fallback', 'ceramic']])
})

it('holds every select while another change to the gatekeeper is saved, one picked from earlier too', async () => {
  const settings = webSearch('model')
  const onChoose = await show(settings)
  await choose(select('Search provider for Web Search'), 'Linkup')
  expect(onChoose).toHaveBeenCalledOnce()

  await act(async () => {
    root?.render(
      <GatekeeperSettings vendorName="Web Search" settings={settings} saving onChoose={onChoose} />)
  })
  expect(selects().map((element) => element.hasAttribute('disabled'))).toEqual([true, true])
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
