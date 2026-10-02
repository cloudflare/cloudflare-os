import { useEffect, useRef, useState } from 'react'
import type { GatewayProviderTest } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'

/**
 * Where a test stands: in flight, answered by the server (a request that failed is an answer too),
 * or not run, because the call for it failed.
 */
export type GatewayTestState =
  | { state: 'testing' }
  | { state: 'answered'; result: GatewayProviderTest }
  | { state: 'not-run'; reason: string | undefined }

/**
 * The tests a list runs through the gateway, by the key of what each one tests. They belong to the
 * list rather than to the server: one runs whatever else the page is doing, and its result stays
 * until the same key is tested again.
 */
export const useGatewayTests = <Key extends string>(
  /** Runs one test. A request that fails is a result; rejects when it could not be run at all. */
  runTest: (key: Key) => Promise<GatewayProviderTest>,
) => {
  const [tests, setTests] = useState<ReadonlyMap<Key, GatewayTestState>>(() => new Map())
  // A test that fails once the list is gone is not reported. Leaving the admin page disposes of
  // the capability the test was asked through, so such a test often fails for that reason alone.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // One test per key at a time, so an earlier test can't answer over a later one.
  const run = async (key: Key) => {
    if (tests.get(key)?.state === 'testing') return
    const show = (test: GatewayTestState) => setTests((shown) => new Map(shown).set(key, test))
    show({ state: 'testing' })
    try {
      const result = await runTest(key)
      show({ state: 'answered', result })
    } catch (err) {
      if (!mounted.current) return
      console.error(`Failed to test ${key} through the gateway:`, err)
      show({ state: 'not-run', reason: rpcFailureDescription(err) })
    }
  }

  return {
    /** Where the last test of each key stands. A key has no entry until it is tested. */
    tests,
    /** Tests `key`, unless a test of it is in flight. */
    startTest: (key: Key) => { void run(key) },
  }
}
