import { useEffect, useRef, useState } from 'react'
import type { GatewayModelTest } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'

/**
 * Where a test stands: in flight, answered by the server (a request that failed is an answer too),
 * or not run, because the call for it failed.
 */
export type GatewayTestState =
  | { state: 'testing' }
  | { state: 'answered'; result: GatewayModelTest }
  | { state: 'not-run'; reason: string | undefined }

/**
 * The tests a list runs through the gateway, by the key of what each one tests. They belong to the
 * list rather than to the server: one runs whatever else the page is doing, and its result stays
 * until the same key is tested again or the list forgets it.
 */
export const useGatewayTests = <Key extends string>(
  /** Runs one test. A request that fails is a result; rejects when it could not be run at all. */
  runTest: (key: Key) => Promise<GatewayModelTest>,
) => {
  const [tests, setTests] = useState<ReadonlyMap<Key, GatewayTestState>>(() => new Map())
  // The request each key is waiting on. A key has at most one, so an earlier test can't answer
  // over a later one, and a request that is not its key's when it settles was forgotten.
  const inFlight = useRef(new Map<Key, symbol>())
  // A test that fails once the list is gone is not reported. Leaving the admin page disposes of
  // the capability the test was asked through, so such a test often fails for that reason alone.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const run = async (key: Key) => {
    if (inFlight.current.has(key)) return
    const request = Symbol()
    inFlight.current.set(key, request)
    // A test is forgotten for a change made after it was asked, so what a forgotten one finds
    // is neither shown nor logged.
    const forgotten = () => inFlight.current.get(key) !== request
    const show = (test: GatewayTestState) => setTests((shown) => new Map(shown).set(key, test))
    show({ state: 'testing' })
    try {
      const result = await runTest(key)
      if (!forgotten()) show({ state: 'answered', result })
    } catch (err) {
      if (forgotten() || !mounted.current) return
      console.error(`Failed to test ${key} through the gateway:`, err)
      show({ state: 'not-run', reason: rpcFailureDescription(err) })
    } finally {
      if (!forgotten()) inFlight.current.delete(key)
    }
  }

  return {
    /** Where the last test of each key stands. A key has no entry until it is tested. */
    tests,
    /** Tests `key`, unless a test of it is in flight. */
    startTest: (key: Key) => { void run(key) },
    /**
     * Forgets the test of `key`, whatever its state. One in flight is dropped when it settles,
     * and the key can be tested again at once.
     */
    clearTest: (key: Key) => {
      inFlight.current.delete(key)
      setTests((shown) => {
        const kept = new Map(shown)
        kept.delete(key)
        return kept
      })
    },
    /** Forgets every key's test, as `clearTest` forgets one. */
    clearTests: () => {
      inFlight.current.clear()
      setTests(new Map())
    },
  }
}
