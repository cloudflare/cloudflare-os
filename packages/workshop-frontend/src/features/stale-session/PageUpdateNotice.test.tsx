// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toasty, useKumoToastManager } from '@cloudflare/kumo'

const testState = vi.hoisted(() => ({ reload: vi.fn<() => void>() }))
vi.mock('./versionChecks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./versionChecks')>()),
  reloadPage: testState.reload,
}))

import { PageUpdateNotice } from './PageUpdateNotice'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type ToastList = ReturnType<typeof useKumoToastManager>['toasts']

const OWN_ENTRY = '/assets/index-aaaa1111.js'
const pageWith = (entry: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script>` +
  '</head><body><div id="root"></div></body></html>'

// Toasts render in a portal on the body, outside the test's container.
const button = (name: string) => {
  const match = [...document.body.querySelectorAll('button')]
    .find(candidate => candidate.textContent?.trim() === name)
  if (!match) throw new Error(`no ${name} button`)
  return match
}

const serving = (entry: string) => () => Promise.resolve(new Response(pageWith(entry)))

// A session check, as when the tab becomes visible, and the fetch it may start.
const sessionCheck = async () => {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('PageUpdateNotice', () => {
  let container: HTMLDivElement
  let root: Root
  let toasts: ToastList
  let answer: () => Promise<Response>
  const fetch = vi.fn<typeof globalThis.fetch>(async () => answer())

  const ToastProbe = () => {
    toasts = useKumoToastManager().toasts
    return null
  }
  const liveToasts = () => toasts.filter(toast => toast.transitionStatus !== 'ending')

  const render = async ({ mounted = true } = {}) => {
    await act(async () => {
      root.render(
        <StrictMode>
          <Toasty>
            {mounted && <PageUpdateNotice />}
            <ToastProbe />
          </Toasty>
        </StrictMode>,
      )
    })
  }

  beforeEach(() => {
    // jsdom has no animations, so a closed toast would leave the list at once. Holding every exit
    // animation open keeps it there as "ending", as a browser does for the length of the exit.
    Element.prototype.getAnimations = () => [{ finished: new Promise<never>(() => {}) } as unknown as Animation]
    document.head.innerHTML = `<script type="module" crossorigin src="${OWN_ENTRY}"></script>`
    vi.stubGlobal('fetch', fetch)
    fetch.mockClear()
    testState.reload.mockReset()
    answer = serving('/assets/index-bbbb2222.js')
    toasts = []
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.head.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('reads the entry script of a fresh, uncached load of the page', async () => {
    await render()
    await sessionCheck()

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/')
    expect(init).toMatchObject({ cache: 'no-store' })
  })

  it('offers a reload, once, when a fresh load would serve a new frontend', async () => {
    await render()
    await sessionCheck()

    expect(liveToasts()).toHaveLength(1)
    expect(liveToasts()[0]).toMatchObject({
      title: 'Cloudflare OS was updated', description: 'Reload to use the new version.', timeout: 0,
    })

    await sessionCheck()
    expect(liveToasts()).toHaveLength(1)
    expect(toasts).toHaveLength(1)

    await act(async () => { button('Reload').click() })
    expect(testState.reload).toHaveBeenCalledOnce()
  })

  it('offers it again for a newer frontend still, replacing the earlier toast', async () => {
    await render()
    await sessionCheck()
    const first = liveToasts()[0]!.id

    answer = serving('/assets/index-cccc3333.js')
    await sessionCheck()
    expect(liveToasts()).toHaveLength(1)
    expect(liveToasts()[0]!.id).not.toBe(first)
  })

  it.each([
    ['the same frontend', serving(OWN_ENTRY)],
    ['a page with no entry script', () => Promise.resolve(new Response('<html></html>'))],
    ['an error status', () => Promise.resolve(new Response(pageWith('/x.js'), { status: 503 }))],
    ['a failed request', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows nothing for %s', async (_name, next) => {
    answer = next
    await render()
    await sessionCheck()
    expect(fetch).toHaveBeenCalledOnce()
    expect(toasts).toHaveLength(0)
  })

  it('does not check a page with no entry script of its own', async () => {
    document.head.innerHTML = ''
    await render()
    await sessionCheck()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('closes its toast when unmounted', async () => {
    await render()
    await sessionCheck()
    await render({ mounted: false })
    expect(liveToasts()).toHaveLength(0)
  })
})
