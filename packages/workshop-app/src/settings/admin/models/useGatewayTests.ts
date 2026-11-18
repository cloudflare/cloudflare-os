import { useEffect, useRef, useState } from 'react'
import type { GatewayModelTest } from '@gadgets/workshop-shared/api'
import { messageOf } from '../../useAttempt'

/**
 * Where a test stands: under way, answered by the server (a request that failed is an answer
 * too), or not run, as the call for it failed. `Result` is what the server answers a test with.
 */
export type GatewayTestState<Result = GatewayModelTest> =
  | { state: 'testing' }
  | { state: 'answered'; result: Result }
  | { state: 'not-run'; reason: string }

/**
 * The tests a list runs through the gateway, by the key of what each is of. They are the list's
 * rather than the server's: one runs whatever else the part is doing, and what it found stays
 * until the same key is tested again or the list forgets it. Ported from `workshop-frontend`'s
 * `useGatewayTests`.
 */
export const useGatewayTests = <Key extends string, Result = GatewayModelTest>(
  /** Runs one test. A request that fails is a result; rejects where it could not be run at all. */
  runTest: (key: Key) => Promise<NoInfer<Result>>,
) => {
  const [tests, setTests] = useState<ReadonlyMap<Key, GatewayTestState<Result>>>(() => new Map())
  // The request each key waits on, so that an earlier test cannot answer over a later one, and
  // one that is not its key's when it settles was forgotten.
  const inFlight = useRef(new Map<Key, symbol>())
  // One that fails once the list is gone is not said: leaving the part lets go of the capability
  // it was asked through, which is often why.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = async (key: Key) => {
    if (inFlight.current.has(key)) return
    const request = Symbol(key)
    inFlight.current.set(key, request)
    const forgotten = () => inFlight.current.get(key) !== request
    const show = (test: GatewayTestState<Result>) => setTests((shown) => new Map(shown).set(key, test))
    show({ state: 'testing' })
    try {
      const result = await runTest(key)
      if (!forgotten()) show({ state: 'answered', result })
    } catch (error) {
      if (!forgotten() && mounted.current) show({ state: 'not-run', reason: messageOf(error) })
    } finally {
      if (!forgotten()) inFlight.current.delete(key)
    }
  }

  return {
    /** Where the last test of each key stands. A key has none until it is tested. */
    tests,
    /** Tests `key`, unless a test of it is under way. */
    startTest: (key: Key) => void run(key),
    /** Forgets the test of `key`, whatever it stands at: one under way is dropped as it settles. */
    clearTest: (key: Key) => {
      inFlight.current.delete(key)
      setTests((shown) => {
        const kept = new Map(shown)
        kept.delete(key)
        return kept
      })
    },
    /** Forgets every key's test. */
    clearTests: () => {
      inFlight.current.clear()
      setTests(new Map())
    },
  }
}
