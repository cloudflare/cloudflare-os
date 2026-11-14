// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayModelTest } from '@gadgets/workshop-shared/api'
import { useGatewayTests, type GatewayTestState } from './useGatewayTests'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TESTING: GatewayTestState = { state: 'testing' }

const passed = (model: string): GatewayModelTest => ({ model, ok: true })
const failed = (model: string): GatewayModelTest =>
  ({ model, ok: false, status: 500, message: 'The server had an error.' })
const answered = (result: GatewayModelTest): GatewayTestState => ({ state: 'answered', result })

const deferred = () => {
  let resolve!: (value: GatewayModelTest) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<GatewayModelTest>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useGatewayTests', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    vi.restoreAllMocks()
  })

  /** Mounts a list that runs its tests through `runTest`, which answers that the key passed. */
  const mount = async () => {
    const runTest = vi.fn<(key: string) => Promise<GatewayModelTest>>(async (key) => passed(key))
    let list!: ReturnType<typeof useGatewayTests<string>>
    const List = () => {
      list = useGatewayTests(runTest)
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(<List />))
    return {
      runTest,
      /** Where each key's test stands, in the order the keys were first tested in. */
      shown: () => [...list.tests],
      /** Runs `use` on what the list last returned, as an event handler of the list would. */
      press: (use: (tests: typeof list) => void) => act(async () => use(list)),
    }
  }

  describe('forgetting one key’s test', () => {
    it.each<[string, (call: ReturnType<typeof deferred>) => void, GatewayTestState]>([
      ['in flight', () => {}, TESTING],
      ['answered', (call) => call.resolve(failed('a')), answered(failed('a'))],
      ['not run', (call) => call.reject(new Error('No such model: a')),
        { state: 'not-run', reason: 'No such model: a' }],
    ])('removes one that is %s, and leaves the other keys’ tests', async (_case, settle, before) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { runTest, shown, press } = await mount()
      const a = deferred()
      const c = deferred()
      runTest.mockReturnValueOnce(a.promise).mockResolvedValueOnce(passed('b'))
        .mockReturnValueOnce(c.promise)
      await press((tests) => tests.startTest('a'))
      await press((tests) => tests.startTest('b'))
      await press((tests) => tests.startTest('c'))
      await act(async () => settle(a))
      expect(shown()).toEqual([['a', before], ['b', answered(passed('b'))], ['c', TESTING]])

      await press((tests) => tests.clearTest('a'))

      expect(shown()).toEqual([['b', answered(passed('b'))], ['c', TESTING]])

      // A key that was never tested has nothing to forget.
      await press((tests) => tests.clearTest('d'))
      await act(async () => {
        a.resolve(passed('a'))
        c.resolve(failed('c'))
      })

      expect(shown()).toEqual([['b', answered(passed('b'))], ['c', answered(failed('c'))]])
    })

    it('drops the answer of a test that was in flight', async () => {
      const { runTest, shown, press } = await mount()
      const call = deferred()
      runTest.mockReturnValueOnce(call.promise)
      await press((tests) => tests.startTest('a'))
      await press((tests) => tests.clearTest('a'))

      await act(async () => call.resolve(passed('a')))

      expect(shown()).toEqual([])
    })

    it('drops the failure of a test that was in flight, and logs nothing of it', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { runTest, shown, press } = await mount()
      const call = deferred()
      runTest.mockReturnValueOnce(call.promise)
      await press((tests) => tests.startTest('a'))
      await press((tests) => tests.clearTest('a'))

      await act(async () => call.reject(new Error('No such model: a')))

      expect(shown()).toEqual([])
      expect(logged).not.toHaveBeenCalled()
    })

    it.each<[string, (call: ReturnType<typeof deferred>) => void]>([
      ['answers', (call) => call.resolve(failed('a'))],
      ['fails', (call) => call.reject(new Error('No such model: a'))],
    ])('tests the key again at once, and keeps that test when the forgotten one %s', async (
      _case, settle,
    ) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { runTest, shown, press } = await mount()
      const earlier = deferred()
      const later = deferred()
      runTest.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise)
      await press((tests) => tests.startTest('a'))

      // Before the list has rendered again.
      await press((tests) => {
        tests.clearTest('a')
        tests.startTest('a')
      })

      expect(runTest.mock.calls).toEqual([['a'], ['a']])
      expect(shown()).toEqual([['a', TESTING]])

      await act(async () => settle(earlier))

      expect(shown()).toEqual([['a', TESTING]])
      expect(logged).not.toHaveBeenCalled()
      // The later test is still the key's one test: the forgotten one did not end it.
      await press((tests) => tests.startTest('a'))
      expect(runTest).toHaveBeenCalledTimes(2)

      await act(async () => later.resolve(passed('a')))

      expect(shown()).toEqual([['a', answered(passed('a'))]])
      await press((tests) => tests.startTest('a'))
      expect(runTest).toHaveBeenCalledTimes(3)
    })
  })

  describe('forgetting every key’s test', () => {
    it('removes them all, whatever their state, and drops what the ones in flight find', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { runTest, shown, press } = await mount()
      const b = deferred()
      const c = deferred()
      runTest.mockResolvedValueOnce(passed('a')).mockReturnValueOnce(b.promise)
        .mockReturnValueOnce(c.promise).mockRejectedValueOnce(new Error('No such model: d'))
      for (const key of ['a', 'b', 'c', 'd']) await press((tests) => tests.startTest(key))
      expect(shown()).toEqual([
        ['a', answered(passed('a'))], ['b', TESTING], ['c', TESTING],
        ['d', { state: 'not-run', reason: 'No such model: d' }],
      ])
      logged.mockClear()

      await press((tests) => tests.clearTests())

      expect(shown()).toEqual([])

      await act(async () => {
        b.resolve(passed('b'))
        c.reject(new Error('No such model: c'))
      })

      expect(shown()).toEqual([])
      expect(logged).not.toHaveBeenCalled()
    })

    it('lets a key that was in flight be tested again at once', async () => {
      const { runTest, shown, press } = await mount()
      const earlier = deferred()
      runTest.mockReturnValueOnce(earlier.promise)
      await press((tests) => tests.startTest('a'))

      await press((tests) => {
        tests.clearTests()
        tests.startTest('a')
      })
      await act(async () => earlier.resolve(failed('a')))

      expect(runTest).toHaveBeenCalledTimes(2)
      expect(shown()).toEqual([['a', answered(passed('a'))]])
    })
  })

  it('runs one test of a key for two presses made before the list renders again', async () => {
    const { runTest, shown, press } = await mount()

    await press((tests) => {
      tests.startTest('a')
      tests.startTest('a')
    })

    expect(runTest).toHaveBeenCalledExactlyOnceWith('a')
    expect(shown()).toEqual([['a', answered(passed('a'))]])
  })

  // A model ID is whatever an admin typed.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'tests and forgets the key “%s” as it does any other', async (key) => {
      const { runTest, shown, press } = await mount()
      const call = deferred()
      runTest.mockReturnValueOnce(call.promise)
      expect(shown()).toEqual([])

      await press((tests) => tests.startTest(key))
      await press((tests) => tests.startTest(key))

      expect(runTest).toHaveBeenCalledExactlyOnceWith(key)
      expect(shown()).toEqual([[key, TESTING]])

      await act(async () => call.resolve(passed(key)))

      expect(shown()).toEqual([[key, answered(passed(key))]])

      await press((tests) => tests.clearTest(key))

      expect(shown()).toEqual([])
      await press((tests) => tests.startTest(key))
      expect(runTest).toHaveBeenCalledTimes(2)
      expect(shown()).toEqual([[key, answered(passed(key))]])
    })
})
