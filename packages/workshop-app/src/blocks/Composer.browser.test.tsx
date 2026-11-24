/* eslint-disable react/react-in-jsx-scope */
// The composer's draft, in Chromium: where the focus and the cursor are as it is written in, given
// things and sent, which is the browser's own doing in an editor and nothing jsdom has.

import type { Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { Composer, type ComposerHandle, type ComposerProps } from './Composer'
import type { ComposerCommand } from './composerCommand'
import type { ComposerConnection } from './ComposerConnectionLines'
// As the app draws it: how a draft keeps its spaces, for one, is its styles' doing.
import '@/styles.css'

const plan: ComposerConnection = { key: 'plan', title: 'Q3 plan', kind: 'Doc', service: { name: 'Google' } }
const repo: ComposerConnection = { key: 'repo', title: 'cloudflare/gadgets', kind: 'Repository', service: { name: 'GitHub' } }
const brief: ComposerCommand = { key: 'brief', name: 'meeting-brief', title: 'Meeting Brief', description: 'Before a meeting.', kind: 'skill' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
})

const render = async (props: Partial<ComposerProps> & { ref?: Ref<ComposerHandle> }) => {
  const onSend = vi.fn<ComposerProps['onSend']>(props.onSend ?? (() => true))
  root.render(<Composer {...props} onSend={onSend} />)
  await expect.poll(() => {
    field()?.focus()
    return focused()
  }).toBe('Message')
  return onSend
}

// Nothing here waits on React by hand: what the page comes to is asked until it has (`expect.poll`).
const field = () => container.querySelector<HTMLElement>('[aria-label="Message"]')
const focused = () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName
// What the draft's words are: what is in it besides its pills.
const words = () => [...(field()?.childNodes ?? [])].filter((node) => !(node instanceof HTMLElement && node.dataset.billowItem)).map((node) => node.textContent).join('').replaceAll('\u200b', '')
// Its pills, each by its name.
const pills = () => [...(field()?.querySelectorAll('[data-billow-item] .chip-name') ?? [])].map((name) => name.textContent)
const type = (keys: string) => userEvent.keyboard(keys)

it('keeps the focus while a message is on its way, and is ready for the next once it has gone', async () => {
  let went!: (went: boolean) => void
  const onSend = await render({ onSend: () => new Promise<boolean>((resolve) => (went = resolve)) })
  await type('hello there{Enter}')
  await expect.poll(() => onSend.mock.calls).toEqual([['hello there', [], undefined, undefined]])
  // Not written in meanwhile, nor left.
  await type('lost')
  await expect.poll(words).toBe('hello there')
  await expect.poll(focused).toBe('Message')
  went(true)
  await expect.poll(words).toBe('')
  await expect.poll(focused).toBe('Message')
  await type('next')
  await expect.poll(words).toBe('next')
})

it('leaves a message that did not go as it was, to send again', async () => {
  const onSend = await render({ onSend: async () => false })
  await type('hello{Enter}')
  await expect.poll(words).toBe('hello')
  await expect.poll(focused).toBe('Message')
  await type(' again{Enter}')
  await expect.poll(() => onSend.mock.lastCall).toEqual(['hello again', [], undefined, undefined])
})

it('lets go of what went, and keeps what the draft was given meanwhile', async () => {
  let went!: (went: boolean) => void
  const composer: { current: ComposerHandle | null } = { current: null }
  const onSend = await render({ ref: composer, onSend: () => new Promise<boolean>((resolve) => (went = resolve)) })
  composer.current!.addConnection(plan)
  await type('read it{Enter}')
  await expect.poll(() => onSend.mock.calls).toEqual([['read it', [], undefined, [plan]]])
  composer.current!.addConnection(repo)
  went(true)
  await expect.poll(words).toBe('')
  await expect.poll(pills).toEqual(['cloudflare/gadgets'])
})

it('keeps what is written after the pills, and takes the last pill off by Backspace at the start of the words', async () => {
  const composer: { current: ComposerHandle | null } = { current: null }
  const onSend = await render({ ref: composer })
  composer.current!.addConnection(plan)
  composer.current!.addConnection(repo)
  await type('two')
  // As far towards the start as the cursor goes is the start of the words. By the arrow keys,
  // as Home is not a key that moves the cursor on every system.
  await type('{ArrowLeft>8/}one ')
  await expect.poll(words).toBe('one two')
  await expect.poll(pills).toEqual(['Q3 plan', 'cloudflare/gadgets'])
  await type('{ArrowLeft>8/}{Backspace}')
  await expect.poll(pills).toEqual(['Q3 plan'])
  await expect.poll(words).toBe('one two')
  await type('{Enter}')
  await expect.poll(() => onSend.mock.calls).toEqual([['one two', [], undefined, [plan]]])
})

it('opens the add menu at a slash, and gives what was typed back to the draft when it finds nothing', async () => {
  const onSend = await render({ commands: [brief] })
  await type('/')
  await expect.poll(focused).toBe('Search what to add')
  // A space straight away: the slash was meant as one.
  await type(' ')
  await expect.poll(focused).toBe('Message')
  await type('4')
  await expect.poll(words).toBe('/ 4')
  await type('{Enter}')
  await expect.poll(() => onSend.mock.calls).toEqual([['/ 4', [], undefined, undefined]])
})

it('writes a path straight through, whatever the add menu makes of its start', async () => {
  const onSend = await render({ commands: [brief] })
  await type('/usr/bin')
  await expect.poll(focused).toBe('Message')
  await expect.poll(words).toBe('/usr/bin')
  await type('{Enter}')
  await expect.poll(() => onSend.mock.calls).toEqual([['/usr/bin', [], undefined, undefined]])
})

it('sends with the skill chosen after a slash, which then goes from the words', async () => {
  const onSend = await render({ commands: [brief] })
  await type('/')
  await expect.poll(focused).toBe('Search what to add')
  await type('meeting')
  await type('{Enter}')
  await expect.poll(pills).toEqual(['Meeting Brief'])
  await expect.poll(focused).toBe('Message')
  await expect.poll(words).toBe('')
  await type('for Tuesday{Enter}')
  await expect.poll(() => onSend.mock.calls).toEqual([['for Tuesday', [], brief, undefined]])
})
