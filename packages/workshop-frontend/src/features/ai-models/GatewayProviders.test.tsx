// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AdminGatewayProvider,
  AiModelProvider,
  GatewayModelTest,
} from '@gadgets/workshop-shared/api'
import { GatewayProviders } from './GatewayProviders'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// One provider in each state: listed by the environment, turned on by an admin, and off, the last
// of them also short of the token its requests need.
const PROVIDERS: AdminGatewayProvider[] = [
  { provider: 'cloudflare', enabledBy: 'environment', needsApiToken: false },
  { provider: 'anthropic', enabledBy: 'admin', needsApiToken: false },
  { provider: 'openai', needsApiToken: false },
  { provider: 'google', needsApiToken: true },
]

const INTRO =
  'The providers whose models this deployment can offer through its AI Gateway. The ones listed ' +
  'in CF_AI_GATEWAY_PROVIDERS are always on; the others can be turned on here. Provider keys or ' +
  'credits are stored in the gateway, where this page cannot see them, so use Test to find out ' +
  'whether a provider answers.'
const LOCKED_NOTE = 'Set by CF_AI_GATEWAY_PROVIDERS'
const TOKEN_WARNING =
  'Needs CF_AI_GATEWAY_API_TOKEN: requests to this provider fail until the deployment sets it.'
const AUTH_HINT =
  'The gateway may hold no key or credits for this provider, or CF_AI_GATEWAY_API_TOKEN may not ' +
  'be allowed to run models.'

const PASSED: GatewayModelTest = { model: 'claude-sonnet-4-5', ok: true }

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const rows = () => Array.from(document.body.querySelectorAll('li'))

const providerSwitch = (label: string) => {
  const element = document.body.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${label}"]`)
  if (!element) throw new Error(`No switch ${label}`)
  return element
}

// The checkbox the switch forwards its clicks to. jsdom has no PointerEvent, which the switch
// forwards them with.
const providerCheckbox = (label: string) => {
  const input = providerSwitch(label).nextElementSibling
  if (!(input instanceof HTMLInputElement)) throw new Error('No checkbox behind the switch')
  return input
}

const row = (label: string) => providerSwitch(label).closest('li')!

const testButton = (label: string) => {
  const element = row(label).querySelector<HTMLButtonElement>('button:not([role="switch"])')
  if (!element) throw new Error(`No Test button for ${label}`)
  return element
}

const status = (label: string) => {
  const regions = row(label).querySelectorAll<HTMLElement>('[role="status"]')
  if (regions.length !== 1) throw new Error(`${regions.length} status regions for ${label}`)
  return regions[0]
}

/** What the row's status region says, one entry for each paragraph of it. */
const said = (label: string) =>
  Array.from(status(label).querySelectorAll('p')).map((p) => p.textContent)

const describedBy = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '').split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')

const click = (element: HTMLElement) => act(async () => { element.click() })

const focus = (element: HTMLElement) => act(async () => { element.focus() })

describe('GatewayProviders', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  type Shown = { providers?: AdminGatewayProvider[]; busy?: boolean }

  const render = async (shown: Shown = {}) => {
    const onEnabledChange = vi.fn<(provider: AiModelProvider, enabled: boolean) => void>()
    const onTest = vi.fn<(provider: AiModelProvider) => Promise<GatewayModelTest>>(
      async () => PASSED)
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // Shows the providers as a re-read of the settings reported them.
    const show = ({ providers = PROVIDERS, busy = false }: Shown) => act(async () => root!.render(
      <GatewayProviders
        providers={providers}
        busy={busy}
        onEnabledChange={onEnabledChange}
        onTest={onTest}
      />))
    await show(shown)
    return { onEnabledChange, onTest, show }
  }

  it('says what the list is and what Test is for', async () => {
    await render()

    expect(document.body.querySelector('p')?.textContent).toBe(INTRO)
  })

  it('lists each provider under its name, in the order given', async () => {
    await render()

    const names = ['Cloudflare Workers AI', 'Anthropic', 'OpenAI', 'Google']
    expect(rows().map((item) => item.querySelector('p')?.textContent)).toEqual(names)
    expect(rows().map((item) => item.querySelector('[role="switch"]')?.getAttribute('aria-label')))
      .toEqual(names)
  })

  describe('the switch', () => {
    it.each([
      ['off for a provider that is off', 'OpenAI', 'false'],
      ['on for a provider an admin turned on', 'Anthropic', 'true'],
    ])('is %s, and can be changed', async (_case, label, checked) => {
      await render()

      expect(providerSwitch(label).getAttribute('aria-checked')).toBe(checked)
      expect(providerSwitch(label).disabled).toBe(false)
      expect(providerSwitch(label).hasAttribute('aria-describedby')).toBe(false)
      expect(row(label).textContent).not.toContain(LOCKED_NOTE)
    })

    it('is on and locked for a provider the environment lists, and says why', async () => {
      const { onEnabledChange } = await render()

      expect(providerSwitch('Cloudflare Workers AI').getAttribute('aria-checked')).toBe('true')
      expect(providerSwitch('Cloudflare Workers AI').disabled).toBe(true)
      expect(describedBy(providerSwitch('Cloudflare Workers AI'))).toBe(LOCKED_NOTE)

      await click(providerCheckbox('Cloudflare Workers AI'))

      expect(onEnabledChange).not.toHaveBeenCalled()
    })

    it.each([
      ['on', 'OpenAI', 'openai', true],
      ['off', 'Anthropic', 'anthropic', false],
    ] as const)('asks to turn a provider %s, and waits to be told that it is', async (
      _case, label, provider, enabled,
    ) => {
      const { onEnabledChange } = await render()

      await click(providerCheckbox(label))

      expect(onEnabledChange).toHaveBeenCalledExactlyOnceWith(provider, enabled)
      expect(providerSwitch(label).getAttribute('aria-checked')).toBe(String(!enabled))
    })

    it('is locked while a write is in flight', async () => {
      const { onEnabledChange, show } = await render({ busy: true })

      expect(rows().map((item) => item.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled))
        .toEqual([true, true, true, true])
      await click(providerCheckbox('OpenAI'))
      expect(onEnabledChange).not.toHaveBeenCalled()

      await show({ busy: false })

      expect(providerSwitch('OpenAI').disabled).toBe(false)
      expect(providerSwitch('Cloudflare Workers AI').disabled).toBe(true)
    })
  })

  describe('the token warning', () => {
    it('is in the row of a provider that needs the token, and describes its switch', async () => {
      await render()

      expect(row('Google').textContent).toContain(TOKEN_WARNING)
      expect(describedBy(providerSwitch('Google'))).toBe(TOKEN_WARNING)
    })

    it('is in no other row', async () => {
      await render()

      for (const label of ['Cloudflare Workers AI', 'Anthropic', 'OpenAI']) {
        expect(row(label).textContent).not.toContain('CF_AI_GATEWAY_API_TOKEN')
      }
    })

    it('describes a locked switch along with the reason it is locked', async () => {
      await render({
        providers: [{ provider: 'anthropic', enabledBy: 'environment', needsApiToken: true }],
      })

      expect(describedBy(providerSwitch('Anthropic'))).toBe(`${LOCKED_NOTE} ${TOKEN_WARNING}`)
    })
  })

  describe('the test', () => {
    it('has an empty status region in each row before any test is run', async () => {
      await render()

      for (const label of ['Cloudflare Workers AI', 'Anthropic', 'OpenAI', 'Google']) {
        expect(status(label).childNodes).toHaveLength(0)
      }
    })

    it('is run from a button named after the provider, whether the provider is on or off', async () => {
      const { onTest, onEnabledChange } = await render()

      for (const label of ['Cloudflare Workers AI', 'Anthropic', 'OpenAI', 'Google']) {
        expect(testButton(label).textContent).toBe('Test')
        expect(testButton(label).getAttribute('aria-label')).toBe(`Test ${label}`)
        expect(testButton(label).disabled).toBe(false)
      }

      await click(testButton('OpenAI'))

      expect(onTest).toHaveBeenCalledExactlyOnceWith('openai')
      expect(onEnabledChange).not.toHaveBeenCalled()
    })

    it('says that it is in flight, ignores a second press, and keeps focus on its button', async () => {
      const { onTest } = await render()
      const call = deferred<GatewayModelTest>()
      onTest.mockReturnValueOnce(call.promise)
      const pressed = testButton('Anthropic')
      const region = status('Anthropic')
      await focus(pressed)

      await click(pressed)

      expect(testButton('Anthropic')).toBe(pressed)
      expect(pressed.textContent).toBe('Testing…')
      expect(pressed.getAttribute('aria-label')).toBe('Testing Anthropic…')
      expect(pressed.getAttribute('aria-disabled')).toBe('true')
      // A browser takes focus from a button that is disabled, which jsdom does not.
      expect(pressed.disabled).toBe(false)
      expect(document.activeElement).toBe(pressed)
      expect(region.childNodes).toHaveLength(0)

      await click(pressed)
      expect(onTest).toHaveBeenCalledOnce()

      await act(async () => call.resolve(PASSED))

      expect(testButton('Anthropic')).toBe(pressed)
      expect(pressed.textContent).toBe('Test')
      expect(pressed.getAttribute('aria-label')).toBe('Test Anthropic')
      expect(pressed.getAttribute('aria-disabled')).toBe('false')
      expect(document.activeElement).toBe(pressed)
      // The region that was there all along is the one that says the result.
      expect(status('Anthropic')).toBe(region)
      expect(region.textContent).toBe('claude-sonnet-4-5 answered through the gateway.')

      await click(pressed)
      expect(onTest).toHaveBeenCalledTimes(2)
    })

    it.each<[string, GatewayModelTest, string[]]>([
      ['a model that answered', PASSED, ['claude-sonnet-4-5 answered through the gateway.']],
      [
        'a failure with a status',
        { model: 'gpt-main', ok: false, status: 500, message: 'The server had an error.' },
        ['Failed (500): The server had an error.'],
      ],
      [
        'a failure without a status',
        { model: 'gemini-main', ok: false, message: 'API key not valid.' },
        ['Failed: API key not valid.'],
      ],
      [
        'a 401, with what it may mean',
        { model: 'claude-sonnet-4-5', ok: false, status: 401, message: 'invalid x-api-key' },
        ['Failed (401): invalid x-api-key', AUTH_HINT],
      ],
      [
        'a 403, with what it may mean',
        { model: 'claude-sonnet-4-5', ok: false, status: 403, message: 'Forbidden' },
        ['Failed (403): Forbidden', AUTH_HINT],
      ],
    ])('reports %s in the provider’s row', async (_case, result, expected) => {
      const { onTest } = await render()
      onTest.mockResolvedValueOnce(result)

      await click(testButton('Anthropic'))

      expect(said('Anthropic')).toEqual(expected)
      expect(status('OpenAI').childNodes).toHaveLength(0)
    })

    it('shows a failure’s message as text', async () => {
      const { onTest } = await render()
      const message = '<img src="x" alt="markup"> {"error":{"type":"overloaded_error"}}'
      onTest.mockResolvedValueOnce({ model: 'claude-sonnet-4-5', ok: false, status: 529, message })

      await click(testButton('Anthropic'))

      expect(said('Anthropic')).toEqual([`Failed (529): ${message}`])
      expect(document.body.querySelector('img')).toBeNull()
    })

    it.each([
      [
        'with the server’s reason',
        new Error('Provider "anthropic" is not served through AI Gateway.'),
        'Couldn’t run the test: Provider "anthropic" is not served through AI Gateway.',
      ],
      // A lost connection's message is a transport string, which is not shown.
      ['without one', new Error('Peer closed WebSocket: 1006 '), 'Couldn’t run the test.'],
    ])('shows a test that could not be run in the provider’s row, %s', async (
      _case, failure, expected,
    ) => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { onTest } = await render()
      onTest.mockRejectedValueOnce(failure)

      await click(testButton('Anthropic'))

      expect(said('Anthropic')).toEqual([expected])
      expect(testButton('Anthropic').textContent).toBe('Test')
      expect(logged).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure)
    })

    it('replaces a result with the next test’s, and shows neither in between', async () => {
      const { onTest } = await render()
      onTest.mockResolvedValueOnce(
        { model: 'claude-sonnet-4-5', ok: false, status: 401, message: 'invalid x-api-key' })
      await click(testButton('Anthropic'))
      expect(said('Anthropic')).toEqual(['Failed (401): invalid x-api-key', AUTH_HINT])
      const call = deferred<GatewayModelTest>()
      onTest.mockReturnValueOnce(call.promise)

      await click(testButton('Anthropic'))

      expect(status('Anthropic').childNodes).toHaveLength(0)

      await act(async () => call.resolve(PASSED))

      expect(said('Anthropic')).toEqual(['claude-sonnet-4-5 answered through the gateway.'])
    })

    it('tests two providers at once, and keeps each one’s result in its own row', async () => {
      const { onTest } = await render()
      const anthropic = deferred<GatewayModelTest>()
      const openai = deferred<GatewayModelTest>()
      onTest.mockReturnValueOnce(anthropic.promise).mockReturnValueOnce(openai.promise)

      await click(testButton('Anthropic'))
      await click(testButton('OpenAI'))

      expect(onTest.mock.calls).toEqual([['anthropic'], ['openai']])
      expect(testButton('Anthropic').textContent).toBe('Testing…')
      expect(testButton('OpenAI').textContent).toBe('Testing…')
      expect(testButton('Google').textContent).toBe('Test')

      await act(async () => openai.resolve(
        { model: 'gpt-main', ok: false, status: 429, message: 'Rate limit reached.' }))

      expect(said('OpenAI')).toEqual(['Failed (429): Rate limit reached.'])
      expect(testButton('OpenAI').textContent).toBe('Test')
      expect(status('Anthropic').childNodes).toHaveLength(0)
      expect(testButton('Anthropic').textContent).toBe('Testing…')

      await act(async () => anthropic.resolve(PASSED))

      expect(said('Anthropic')).toEqual(['claude-sonnet-4-5 answered through the gateway.'])
      expect(said('OpenAI')).toEqual(['Failed (429): Rate limit reached.'])
    })

    it('can be run while a write is in flight', async () => {
      const { onTest } = await render({ busy: true })

      expect(testButton('Anthropic').disabled).toBe(false)
      expect(testButton('Anthropic').getAttribute('aria-disabled')).toBe('false')

      await click(testButton('Anthropic'))

      expect(onTest).toHaveBeenCalledExactlyOnceWith('anthropic')
      expect(said('Anthropic')).toEqual(['claude-sonnet-4-5 answered through the gateway.'])
    })

    it('keeps a result when the providers are re-read', async () => {
      const { show } = await render()
      await click(testButton('OpenAI'))

      await show({
        providers: PROVIDERS.map((entry) =>
          entry.provider === 'openai' ? { ...entry, enabledBy: 'admin' } : entry),
        busy: true,
      })

      expect(providerSwitch('OpenAI').getAttribute('aria-checked')).toBe('true')
      expect(said('OpenAI')).toEqual(['claude-sonnet-4-5 answered through the gateway.'])
    })

    it('says nothing of a test that fails once the list is gone', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { onTest } = await render()
      const call = deferred<GatewayModelTest>()
      onTest.mockReturnValueOnce(call.promise)
      await click(testButton('Anthropic'))

      await act(async () => root!.unmount())
      root = undefined
      // As a test does when leaving the admin page disposes of the capability it was asked through.
      await act(async () => call.reject(
        new Error('RPC session was shut down by disposing the main stub')))

      expect(logged).not.toHaveBeenCalled()
    })
  })
})
