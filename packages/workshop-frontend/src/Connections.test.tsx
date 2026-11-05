// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BoundHookInfo, GadgetClient } from '@gadgets/workshop-shared/api'
import type { GatekeeperModalProps } from './GatekeeperModal'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())
const modal = vi.hoisted(() => ({ props: undefined as GatekeeperModalProps | undefined }))

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { listGatekeeperVendors: async () => [] }, currentUser: null }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => context }
})

vi.mock('./GatekeeperModal', () => ({
  default: (props: GatekeeperModalProps) => {
    modal.props = props
    return null
  },
}))

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

/** A gadget stub whose binds go through `bind`. */
const gadgetStub = (bind: GadgetClient['bindWithSuggestedName']) => ({
  getId: async () => 3,
  getTitle: async () => 'Triage',
  listBindings: async () => [],
  bindWithSuggestedName: vi.fn<GadgetClient['bindWithSuggestedName']>(bind),
})

it('binds a connection whose creation restarted the workspace once the session is replaced, without creating another', async () => {
  const dying = gadgetStub(async () => {
    throw new Error('The workspace is restarting to apply a connection change. Please retry.')
  })
  const reconnected = gadgetStub(async () => 'KIBANA')
  const onConnectionsChange = vi.fn<() => void>()
  const render = (stub: typeof dying, chatId: number) => view.render(
    <Connections overseer={workspace().overseer as never} gadget={stub as never} chatId={chatId}
      authenticatedApi={{ listGatekeeperVendors: async () => [] } as never}
      onConnectionsChange={onConnectionsChange} />,
  )

  await render(dying, 1)
  // Resolving is what closes the modal rather than leaving it to create a second connection.
  await act(() => expect(modal.props!.onCreated({ [Symbol.dispose]() {} } as never, 9)).resolves.toBeUndefined())

  // A chat switch while the old session goes down must not spend the retry on it.
  await render(dying, 2)
  expect(dying.bindWithSuggestedName).toHaveBeenCalledOnce()

  await render(reconnected, 2)
  await act(async () => {})
  expect(reconnected.bindWithSuggestedName).toHaveBeenCalledWith(9, 1)
  expect(onConnectionsChange).toHaveBeenCalledOnce()
})
