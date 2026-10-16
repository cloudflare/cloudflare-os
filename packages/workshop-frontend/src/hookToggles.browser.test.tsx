/* eslint-disable react/react-in-jsx-scope */

// The hook switches on the Connections page, in the Activity log and in chat, in Chromium: real
// pointer and keyboard input, and focus, which jsdom does not model. What the switches do on each
// failure is tested in each surface's own suite; this one is about reaching and working them.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Toasty, TooltipProvider } from '@cloudflare/kumo'
import type { AiChatMessage, BoundHookInfo } from '@gadgets/workshop-shared/api'

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { listGatekeeperVendors: async () => [] }, currentUser: null }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => context }
})
vi.mock('./useAlwaysApproveTag', () => ({
  useAlwaysApproveTag: () => ({ alwaysApproveTag: async () => {}, isTagAutoApproved: () => false }),
}))

import { deferred, entry, makeOverseer } from './action-test-harness'
import Activity from './Activity'
import ChatInterface from './ChatInterface'
import Connections from './Connections'

// The harness holds animation frames for jsdom suites to release by hand; this one has real ones.
vi.unstubAllGlobals()

const TITLE = 'Watch acme/widgets on GitHub'
const refusal = "GitHub refused to add a webhook to acme/widgets: only the repository's admins can."
const hookSwitch = () => page.getByRole('switch', { name: `Hook: ${TITLE}` })

let root: Root | undefined
let container: HTMLElement | undefined

async function render(node: React.ReactNode) {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(<TooltipProvider><Toasty>{node}</Toasty></TooltipProvider>))
}

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

/** Tab forward to the switch, as a keyboard user reaches it. */
async function tabToSwitch() {
  for (let presses = 0; presses < 10 && document.activeElement !== hookSwitch().element(); presses++) {
    await input(() => userEvent.tab())
  }
  await expect.element(hookSwitch()).toHaveFocus()
}

beforeEach(() => {
  // Each failure is logged as well as shown.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  vi.restoreAllMocks()
})

/** A workspace with one hook on the gadget, which `listHooks()` reports as the server has it. */
function workspace() {
  const server = { enabled: false }
  const listHooks = async () => [{
    id: 7, gatekeeperId: 'github', gadgetId: 'triage', resourceTitle: 'acme/widgets',
    description: { title: TITLE, description: 'Call this hook with each issue event.' }, enabled: server.enabled,
  } as unknown as BoundHookInfo]
  const enableHook = vi.fn<(id: number) => Promise<void>>(async () => { server.enabled = true })
  const disableHook = vi.fn<(id: number) => Promise<void>>(async () => { server.enabled = false })
  return { server, overseer: { listHooks, enableHook, disableHook, [Symbol.dispose]: () => {} } }
}

/** The hook's record in the action log, as a bindHook card or history row shows it. */
const bound = (enabled: boolean) => entry(1, {
  type: 'bindHook', state: 'approved', hookId: 7, enabled,
  description: { title: TITLE, description: 'Call this hook with each issue event.' },
})

async function renderConnections(overseer: ReturnType<typeof workspace>['overseer']) {
  const gadget = { getId: async () => 'triage', getTitle: async () => 'Triage', listBindings: async () => [] }
  await render(
    <Connections overseer={overseer as never} gadget={gadget as never}
      authenticatedApi={{ listGatekeeperVendors: async () => [] } as never} />,
  )
  await expect.element(hookSwitch()).toBeVisible()
}

describe('on the Connections page', () => {
  it('turns a hook on with Space and off with Enter, keeping focus while each change is in flight', async () => {
    const { server, overseer } = workspace()
    const change = deferred()
    overseer.enableHook.mockImplementationOnce(async () => {
      await change.promise
      server.enabled = true
    })
    await renderConnections(overseer)

    await tabToSwitch()
    await input(() => userEvent.keyboard(' '))
    expect(overseer.enableHook).toHaveBeenCalledExactlyOnceWith(7)
    // Busy, and still where the keyboard left it.
    await expect.element(hookSwitch()).toHaveAttribute('aria-busy', 'true')
    await expect.element(hookSwitch()).toHaveFocus()
    // Another press while the change is in flight does nothing.
    await input(() => userEvent.keyboard(' '))
    expect(overseer.disableHook).not.toHaveBeenCalled()

    await change.resolve()
    await expect.element(hookSwitch()).toHaveAttribute('aria-checked', 'true')
    await expect.element(hookSwitch()).not.toHaveAttribute('aria-busy')
    await expect.element(hookSwitch()).toHaveFocus()
    await input(() => userEvent.keyboard('{Enter}'))
    expect(overseer.disableHook).toHaveBeenCalledExactlyOnceWith(7)
    await expect.element(hookSwitch()).toHaveAttribute('aria-checked', 'false')
  })

  it('says why a click could not turn a hook on, and turns the switch back', async () => {
    const { overseer } = workspace()
    overseer.enableHook.mockRejectedValueOnce(new Error(refusal))
    await renderConnections(overseer)

    await input(() => userEvent.click(hookSwitch()))

    await expect.element(page.getByText('Failed to enable hook')).toBeVisible()
    await expect.element(page.getByText(refusal)).toBeVisible()
    await expect.element(hookSwitch()).toHaveAttribute('aria-checked', 'false')
  })
})

describe('in the Activity log', () => {
  it('reaches a hook switch from the keyboard in an expanded record, and turns the hook on', async () => {
    const server = makeOverseer()
    const enableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    Object.assign(server.overseer as object, { enableHook, disableHook: async () => {} })
    await render(<Activity overseer={server.overseer} restricted={false} view="history" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePage({ entries: [bound(false)] })

    await input(() => userEvent.click(page.getByRole('button', { name: new RegExp(TITLE) })))
    await tabToSwitch()
    await input(() => userEvent.keyboard(' '))

    expect(enableHook).toHaveBeenCalledExactlyOnceWith(7)
    await server.emit(bound(true))
    await expect.element(hookSwitch()).toHaveAttribute('aria-checked', 'true')
  })
})

describe('in chat', () => {
  it('turns a hook bound in the chat on with a click and off from the keyboard', async () => {
    const server = makeOverseer()
    let subscriber: { message: (message: AiChatMessage) => void } | undefined
    const enableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    const disableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    Object.assign(server.overseer as object, {
      enableHook, disableHook,
      getChatMessage: async () => null,
      getChatHistory: async () => ({ messages: [] }),
      listChats: async () => [{ id: 1, title: 'Chat', started: new Date(), lastActive: new Date() }],
      listModels: async () => [],
      onRpcBroken: () => {},
      subscribeToChat: (next: typeof subscriber) => {
        subscriber = next
        return { [Symbol.dispose]: () => {} }
      },
    })
    await render(
      <ChatInterface workspaceId="workspace" overseer={server.overseer} selectedChatId={1}
        onNavigateToChat={() => {}} pendingConsoleLogCount={0} consoleLogPreview="" consoleLogSeverity="info"
        onConsumeConsoleLogs={() => ''} onDiscardConsoleLogs={() => {}} onOpenGadget={() => {}}
        outputOfWorkpiece={() => undefined} />,
    )
    await server.resolveSubscription()
    await act(async () => subscriber!.message({
      chatId: 1, sequence: 0, timestamp: new Date(), author: { type: 'agent', id: 'model', name: 'Model' },
      type: 'action', actionId: 1, actionLog: bound(false),
    } as AiChatMessage))

    await input(() => userEvent.click(hookSwitch()))
    expect(enableHook).toHaveBeenCalledExactlyOnceWith(7)
    await server.emit(bound(true))
    await expect.element(hookSwitch()).toHaveAttribute('aria-checked', 'true')

    await expect.element(hookSwitch()).toHaveFocus()
    await input(() => userEvent.keyboard(' '))
    expect(disableHook).toHaveBeenCalledExactlyOnceWith(7)
    await server.emit(bound(false))
    await expect.element(hookSwitch()).toHaveAttribute('aria-checked', 'false')
  })
})
