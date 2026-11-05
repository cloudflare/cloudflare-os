// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTER_TAG_PROBE_PATH } from '@gadgets/workshop-shared/api'
import { getBackendHost } from '../../connectHandoff'
import { probeRouterTag } from './probeRouterTag'

describe('probeRouterTag', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs to the probe path on the backend host, uncached, without reading the answer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)

    await probeRouterTag()

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${window.location.protocol}//${getBackendHost()}${ROUTER_TAG_PROBE_PATH}`)
    expect(init).toMatchObject({ method: 'POST', mode: 'no-cors', cache: 'no-store' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('resolves when the probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(probeRouterTag()).resolves.toBeUndefined()
  })
})
