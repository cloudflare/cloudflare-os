// @vitest-environment jsdom

import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ME, fakeApi, mount, person, settle, unmountAll } from '../spacesTestUtils'
import { useSpaceViewMode } from './useSpaceViewMode'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
  localStorage.clear()
})

// Shows the mode it is given, and switches to the other one when pressed.
const Probe = () => {
  const [mode, setMode] = useSpaceViewMode()
  return createElement('button', { type: 'button', onClick: () => setMode(mode === 'list' ? 'tree' : 'list') }, mode)
}

const probes = () => [...document.body.querySelectorAll('button')]
const current = () => probes().map(probe => probe.textContent)
const toggle = () => act(async () => { probes()[0]!.click() })

const render = async (user: AiChatAuthorInfo = ME, count = 1) => {
  const api = fakeApi({ whoami: async () => user })
  const view = await mount(Array.from({ length: count }, (_, index) => createElement(Probe, { key: index })), api)
  await settle()
  return view
}

describe('useSpaceViewMode', () => {
  it('starts as the list', async () => {
    await render()
    expect(current()).toEqual(['list'])
  })

  it('remembers the choice for the user, in every view of it, across a reload', async () => {
    await render(ME, 2)
    await toggle()

    expect(current()).toEqual(['tree', 'tree'])
    expect(localStorage.getItem(`space-view:${ME.id}`)).toBe('tree')

    unmountAll()
    await render()
    expect(current()).toEqual(['tree'])
  })

  it('keeps each user’s choice apart', async () => {
    await render()
    await toggle()
    unmountAll()

    await render(person('grace@example.com', 'Grace'))
    expect(current()).toEqual(['list'])
  })

  it('takes a value it did not store as the list', async () => {
    localStorage.setItem(`space-view:${ME.id}`, 'grid')
    await render()
    expect(current()).toEqual(['list'])
  })

  it('takes a choice made in another tab', async () => {
    await render()
    await act(async () => {
      localStorage.setItem(`space-view:${ME.id}`, 'tree')
      window.dispatchEvent(new StorageEvent('storage', { key: `space-view:${ME.id}` }))
    })
    expect(current()).toEqual(['tree'])
  })

  it('keeps a choice for the session when the browser refuses to store it', async () => {
    const user = person('ada@example.com', 'Ada')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    await render(user)
    expect(current()).toEqual(['list'])

    await toggle()
    expect(current()).toEqual(['tree'])
  })
})
