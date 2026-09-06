// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodingSessionRepository, CodingSessionRuntime, CodingSessionSummary } from '@gadgets/workshop-shared/api'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'

const testState = vi.hoisted(() => ({
  piEnabled: false,
  piLoading: false,
  terminalMounts: 0,
  terminalProps: vi.fn<(props: unknown) => void>(),
  workbenchMounts: 0,
  workbenchProps: vi.fn<(props: unknown) => void>(),
  authenticatedApi: {
    codingSessionEditorAvailable: vi.fn<() => Promise<boolean>>(async () => true),
    mintCodingSessionEditorCapability: vi.fn<() => Promise<{ url: string; expiresAt: Date }>>(async () => ({
      url: 'https://odie-os-gk-sessions.example.workers.dev/c/test-token/',
      expiresAt: new Date(Date.now() + 60_000),
    })),
  },
  context: {
    github: { state: 'missing' } as
      | { state: 'missing' }
      | { state: 'expired'; accountId: number; label: string }
      | { state: 'connected'; accountId: number; label: string },
    activeSession: undefined as CodingSessionSummary | undefined,
    error: undefined as string | undefined,
    activity: [] as CodingSessionActivity[],
    resolveActivity: vi.fn<(id: string, decision: 'approve' | 'reject') => Promise<void>>(),
    restartSession: vi.fn<(id: string) => Promise<void>>(),
    stopSession: vi.fn<(id: string) => Promise<void>>(),
    archiveSession: vi.fn<(id: string) => Promise<void>>(),
    setActiveId: vi.fn<(id: string | undefined) => void>(),
    refresh: vi.fn<() => void>(),
    connect: vi.fn<() => Promise<void>>(async () => {}),
    reconnect: vi.fn<(accountId: number) => Promise<void>>(async () => {}),
    availablePresets: [],
    repositories: ['jarvis'],
    setRepositories: vi.fn<(repositories: CodingSessionRepository[]) => void>(),
    repositoryOptions: [{ repository: 'jarvis', title: 'totango/jarvis', private: true }],
    repositorySearch: '',
    setRepositorySearch: vi.fn<(query: string) => void>(),
    repositoryLoading: false,
    title: 'Fix Jarvis',
    setTitle: vi.fn<(title: string) => void>(),
    runtime: 'opencode' as CodingSessionRuntime,
    setRuntime: vi.fn<(runtime: CodingSessionRuntime) => void>(),
    creating: false,
    create: vi.fn<() => Promise<void>>(async () => {}),
  },
}))

vi.mock('../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
vi.mock('../components/sessions/SessionsContext', () => ({
  useSessionsContext: () => testState.context,
}))
vi.mock('../components/sessions/LazySessionTerminal', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    default: (props: unknown) => {
      const [mountId] = React.useState(() => ++testState.terminalMounts)
      testState.terminalProps({ ...(props as object), mountId })
      return null
    },
  }
})
vi.mock('../components/sessions/OpenCodeWorkbench', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    default: (props: unknown) => {
      const [mountId] = React.useState(() => ++testState.workbenchMounts)
      testState.workbenchProps({ ...(props as object), mountId })
      return null
    },
  }
})
vi.mock('../FeatureFlagsContext', () => ({
  useUiFeatureFlag: () => ({ enabled: testState.piEnabled, loading: testState.piLoading }),
}))

import { SessionsPage } from './sessions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SessionsPage locked Code setup', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
    testState.context.github = { state: 'missing' }
    testState.context.error = undefined
    testState.context.activity = []
    testState.context.activeSession = undefined
    testState.context.runtime = 'opencode'
    testState.context.refresh.mockClear()
    testState.terminalMounts = 0
    testState.workbenchMounts = 0
    testState.piEnabled = false
    testState.piLoading = false
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SessionsPage />))
    return container
  }

  it('shows setup and connects when GitHub is missing', async () => {
    const rendered = await render()

    expect(rendered.textContent).toContain('Set up Code')
    expect(rendered.textContent).toContain('Chat remains usable')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Connect GitHub'))
    expect(button).toBeTruthy()

    await act(async () => button!.click())

    expect(testState.context.connect).toHaveBeenCalledOnce()
    expect(testState.context.reconnect).not.toHaveBeenCalled()
  })

  it('reconnects the expired GitHub account and preserves provider error copy', async () => {
    testState.context.github = { state: 'expired', accountId: 42, label: 'octo@example.com' }
    testState.context.error = 'Provider reported expired credentials.'
    const rendered = await render()

    expect(rendered.textContent).toContain('Reconnect octo@example.com')
    expect(rendered.textContent).toContain('Provider reported expired credentials.')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Reconnect GitHub'))
    expect(button).toBeTruthy()

    await act(async () => button!.click())

    expect(testState.context.reconnect).toHaveBeenCalledWith(42)
    expect(testState.context.connect).not.toHaveBeenCalled()
  })

  it('offers Pi and Prime Agent only when the coding-runtime flag is enabled', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    let rendered = await render()

    expect(rendered.textContent).not.toContain('Coding agent')

    await act(async () => root?.unmount())
    root = undefined
    container?.remove()
    container = undefined
    testState.piEnabled = true
    rendered = await render()

    expect(rendered.textContent).toContain('Coding agent')
    const piButton = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.startsWith('Pi'))
    const primeButton = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.startsWith('Prime Agent'))
    expect(piButton).toBeTruthy()
    expect(primeButton).toBeTruthy()

    await act(async () => piButton!.click())
    await act(async () => primeButton!.click())
    expect(testState.context.setRuntime).toHaveBeenCalledWith('pi')
    expect(testState.context.setRuntime).toHaveBeenCalledWith('prime-agent')
  })

  it('resets an alternate runtime when the coding-runtime flag is disabled', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.runtime = 'prime-agent'

    await render()

    expect(testState.context.setRuntime).toHaveBeenCalledWith('opencode')
  })

  it('preserves an alternate runtime while the rollout flag is loading', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.runtime = 'prime-agent'
    testState.piLoading = true

    await render()

    expect(testState.context.setRuntime).not.toHaveBeenCalled()
  })

  it('labels the primary terminal with the persisted runtime', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Pi repair',
      repositories: ['jarvis'],
      runtime: 'pi',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()
    const terminalMode = rendered.querySelector('[aria-label="Workbench tools"]')

    expect(terminalMode?.textContent).toContain('Agent')
    expect(terminalMode?.textContent).toContain('Pi')
    expect(terminalMode?.textContent).toContain('Terminal')
    expect(terminalMode?.textContent).toContain('Changes')
    expect(terminalMode?.textContent).not.toContain('OpenCode')
    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'pi', terminalKind: 'opencode' }))
  })

  it('labels the primary terminal for a persisted Prime Agent session', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-prime',
      title: 'Prime repair',
      repositories: ['jarvis'],
      runtime: 'prime-agent',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()
    expect(rendered.querySelector('[aria-label="Workbench tools"]')?.textContent).toContain('Prime Agent')
    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'prime-agent', terminalKind: 'opencode' }))
  })

  it('defaults running OpenCode sessions to the Agent tab with the structured workbench', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-opencode',
      title: 'OpenCode repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.querySelector('[aria-label="Workbench tools"]')?.textContent).toContain('Agent')
    expect(rendered.querySelector('[aria-label="Workbench tools"]')?.textContent).toContain('VS Code')
    expect(testState.workbenchProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-opencode', sessionTitle: 'OpenCode repair' }))
    expect(testState.terminalProps).not.toHaveBeenCalled()
  })

  it('keeps Terminal and Changes available for OpenCode without removing pending activity', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activity = [{
      id: 'approval-1',
      sessionId: 'session-opencode',
      state: 'pending',
      resourceTitle: 'GitHub',
      vendorId: 'github',
      type: 'action',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      description: { title: 'Push', description: 'Push branch' },
    }]
    testState.context.activeSession = {
      id: 'session-opencode', title: 'OpenCode repair', repositories: ['jarvis'], runtime: 'opencode', status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'), lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()
    const shellTab = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Terminal'))
    expect(shellTab).toBeTruthy()
    expect(rendered.textContent).toContain('Tool approvals')

    await act(async () => shellTab!.click())

    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ terminalKind: 'shell', runtime: 'opencode' }))
    const terminalMountId = (testState.terminalProps.mock.calls.at(-1)![0] as { mountId: number }).mountId
    expect(rendered.textContent).toContain('Push')

    const changesTab = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Changes'))
    await act(async () => changesTab!.click())
    expect(testState.workbenchProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-opencode', surface: 'changes' }))
    expect(testState.workbenchMounts).toBe(1)
    expect((testState.terminalProps.mock.calls.at(-1)![0] as { mountId: number }).mountId).toBe(terminalMountId)
    testState.context.activity = []
  })

  it('refreshes sessions when the terminal reports the environment is unavailable', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Pi repair',
      repositories: ['jarvis'],
      runtime: 'pi',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    await render()
    const props = testState.terminalProps.mock.calls.at(-1)?.[0] as { onSessionUnavailable?: () => void }
    props.onSessionUnavailable?.()

    expect(testState.context.refresh).toHaveBeenCalledOnce()
  })

  it('presents restart instead of terminal reconnect for expired environments', async () => {
    window.confirm = vi.fn<() => boolean>(() => true)
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Expired repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'failed',
      error: 'Coding session environment expired. Restart the session to continue.',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.textContent).toContain('Environment needs restart')
    expect(rendered.textContent).not.toContain('Reconnect')
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Restart environment'))
    expect(button).toBeTruthy()

    await act(async () => button!.click())
    expect(testState.context.restartSession).toHaveBeenCalledWith('session-1')
  })

  it('shows a neutral progress panel while an active session is starting', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Starting repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'starting',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.textContent).toContain('Starting environment')
    expect(rendered.textContent).not.toContain('Environment needs restart')
    expect(testState.terminalProps).not.toHaveBeenCalled()
  })

  it('shows a neutral progress panel while an active session is stopping', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Stopping repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'stopping',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.textContent).toContain('Stopping environment')
    expect(rendered.textContent).not.toContain('Environment needs restart')
    expect(testState.terminalProps).not.toHaveBeenCalled()
  })

  it('transitions from starting progress to the terminal when refreshed state becomes running', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Starting repair',
      repositories: ['jarvis'],
      runtime: 'opencode',
      status: 'starting',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    const rendered = await render()
    expect(rendered.textContent).toContain('Starting environment')

    testState.context.activeSession = { ...testState.context.activeSession, status: 'running' } as CodingSessionSummary
    await act(async () => root!.render(<SessionsPage />))

    expect(rendered.textContent).not.toContain('Starting environment')
    expect(testState.workbenchProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }))
  })

  it('hides browser VS Code when the deployment has no separate editor origin', async () => {
    testState.authenticatedApi.codingSessionEditorAvailable.mockResolvedValueOnce(false)
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1', title: 'Repair', repositories: ['jarvis'], runtime: 'opencode', status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'), lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }

    const rendered = await render()

    expect(rendered.querySelector('[aria-label="Open browser VS Code"]')).toBeNull()
  })

  it('opens a generation-bound browser VS Code capability on its separate origin', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1', title: 'Editor repair', repositories: ['jarvis'], runtime: 'prime-agent', status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'), lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    const replace = vi.fn<(url: string) => void>()
    const popup = { opener: window, location: { replace }, close: vi.fn<() => void>() }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    const rendered = await render()
    const button = rendered.querySelector<HTMLButtonElement>('[aria-label="Open browser VS Code"]')
    expect(button).toBeTruthy()
    await act(async () => button!.click())

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(popup.opener).toBeNull()
    expect(testState.authenticatedApi.mintCodingSessionEditorCapability).toHaveBeenCalledWith('session-1')
    expect(replace).toHaveBeenCalledWith('https://odie-os-gk-sessions.example.workers.dev/c/test-token/')
  })

  it('does not remount a running terminal when only lastActiveAt changes', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-1',
      title: 'Pi repair',
      repositories: ['jarvis'],
      runtime: 'pi',
      status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'),
      lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    await render()
    const firstProps = testState.terminalProps.mock.calls.at(-1)?.[0]
    expect(firstProps).toBeDefined()
    const firstMountId = (firstProps as { mountId: number }).mountId

    testState.context.activeSession = {
      ...testState.context.activeSession,
      lastActiveAt: new Date('2026-08-18T00:05:00Z'),
    } as CodingSessionSummary
    await act(async () => root!.render(<SessionsPage />))

    const latestProps = testState.terminalProps.mock.calls.at(-1)?.[0]
    expect(latestProps).toBeDefined()
    expect((latestProps as { mountId: number }).mountId).toBe(firstMountId)
  })

  it('does not carry an opened OpenCode shell terminal across a session switch before effects reset it', async () => {
    testState.context.github = { state: 'connected', accountId: 42, label: 'octo@example.com' }
    testState.context.activeSession = {
      id: 'session-opencode-1', title: 'First', repositories: ['jarvis'], runtime: 'opencode', status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'), lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    const rendered = await render()
    const shellTab = Array.from(rendered.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes('Terminal'))
    expect(shellTab).toBeTruthy()

    await act(async () => shellTab!.click())
    expect(testState.terminalProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-opencode-1', terminalKind: 'shell' }))
    testState.terminalProps.mockClear()

    testState.context.activeSession = {
      id: 'session-opencode-2', title: 'Second', repositories: ['jarvis'], runtime: 'opencode', status: 'running',
      createdAt: new Date('2026-08-18T00:00:00Z'), lastActiveAt: new Date('2026-08-18T00:00:00Z'),
    }
    await act(async () => root!.render(<SessionsPage />))

    expect(testState.workbenchProps).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-opencode-2' }))
    expect(testState.terminalProps).not.toHaveBeenCalled()
  })
})
