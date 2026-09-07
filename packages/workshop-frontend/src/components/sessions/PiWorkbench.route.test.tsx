// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionPiCommand, CodingSessionPiConnection, CodingSessionRuntime } from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => ({
  api: {
    codingSessionEditorAvailable: vi.fn<() => Promise<boolean>>(async () => false),
    connectCodingSessionPi: vi.fn<() => Promise<CodingSessionPiConnection>>(),
    callCodingSessionPi: vi.fn<(id: string, handle: string, command: CodingSessionPiCommand) => Promise<{ json: string }>>(async (_id, _handle, command) => ({ json: JSON.stringify(
      command.type === 'events' ? { cursor: 0, dead: false, truncated: false, events: [], dialogs: [] }
        : command.type === 'get_messages' ? { messages: [] } : command.type === 'get_entries' ? { entries: [] } : command.type === 'get_tree' ? { tree: [] } : { isStreaming: false },
    ) })),
  },
  terminal: vi.fn<(props: { terminalKind: string; runtime: string }) => void>(),
  context: {
    github: { state: 'connected' },
    activeSession: { id: 'pi-session', runtime: 'pi' as CodingSessionRuntime, status: 'running', title: 'Pi session', repositories: ['repo'], lastActiveAt: new Date() },
    initialInput: 'prepared context',
    markInitialInputSent: vi.fn<() => void>(),
    activity: [{ id: 'approval', sessionId: 'pi-session', state: 'pending', resourceTitle: 'Workshop tool', description: { title: 'Write external data', description: 'Requires Workshop approval' } }],
    resolveActivity: vi.fn<(id: string, decision: 'approve' | 'reject') => Promise<void>>(async () => {}),
    refresh: vi.fn<() => void>(),
  },
}))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: mocks.api }) }))
vi.mock('./SessionsContext', () => ({ useSessionsContext: () => mocks.context }))
vi.mock('../../FeatureFlagsContext', () => ({ useUiFeatureFlag: () => ({ enabled: true, loading: false }) }))
vi.mock('./OpenCodeWorkbench', () => ({ default: () => <div>OpenCode workbench</div> }))
vi.mock('./LazySessionTerminal', () => ({ default: (props: { terminalKind: string; runtime: string }) => { mocks.terminal(props); return <div>Terminal {props.terminalKind}</div> } }))

import { SessionsPage } from '../../routes/sessions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Pi workbench route integration', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.context.activeSession.runtime = 'pi'
    mocks.api.connectCodingSessionPi.mockImplementation(async () => {
      const pi = mocks.context.activeSession.runtime === 'pi'
      return { mode: 'rpc', runtime: pi ? 'pi' : 'prime', capabilities: { messages: 'current-context', history: pi ? 'persisted-entries' : 'unavailable', tree: pi, settlement: pi ? 'agent_settled' : 'unavailable', messageUpdates: pi ? 'delta' : 'cumulative' }, version: 1, connectionId: 'handle', expiresAt: new Date(Date.now() + 300_000) }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  async function render() {
    await act(async () => root.render(<SessionsPage />))
    await waitForPi()
  }
  async function waitForPi() {
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(container.querySelector('[aria-label$="workbench"]')).not.toBeNull()
    }, { timeout: 5000 })
  }
  async function tab(name: string) {
    const button = [...container.querySelectorAll('[aria-pressed]')].find((item) => item.textContent?.trim().startsWith(name)) as HTMLButtonElement
    await act(async () => button.click())
  }

  it.each(['pi', 'prime-agent'] as const)('attaches %s once, opens only a shell on Terminal, and keeps Workshop approvals on every surface', async (runtime) => {
    mocks.context.activeSession.runtime = runtime
    await render()
    expect(container.querySelector('[aria-label$="workbench"]')).not.toBeNull()
    expect(mocks.terminal).not.toHaveBeenCalled()
    for (const name of ['Terminal', 'Changes', 'Agent']) {
      await tab(name)
      expect(container.textContent).toContain('Tool approvals')
      expect(container.textContent).toContain('Write external data')
    }
    expect(mocks.terminal.mock.calls.every(([props]) => props.terminalKind === 'shell')).toBe(true)
    expect(mocks.api.connectCodingSessionPi).toHaveBeenCalledOnce()
    expect(mocks.context.markInitialInputSent).not.toHaveBeenCalled()
    const approve = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Approve')!
    await act(async () => approve.click())
    expect(mocks.context.resolveActivity).toHaveBeenCalledWith('approval', 'approve')
    expect(mocks.api.callCodingSessionPi.mock.calls.every(([, , command]) => command.type !== 'extension_ui_response')).toBe(true)
    mocks.context.activeSession = { ...mocks.context.activeSession, lastActiveAt: new Date() }
    await render()
    expect(mocks.api.connectCodingSessionPi).toHaveBeenCalledOnce()
  })

  it('uses the Prime terminal only on an explicit legacy fallback', async () => {
    mocks.context.activeSession.runtime = 'prime-agent'
    mocks.api.connectCodingSessionPi.mockResolvedValue({ mode: 'terminal', reason: 'Legacy Prime session has no owner bridge' })
    await act(async () => root.render(<SessionsPage />))
    expect(container.textContent).toContain('Legacy Prime session has no owner bridge')
    expect(mocks.terminal).toHaveBeenCalledWith(expect.objectContaining({ terminalKind: 'opencode', runtime: 'prime-agent' }))
    expect(mocks.api.connectCodingSessionPi).toHaveBeenCalledOnce()
    expect(mocks.api.callCodingSessionPi).not.toHaveBeenCalled()
  })
})
