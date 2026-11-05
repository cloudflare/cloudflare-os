// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VERSION_PATH } from '@gadgets/workshop-shared/api'
import { getBackendHost } from '../../connectHandoff'
import { useStaleBackendReconnect } from './useStaleBackendReconnect'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const versionAnswer = (version: unknown) => () => Promise.resolve(Response.json({ version }))

// A session check, as when the tab becomes visible, and the fetch it may start.
const sessionCheck = async () => {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('useStaleBackendReconnect', () => {
  let root: Root
  let answer: () => Promise<Response>
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer())
  const onReconnect = vi.fn<() => void>()

  const Session = ({ socketVersion }: { socketVersion: string | undefined }) => {
    useStaleBackendReconnect(socketVersion, onReconnect)
    return null
  }

  // `undefined` is a socket whose backend has not reported its version yet, as while replacing it.
  const render = async (socketVersion: string | undefined) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Session socketVersion={socketVersion} />
        </StrictMode>,
      )
    })
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', fetch)
    fetch.mockClear()
    onReconnect.mockReset()
    answer = versionAnswer('v2')
    root = createRoot(document.createElement('div'))
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  })

  it('asks the backend host for the version new requests reach, uncached', async () => {
    await render('v1')
    await sessionCheck()

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${window.location.protocol}//${getBackendHost()}${VERSION_PATH}`)
    expect(init).toMatchObject({ cache: 'no-store' })
  })

  it('reconnects once when new requests reach another version', async () => {
    await render('v1')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledOnce()

    // Still the old socket's version, as while the reconnect is underway.
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledOnce()

    await render('v2')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('does not reconnect away from the same version twice, as in a split rollout', async () => {
    await render('v1')
    await sessionCheck()
    await render(undefined)
    await render('v1')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledOnce()

    answer = versionAnswer('v3')
    await render('v2')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledTimes(2)
  })

  it('does not reconnect away from a version again after reconnecting away from another', async () => {
    await render('v1')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledOnce()

    // Mid-rollout, the new socket reaches v2 while new requests reach v1, and then the reverse.
    answer = versionAnswer('v1')
    await render('v2')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledTimes(2)

    answer = versionAnswer('v2')
    await render('v1')
    await sessionCheck()
    expect(onReconnect).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['the same version', versionAnswer('v1')],
    ['no version', versionAnswer(null)],
    ['a malformed answer', versionAnswer(42)],
    ['an error status', () => Promise.resolve(new Response('', { status: 500 }))],
    ['a failed request', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('does not reconnect on %s', async (_name, next) => {
    answer = next
    await render('v1')
    await sessionCheck()
    expect(fetch).toHaveBeenCalledOnce()
    expect(onReconnect).not.toHaveBeenCalled()
  })

  it('does not check a socket whose backend has not reported a version', async () => {
    await render(undefined)
    await sessionCheck()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not reconnect when the socket changed during the check', async () => {
    let respond!: (response: Response) => void
    answer = () => new Promise(resolve => { respond = resolve })
    await render('v1')
    await sessionCheck()
    await render(undefined)
    await act(async () => { respond(Response.json({ version: 'v2' })) })
    expect(onReconnect).not.toHaveBeenCalled()
  })
})
