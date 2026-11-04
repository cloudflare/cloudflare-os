// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BoundHookInfo, GadgetBindingInfo, ResourceBindingInfo } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { listGatekeeperVendors: async () => [] }, currentUser: null }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => context }
})

import { clickHookSwitch, deferred, hookSwitch, makeTestRoot } from './action-test-harness'
import Connections from './Connections'

const view = makeTestRoot()

beforeEach(() => {
  addToast.mockClear()
  // Each failure is logged as well as shown.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const TITLE = 'Watch acme/widgets on GitHub'
const refusal = "GitHub refused to add a webhook to acme/widgets: only the repository's admins can."

/** A workspace with one hook on the gadget, which `listHooks()` reports as the server has it. */
function workspace(enabled = false) {
  const server = { enabled }
  const listHooks = async () => [{
    id: 7,
    gatekeeperId: 'github',
    gadgetId: 'triage',
    resourceTitle: 'acme/widgets',
    description: { title: TITLE, description: 'Call this hook with each issue event.' },
    enabled: server.enabled,
  } as unknown as BoundHookInfo]
  const enableHook = vi.fn<(id: number) => Promise<void>>(async () => { server.enabled = true })
  const disableHook = vi.fn<(id: number) => Promise<void>>(async () => { server.enabled = false })
  return { server, overseer: { listHooks, enableHook, disableHook, [Symbol.dispose]: () => {} } }
}

async function renderConnections(overseer: ReturnType<typeof workspace>['overseer']) {
  const gadget = { getId: async () => 'triage', getTitle: async () => 'Triage', listBindings: async () => [] }
  const authenticatedApi = { listGatekeeperVendors: async () => [] }
  await view.render(
    <Connections overseer={overseer as never} gadget={gadget as never} authenticatedApi={authenticatedApi as never} />,
  )
  await act(async () => {})
}

const isOn = () => hookSwitch(TITLE).getAttribute('aria-checked') === 'true'

const resource = (name: string, target: number, resourceTitle: string): ResourceBindingInfo =>
  ({ name, target, resourceTitle, vendorId: 'slack' })

const connectionFixture = () => {
  const chatBindings = [resource('SLACK_CTO', 5, 'Cloudflare - CTO'), resource('SLACK_SUCCESS', 6, 'Customer Success')]
  const gadgetBindings: GadgetBindingInfo[] = [resource('SLACK_WORKSPACE', 5, 'Cloudflare - CTO')]
  const overseer = { ...workspace().overseer, listChatBindings: vi.fn<(chatId: number) => Promise<ResourceBindingInfo[]>>(async () => chatBindings) }
  const gadget = {
    getId: async () => 10, getTitle: async () => 'Megamind', listBindings: async () => gadgetBindings,
    unbind: vi.fn<(name: string) => Promise<void>>(async () => {}),
  }
  const render = async (chatId = 0, withGadget = true, isAgentActive = false) => {
    await view.render(<Connections overseer={overseer as never} gadget={withGadget ? gadget as never : undefined}
      chatId={chatId} authenticatedApi={{ listGatekeeperVendors: async () => [] } as never}
      isVisible isAgentActive={isAgentActive} />)
  }
  return { chatBindings, gadgetBindings, overseer, gadget, render }
}

it('shows chat-only connections and gadget bindings with their scopes and shared connection', async () => {
  const { overseer, render } = connectionFixture()
  await render()
  const chat = document.querySelector('[aria-label="Chat connections"]')!
  expect(chat.textContent).toContain('SLACK_CTO')
  expect(chat.textContent).toContain('SLACK_SUCCESS')
  expect(chat.textContent).toContain('Same connection used by Megamind as SLACK_WORKSPACE')
  expect(document.body.textContent).toContain('This gadget: Megamind')
  // Chat entries have no gadget rename/delete controls. There is just one editable gadget edge.
  expect(chat.querySelector('button')).toBeNull()
  expect(document.querySelectorAll('button[aria-label="Delete connection"]')).toHaveLength(1)
  expect(overseer.listChatBindings).toHaveBeenCalledWith(0)
})

it('keeps chat connections visible when removing their gadget binding', async () => {
  const { gadgetBindings, gadget, render } = connectionFixture()
  gadget.unbind.mockImplementation(async () => { gadgetBindings.splice(0) })
  await render()
  await act(async () => (document.querySelector('button[aria-label="Delete connection"]') as HTMLButtonElement).click())
  const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === 'Delete')!
  await act(async () => confirm.click())
  expect(gadget.unbind).toHaveBeenCalledExactlyOnceWith('SLACK_WORKSPACE')
  const chat = document.querySelector('[aria-label="Chat connections"]')!
  expect(chat.textContent).toContain('SLACK_CTO')
  expect(chat.textContent).toContain('SLACK_SUCCESS')
  expect(chat.textContent).not.toContain('Same connection used by')
})

it('lists chat resources without requiring a gadget', async () => {
  const { render } = connectionFixture()
  await render(0, false)
  expect(document.querySelector('[aria-label="Chat connections"]')?.textContent).toContain('SLACK_SUCCESS')
  expect(document.body.textContent).not.toContain('This gadget')
  expect(document.querySelector('button[aria-label="Delete connection"]')).toBeNull()
})

it('refreshes connections after a visible chat finishes an agent turn', async () => {
  const { chatBindings, render } = connectionFixture()
  await render(0, true, true)
  chatBindings.push(resource('NEW_CONNECTION', 7, 'New resource'))
  await render(0, true, false)
  expect(document.querySelector('[aria-label="Chat connections"]')?.textContent).toContain('NEW_CONNECTION')
})

it('does not let an older chat load overwrite the selected chat', async () => {
  const { overseer, render } = connectionFixture()
  const old = deferred<ResourceBindingInfo[]>()
  overseer.listChatBindings.mockImplementation(chatId => chatId === 0 ? old.promise : Promise.resolve([resource('CURRENT', 8, 'Current resource')]))
  await render(0)
  await render(1)
  await old.resolve([resource('OLD', 9, 'Old resource')])
  expect(document.querySelector('[aria-label="Chat connections"]')?.textContent).toContain('CURRENT')
  expect(document.body.textContent).not.toContain('Old resource')
})

it('shows a retryable load error rather than an empty connection list', async () => {
  const { overseer, render } = connectionFixture()
  overseer.listChatBindings.mockRejectedValue(new Error('Disconnected'))
  await render()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load connections')
  expect(document.body.textContent).not.toContain('No resource connections')
  overseer.listChatBindings.mockResolvedValue([resource('RETRIED', 5, 'Retried resource')])
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Refresh')!.click())
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(document.querySelector('[aria-label="Chat connections"]')?.textContent).toContain('RETRIED')
})

it("names a hook's switch after the hook, which says whether it is on", async () => {
  await renderConnections(workspace().overseer)

  expect(hookSwitch(TITLE).getAttribute('role')).toBe('switch')
  expect(isOn()).toBe(false)
})

it('turns a hook on and off', async () => {
  const { overseer } = workspace()
  await renderConnections(overseer)

  await clickHookSwitch(TITLE)
  expect(overseer.enableHook).toHaveBeenCalledExactlyOnceWith(7)
  expect(isOn()).toBe(true)
  await clickHookSwitch(TITLE)
  expect(overseer.disableHook).toHaveBeenCalledExactlyOnceWith(7)
  expect(isOn()).toBe(false)
  expect(addToast).not.toHaveBeenCalled()
})

it.each([
  ['enabled', false, 'enableHook', new Error(refusal), refusal],
  ['enabled', false, 'enableHook', new Error('Peer closed WebSocket: 1006 '), undefined],
  ['disabled', true, 'disableHook', new Error(refusal), refusal],
  ['disabled', true, 'disableHook', new Error('Peer closed WebSocket: 1006 '), undefined],
] as const)(
  'says why a hook could not be %s, though not a dropped connection’s transport message, and turns it back',
  async (done, enabled, method, failure, description) => {
    const { overseer } = workspace(enabled)
    overseer[method].mockRejectedValueOnce(failure)
    await renderConnections(overseer)

    await clickHookSwitch(TITLE)

    expect(addToast).toHaveBeenCalledExactlyOnceWith({
      title: `Failed to ${done === 'enabled' ? 'enable' : 'disable'} hook`, description, variant: 'error',
    })
    expect(isOn()).toBe(enabled)
  })

it('shows a change at once, holds the switch busy while it is in flight, and lets a failed one be retried', async () => {
  const { overseer } = workspace()
  const first = deferred()
  overseer.enableHook.mockReturnValueOnce(first.promise)
  await renderConnections(overseer)

  await clickHookSwitch(TITLE)
  expect(isOn()).toBe(true)
  expect(hookSwitch(TITLE).getAttribute('aria-disabled')).toBe('true')
  expect(hookSwitch(TITLE).getAttribute('aria-busy')).toBe('true')
  // A second click while the first is in flight changes nothing.
  await clickHookSwitch(TITLE)
  expect(overseer.enableHook).toHaveBeenCalledOnce()
  expect(overseer.disableHook).not.toHaveBeenCalled()

  await first.reject(new Error(refusal))
  expect(isOn()).toBe(false)
  expect(hookSwitch(TITLE).hasAttribute('aria-disabled')).toBe(false)
  expect(hookSwitch(TITLE).hasAttribute('aria-busy')).toBe(false)

  await clickHookSwitch(TITLE)
  expect(overseer.enableHook).toHaveBeenCalledTimes(2)
  expect(isOn()).toBe(true)
})
