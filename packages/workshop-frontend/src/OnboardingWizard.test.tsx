// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof Kumo>()
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
const auth = vi.hoisted(() => {
  const value: { authenticatedApi: Record<string, unknown>, currentUser: { id: string, name: string } } =
    { authenticatedApi: {}, currentUser: { id: 'alice', name: 'Alice' } }
  return value
})
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => auth }))

import { deferred, makeTestRoot } from './action-test-harness'
import OnboardingWizard from './OnboardingWizard'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  addToast.mockReset()
  vi.restoreAllMocks()
})

const tool = (id: string, displayName: string): GatekeeperVendorInfo =>
  ({ id, description: { url: `https://${id}.example`, displayName }, supportedResources: [] })
const tools = [tool('scheduler', 'Scheduled Tasks'), tool('websearch', 'Web Search')]

// A user API whose built-in tool discovery resolves only when the test says so.
function fakeApi() {
  const discovery = deferred<GatekeeperVendorInfo[]>()
  const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>(async () => {})
  const completeOnboarding = vi.fn<() => Promise<void>>(async () => {})
  auth.authenticatedApi = {
    listModels: async () => [],
    getAiConfig: async () => ({ enabled: false }),
    listGatekeeperVendors: async () => [],
    listAddableGatekeepers: () => discovery.promise,
    subscribeConnectedAccounts: () =>
      Object.assign(new Promise<never>(() => {}), { [Symbol.dispose]() {} }),
    setPreferredModel: async () => {},
    provisionAmbientAccount,
    completeOnboarding,
  }
  return { discovery, provisionAmbientAccount, completeOnboarding }
}

const button = (label: RegExp) =>
  [...document.querySelectorAll('button')].find(b => label.test(b.textContent ?? ''))
const click = async (label: RegExp) => {
  const element = button(label)
  if (!element) throw new Error(`No button labeled ${label}`)
  await act(async () => element.click())
}
// Through the checkbox the switch forwards clicks to, since jsdom has no PointerEvent.
const flipSwitch = async (name: string) => {
  const checkbox = document.querySelector(`[role="switch"][aria-label="${name}"]`)?.nextElementSibling
  if (!(checkbox instanceof HTMLInputElement)) throw new Error(`No switch for ${name}`)
  await act(async () => checkbox.click())
}

async function openConnectionsStep() {
  await view.render(<OnboardingWizard onComplete={() => {}} />)
  await click(/^Next$/)
  await click(/^Next$/)
}

describe('OnboardingWizard built-in tools', () => {
  it('keeps the user on Connections until the tools load, then turns on only those left on',
      async () => {
    const api = fakeApi()
    await openConnectionsStep()
    await click(/^Next$/)
    expect(button(/Let.s build/)).toBeUndefined()

    await api.discovery.resolve(tools)
    await flipSwitch('Web Search')
    await click(/^Next$/)
    await click(/Let.s build/)

    expect(api.provisionAmbientAccount.mock.calls).toEqual([['scheduler']])
    expect(api.completeOnboarding).toHaveBeenCalledOnce()
  })

  it('completes onboarding and names the tool when one fails to turn on', async () => {
    const api = fakeApi()
    api.provisionAmbientAccount.mockImplementation(async (vendorId) => {
      if (vendorId === 'websearch') throw new Error('disabled on this deployment')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await openConnectionsStep()
    await api.discovery.resolve(tools)
    await click(/^Next$/)
    await click(/Let.s build/)

    expect(api.completeOnboarding).toHaveBeenCalledOnce()
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't turn on Web Search.", variant: 'warning' }))
  })
})
