// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useLayoutEffect, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcPromise, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { UserSearchCombobox } from './UserSearchCombobox'

vi.mock('../../components/PersonAvatar', () => ({ PersonAvatar: () => <span /> }))

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
const previousScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true, value: vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>(),
})
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  if (previousScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', previousScrollIntoView)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const ADA: UserDirectoryRecord = { id: 'ada@example.com', name: 'Ada Lovelace' }
const GRACE: UserDirectoryRecord = { id: 'grace@example.com', name: 'Grace Hopper' }
type Props = ComponentProps<typeof UserSearchCombobox>
type PlainSearch = (query: string) => Promise<UserDirectoryRecord[]>

describe('UserSearchCombobox', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function render(
    {
      search = vi.fn<PlainSearch>(async () => [ADA]),
      ...overrides
    }: Partial<Omit<Props, 'search'>> & { search?: PlainSearch } = {},
    observeRender?: (value: string) => void,
  ) {
    const onSelect = vi.fn<Props['onSelect']>()
    const onSubmit = vi.fn<Props['onSubmit']>()
    const props = {
      authenticatedApi: {} as RpcStub<AuthenticatedApi>,
      selected: false,
      inputName: 'test-people',
      search: (query: string) => new RpcPromise(search(query)),
      onSelect,
      onSubmit,
      ...overrides,
    }
    function Harness() {
      const [value, setValue] = useState('')
      // Observe the rendered consumer before passive effects clear a prior search snapshot.
      useLayoutEffect(() => { observeRender?.(value) }, [value])
      return <UserSearchCombobox {...props} value={value} onValueChange={setValue} />
    }
    await act(async () => root.render(<Harness />))
    return {
      input: container.querySelector('input')!, onSelect, onSubmit, search,
      update: async (next: Partial<Props>) => {
        Object.assign(props, next)
        await act(async () => root.render(<Harness />))
      },
    }
  }

  async function typeInto(input: HTMLInputElement, value: string, settle = true) {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    if (settle) await act(async () => vi.advanceTimersByTimeAsync(225))
  }

  async function pressKey(input: HTMLInputElement, key: string) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => { input.dispatchEvent(event) })
    return event
  }

  it('never renders, highlights, clicks, or submits results for a previous query', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const search = vi.fn<PlainSearch>(query => query === 'ada' ? Promise.resolve([ADA]) : pending.promise)
    const staleRender = vi.fn<(value: string) => void>(value => {
      if (value !== 'grace') return
      expect(container.querySelector('[role="option"]')).toBeNull()
      const input = container.querySelector('input')!
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      expect(input.getAttribute('aria-controls')).toBeNull()
      expect(input.getAttribute('aria-expanded')).toBe('false')
    })
    const { input, onSelect, onSubmit } = await render({ search }, staleRender)
    await typeInto(input, 'ada')
    const obsoleteOption = container.querySelector('[role="option"]')!
    expect(obsoleteOption.textContent).toContain('Ada Lovelace')

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(input, 'grace')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      obsoleteOption.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(staleRender).toHaveBeenCalledWith('grace')
    expect(container.textContent).not.toContain('Ada Lovelace')
    await pressKey(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    await pressKey(input, 'Enter')
    expect(onSelect).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(225))
    await act(async () => pending.resolve([GRACE]))
    const option = container.querySelector('[role="option"]')!
    expect(option.textContent).toContain('Grace Hopper')
    expect(input.getAttribute('aria-activedescendant')).toBe(option.id)
    await pressKey(input, 'Enter')
    expect(onSelect).toHaveBeenCalledWith(GRACE)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('ignores obsolete requests that finish after the current search', async () => {
    const first = deferred<UserDirectoryRecord[]>()
    const second = deferred<UserDirectoryRecord[]>()
    const { input, onSelect } = await render({ search: query => query === 'ada' ? first.promise : second.promise })
    await typeInto(input, 'ada')
    await typeInto(input, 'grace')
    await act(async () => second.resolve([GRACE]))
    await act(async () => first.resolve([ADA]))
    expect(container.textContent).not.toContain('Ada Lovelace')
    await act(async () => {
      container.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith(GRACE)
  })

  it('dismisses on Escape without clearing or rerunning the query and only consumes an open Escape', async () => {
    const { input, search, onSelect, onSubmit } = await render()
    await typeInto(input, 'ada')
    const bubbled = vi.fn<(event: Event) => void>()
    document.addEventListener('keydown', bubbled)
    try {
      const escape = await pressKey(input, 'Escape')
      expect(escape.defaultPrevented).toBe(true)
      expect(bubbled).not.toHaveBeenCalled()
      expect(input.value).toBe('ada')
      expect(input.getAttribute('aria-expanded')).toBe('false')
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      expect(input.getAttribute('aria-controls')).toBeNull()
      expect(container.querySelector('[role="listbox"]')).toBeNull()
      const secondEscape = await pressKey(input, 'Escape')
      expect(secondEscape.defaultPrevented).toBe(false)
      expect(bubbled).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', bubbled)
    }
    await pressKey(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()

    for (const key of ['ArrowDown', 'ArrowUp']) {
      await pressKey(input, key)
      expect(container.querySelector('[role="listbox"]')).not.toBeNull()
      await pressKey(input, 'Escape')
    }
    await act(async () => { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()
    await pressKey(input, 'Escape')
    await typeInto(input, 'ada ')
    expect(container.querySelector('[role="listbox"]')).not.toBeNull()
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('keeps refreshed results dismissed after blur or Escape until the user reopens them', async () => {
    const { input, update } = await render()
    await act(async () => input.focus())
    await typeInto(input, 'ada')
    await act(async () => input.blur())
    await update({ search: () => new RpcPromise(Promise.resolve([GRACE])) })
    await act(async () => vi.advanceTimersByTimeAsync(225))
    expect(document.activeElement).not.toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="listbox"]')).toBeNull()

    await act(async () => input.focus())
    expect(container.querySelector('[role="option"]')?.textContent).toContain(GRACE.name)
    await pressKey(input, 'Escape')
    await update({ search: () => new RpcPromise(Promise.resolve([ADA])) })
    await act(async () => vi.advanceTimersByTimeAsync(225))
    expect(input.getAttribute('aria-expanded')).toBe('false')
    await typeInto(input, 'ada ')
    expect(container.querySelector('[role="option"]')?.textContent).toContain(ADA.name)
  })

  it('does not submit empty text or a directory search, including after a failure', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const onSearchStateChange = vi.fn<NonNullable<Props['onSearchStateChange']>>()
    const search = vi.fn<PlainSearch>(() => pending.promise)
    const { input, onSubmit } = await render({ search, onSearchStateChange })
    await pressKey(input, 'Enter')
    await typeInto(input, '   ', false)
    await pressKey(input, 'Enter')
    await typeInto(input, 'dormant@example.com', false)
    await pressKey(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(225))
    await pressKey(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(search).toHaveBeenCalledWith('dormant@example.com')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => pending.reject(new Error('offline')))
    expect(container.textContent).toContain('User search is temporarily unavailable.')
    expect(onSearchStateChange).toHaveBeenLastCalledWith({
      status: 'failed', query: 'dormant@example.com', resultCount: 0,
    })
    await pressKey(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })


  it.each(['empty', 'failed'])('does not offer or submit an exact identifier after a %s search', async (outcome) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = deferred<UserDirectoryRecord[]>()
    const { input, onSubmit, onSelect } = await render({ search: () => pending.promise })
    await typeInto(input, 'dormant@example.com')
    await act(async () => {
      if (outcome === 'empty') pending.resolve([])
      else pending.reject(new Error('offline'))
    })
    expect(container.querySelector('[role="option"]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    await pressKey(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('labels exact identifier input and never calls the directory when search is disabled', async () => {
    const { input, search, onSubmit, onSelect } = await render({ searchEnabled: false })
    expect(input.getAttribute('aria-label')).toBe('Username or email')
    expect(input.placeholder).toBe('Username or email')
    expect(input.getAttribute('role')).toBeNull()
    expect(input.getAttribute('aria-autocomplete')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBeNull()
    await pressKey(input, 'Enter')
    await typeInto(input, '   ')
    await pressKey(input, 'Enter')
    expect(onSubmit).not.toHaveBeenCalled()
    await typeInto(input, ' dormant@example.com ', false)
    await pressKey(input, 'Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(225))
    await pressKey(input, 'ArrowDown')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(input.getAttribute('aria-controls')).toBeNull()
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    expect(search).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('discards an in-flight result when directory search is disabled without clearing the query', async () => {
    const pending = deferred<UserDirectoryRecord[]>()
    const search = vi.fn<PlainSearch>(() => pending.promise)
    const { input, update, onSubmit, onSelect } = await render({ search })
    await typeInto(input, 'ada')
    expect(search).toHaveBeenCalledTimes(1)
    await update({ searchEnabled: false })
    expect(input.value).toBe('ada')
    expect(input.getAttribute('aria-label')).toBe('Username or email')
    expect(container.querySelector('[role="listbox"]')).toBeNull()
    await act(async () => pending.resolve([ADA]))
    expect(container.querySelector('[role="option"]')).toBeNull()
    await pressKey(input, 'Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    await typeInto(input, 'grace')
    expect(search).toHaveBeenCalledTimes(1)
  })
  it('only navigates directory matches, without an exact-identifier option', async () => {
    const { input, onSelect, onSubmit } = await render({ search: async () => [ADA, GRACE] })
    await typeInto(input, 'a')
    const options = container.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(2)
    await pressKey(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id)
    await pressKey(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)
    await pressKey(input, 'Enter')
    expect(onSelect).toHaveBeenCalledWith(ADA)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('hides excluded people from the current results without searching again', async () => {
    const search = vi.fn<PlainSearch>(async () => [ADA, GRACE])
    const { input, update, onSelect } = await render({ search })
    await typeInto(input, 'a')
    await update({ excludeIds: [ADA.id] })
    const options = container.querySelectorAll('[role="option"]')
    expect(Array.from(options, option => option.textContent)).toEqual([`${GRACE.name}${GRACE.id}`])
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)
    await pressKey(input, 'Enter')
    expect(onSelect).toHaveBeenCalledWith(GRACE)
    expect(search).toHaveBeenCalledOnce()
  })

})
