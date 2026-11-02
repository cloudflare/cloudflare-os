// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ServerConfig, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../ServerConfigContext'
import {
  PeopleComposer,
  usePeopleComposer,
  withPerson,
  type ExcludedPeople,
  type StagedPerson,
} from './PeopleComposer'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type SearchUsers = (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>

// A caller reduced to what the composer needs from one: the list of people, the layer for the
// result list, and controls of its own in the field's row.
const Caller = ({ searchUsers, excluded }: { searchUsers: SearchUsers; excluded: ExcludedPeople }) => {
  const [people, setPeople] = useState<StagedPerson[]>([])
  const [resultsContainer, setResultsContainer] = useState<HTMLDivElement | null>(null)
  const composer = usePeopleComposer({
    api: { searchUsers } as unknown as RpcStub<AuthenticatedApi>,
    people,
    onPersonAdd: person => setPeople(current => withPerson(current, person)),
    onPersonRemove: person => setPeople(current => current.filter(entry => entry.id !== person.id)),
    excluded,
    pending: false,
    onSubmit: () => {},
    announce: { staged: label => `Listed ${label}.`, unstaged: label => `Unlisted ${label}.` },
  })
  return (
    <div>
      <PeopleComposer composer={composer} resultsContainer={resultsContainer}>
        <button type="button" disabled={!composer.canSubmit}>Add</button>
        <button type="button" onClick={composer.reset}>Start over</button>
      </PeopleComposer>
      <div ref={setResultsContainer} />
    </div>
  )
}

function button(rendered: HTMLElement, label: string): HTMLButtonElement {
  const found = [...rendered.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No button labelled “${label}”`)
  return found
}

// Types into the field and waits out the search debounce (200ms), so a directory lookup has had
// its chance to happen.
async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  vi.useFakeTimers()
  try {
    await act(async () => {
      setValue.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => vi.advanceTimersByTimeAsync(225))
  } finally {
    vi.useRealTimers()
  }
}

function pressEnter(input: HTMLInputElement) {
  return act(async () => input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  ))
}

describe('PeopleComposer', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
  })

  async function render(searchUsers: SearchUsers, excluded: ExcludedPeople) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={{ userSearchEnabled: true } as ServerConfig}>
        <Caller searchUsers={searchUsers} excluded={excluded} />
      </ServerConfigContext.Provider>,
    ))
    return container
  }

  it('takes typed text as an id, unsearched, when the people to exclude failed to load', async () => {
    const searchUsers = vi.fn<SearchUsers>(async () => [])
    const rendered = await render(searchUsers, { status: 'failed' })
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    expect(button(rendered, 'Add').disabled).toBe(true)

    await type(input, 'ada@example.com')

    // No suggestion is offered, since it could be someone already there; the typed text is what
    // the caller is handed.
    expect(searchUsers).not.toHaveBeenCalled()
    expect(rendered.querySelector('[role="listbox"]')).toBeNull()
    expect(button(rendered, 'Add').disabled).toBe(false)

    await pressEnter(input)
    expect(button(rendered, 'Remove ada@example.com')).toBeDefined()
    expect(input.value).toBe('')
  })

  it('starts the field over on reset and leaves the chips to the caller', async () => {
    const rendered = await render(async () => [], { status: 'failed' })
    const input = rendered.querySelector<HTMLInputElement>('input[aria-label="Search people"]')!
    const notice = () => rendered.querySelector('[role="status"][aria-live]')?.textContent

    await type(input, 'ada@example.com')
    await pressEnter(input)
    await type(input, 'grace@example.com')
    expect(notice()).toBe('Listed ada@example.com.')

    await act(async () => button(rendered, 'Start over').click())

    expect(input.value).toBe('')
    expect(notice()).toBe('')
    expect(button(rendered, 'Add').disabled).toBe(false)
    expect(button(rendered, 'Remove ada@example.com')).toBeDefined()
  })
})
