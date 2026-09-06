import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  Archive,
  ArrowClockwise,
  ArrowLeft,
  Check,
  Code,
  GitDiff,
  GithubLogo,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  Stop,
  TerminalWindow,
  X,
} from '@phosphor-icons/react'
import type { CodingSessionRepository, CodingSessionRuntime } from '@gadgets/workshop-shared/api'
import type { CodingSessionActivity } from '@gadgets/workshop-shared/coding-sessions'
import { useDocumentTitle } from '../useDocumentTitle'
import { useAuthenticatedApi } from '../AuthContext'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../components/WorkshopControls'
import OpenCodeWorkbench from '../components/sessions/OpenCodeWorkbench'
import LazySessionTerminal from '../components/sessions/LazySessionTerminal'
import { useSessionsContext } from '../components/sessions/SessionsContext'
import { useUiFeatureFlag } from '../FeatureFlagsContext'

export const Route = createFileRoute('/sessions')({ component: SessionsPage })

function runtimeLabel(runtime: CodingSessionRuntime): string {
  if (runtime === 'pi') return 'Pi'
  if (runtime === 'prime-agent') return 'Prime Agent'
  return 'OpenCode'
}

type WorkbenchTab = 'agent' | 'terminal' | 'changes'

export function SessionsPage() {
  useDocumentTitle('Code')
  const { authenticatedApi } = useAuthenticatedApi()
  const sessions = useSessionsContext()
  const {
    github,
    activeSession,
    error,
    activity,
    initialInput,
    markInitialInputSent,
    resolveActivity,
    restartSession,
    stopSession,
    archiveSession,
    setActiveId,
    refresh,
  } = sessions
  const [surface, setSurface] = useState<WorkbenchTab>('agent')
  const [openedTerminalSessionId, setOpenedTerminalSessionId] = useState<string>()
  const [editorAvailable, setEditorAvailable] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void authenticatedApi.codingSessionEditorAvailable()
      .then((available) => { if (!cancelled) setEditorAvailable(available) })
      .catch(() => { if (!cancelled) setEditorAvailable(false) })
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    if (!activeSession || activeSession.status !== 'running') return
    setSurface('agent')
    setOpenedTerminalSessionId(undefined)
  }, [activeSession?.id, activeSession?.runtime, activeSession?.status])
  const terminalOpened = activeSession?.id !== undefined && openedTerminalSessionId === activeSession.id

  const openEditor = async (sessionId: string) => {
    if (editorBusy) return
    const popup = window.open('about:blank', '_blank')
    if (!popup) {
      setEditorError('Allow pop-ups to open browser VS Code.')
      return
    }
    popup.opener = null
    setEditorBusy(true)
    setEditorError(undefined)
    try {
      const capability = await authenticatedApi.mintCodingSessionEditorCapability(sessionId)
      popup.location.replace(capability.url)
    } catch (caught) {
      popup.close()
      setEditorError(caught instanceof Error ? caught.message : 'Could not open browser VS Code.')
    } finally {
      setEditorBusy(false)
    }
  }

  if (github.state === 'loading') return <CenteredMessage>Checking GitHub connection…</CenteredMessage>
  if (github.state === 'missing' || github.state === 'expired') return <CodeSetupScreen />

  if (activeSession) {
    const sessionActivity = activity.filter((entry) => entry.sessionId === activeSession.id)
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-kumo-base">
        <div className="shrink-0 border-b border-kumo-line text-kumo-default">
          <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-2 px-3 py-1.5 sm:gap-3">
            <WorkshopIconButton aria-label="Back to new session" onClick={() => setActiveId(undefined)}>
              <ArrowLeft size={16} />
            </WorkshopIconButton>
            <TerminalWindow size={16} className="hidden shrink-0 text-kumo-brand sm:block" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-kumo-strong">{activeSession.title}</div>
              <div className="truncate text-[11px] text-kumo-subtle">{activeSession.repositories.join(' / ')}</div>
            </div>
            <span className={`hidden text-[11px] md:inline ${activeSession.status === 'running' ? 'text-kumo-success' : activeSession.status === 'starting' || activeSession.status === 'stopping' ? 'text-kumo-subtle' : 'text-kumo-danger'}`}>{activeSession.status}</span>
            <WorkshopButton
              title="Discards uncommitted sandbox changes and reclones repositories"
              aria-label="Restart environment"
              onClick={() => {
                if (window.confirm('Restart this environment? Uncommitted sandbox changes will be discarded.')) {
                  void restartSession(activeSession.id)
                }
              }}
            >
              <ArrowClockwise size={13} /> <span className="hidden md:inline">Restart</span>
            </WorkshopButton>
            {activeSession.status === 'running' && (
              <WorkshopButton aria-label="Stop session" onClick={() => stopSession(activeSession.id)}>
                <Stop size={13} /> <span className="hidden sm:inline">Stop</span>
              </WorkshopButton>
            )}
            <WorkshopIconButton aria-label="Archive session" onClick={() => archiveSession(activeSession.id)}>
              <Archive size={15} />
            </WorkshopIconButton>
          </div>
          <div className="flex min-h-10 min-w-0 items-center border-t border-kumo-line px-3 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto" role="toolbar" aria-label="Workbench tools">
              {([
                { value: 'agent' as const, label: 'Agent', icon: TerminalWindow, description: runtimeLabel(activeSession.runtime) },
                { value: 'terminal' as const, label: 'Terminal', icon: TerminalWindow, description: 'Shell' },
                { value: 'changes' as const, label: 'Changes', icon: GitDiff, description: activeSession.runtime === 'opencode' ? 'Diff' : 'Guide' },
              ]).map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={surface === item.value}
                    onClick={() => {
                      setSurface(item.value)
                      if (item.value === 'terminal') setOpenedTerminalSessionId(activeSession.id)
                    }}
                    className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${surface === item.value ? 'border-kumo-brand bg-kumo-base text-kumo-strong shadow-sm' : 'border-kumo-line bg-kumo-tint text-kumo-subtle hover:text-kumo-default'}`}
                  >
                    <Icon size={13} /> {item.label}<span className="hidden text-[10px] text-kumo-inactive sm:inline">{item.description}</span>
                  </button>
                )
              })}
              {activeSession.status === 'running' && editorAvailable && (
                <WorkshopButton
                  title="Open browser VS Code with preinstalled development extensions"
                  aria-label="Open browser VS Code"
                  disabled={editorBusy}
                  onClick={() => void openEditor(activeSession.id)}
                  className="shrink-0"
                >
                  <Code size={13} /> VS Code
                </WorkshopButton>
              )}
            </div>
          </div>
        </div>
        {(error || editorError) && <div role="alert" className="border-b border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">{editorError ?? error}</div>}
        <div className={`grid min-h-0 min-w-0 flex-1 overflow-hidden ${sessionActivity.some((entry) => entry.state === 'pending') ? 'grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-1' : ''}`}>
          <div className="min-h-0 min-w-0 overflow-hidden">
            {activeSession.status === 'running' ? (
              activeSession.runtime === 'opencode' ? (
                <>
                  <div className={surface === 'terminal' ? 'hidden' : 'h-full min-h-0 min-w-0'}>
                    <OpenCodeWorkbench
                      key={activeSession.id}
                      sessionId={activeSession.id}
                      sessionTitle={activeSession.title}
                      initialInput={surface === 'agent' ? initialInput : undefined}
                      onInitialInputSent={() => markInitialInputSent(activeSession.id)}
                      onSessionUnavailable={refresh}
                      surface={surface === 'changes' ? 'changes' : 'agent'}
                    />
                  </div>
                  {terminalOpened && (
                    <div className={surface === 'terminal' ? 'h-full min-h-0 min-w-0' : 'hidden'}>
                      <LazySessionTerminal
                        key={`terminal:${activeSession.id}`}
                        sessionId={activeSession.id}
                        terminalKind="shell"
                        runtime={activeSession.runtime}
                        onInitialInputSent={() => markInitialInputSent(activeSession.id)}
                        onSessionUnavailable={refresh}
                      />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className={surface === 'agent' ? 'h-full min-h-0 min-w-0' : 'hidden'}>
                    <LazySessionTerminal
                      key={`agent:${activeSession.id}:${activeSession.runtime}`}
                      sessionId={activeSession.id}
                      terminalKind="opencode"
                      runtime={activeSession.runtime}
                      initialInput={initialInput}
                      onInitialInputSent={() => markInitialInputSent(activeSession.id)}
                      onSessionUnavailable={refresh}
                    />
                  </div>
                  {terminalOpened && (
                    <div className={surface === 'terminal' ? 'h-full min-h-0 min-w-0' : 'hidden'}>
                      <LazySessionTerminal
                        key={`terminal:${activeSession.id}:${activeSession.runtime}`}
                        sessionId={activeSession.id}
                        terminalKind="shell"
                        runtime={activeSession.runtime}
                        onInitialInputSent={() => markInitialInputSent(activeSession.id)}
                        onSessionUnavailable={refresh}
                      />
                    </div>
                  )}
                  {surface === 'changes' && (
                    <ChangesUnavailablePanel runtime={activeSession.runtime} editorAvailable={editorAvailable} editorBusy={editorBusy} onOpenEditor={() => void openEditor(activeSession.id)} />
                  )}
                </>
              )
            ) : activeSession.status === 'starting' || activeSession.status === 'stopping' ? (
              <SessionProgressPanel session={activeSession} />
            ) : (
              <SessionRecoveryPanel session={activeSession} onRestart={restartSession} />
            )}
          </div>
          {sessionActivity.some((entry) => entry.state === 'pending') && (
            <ActivityPanel activity={sessionActivity} onResolve={resolveActivity} />
          )}
        </div>
      </div>
    )
  }

  return <NewSessionPane />
}

function SessionProgressPanel({ session }: { session: { status: string } }) {
  const copy = session.status === 'starting'
    ? {
        title: 'Starting environment',
        body: 'Preparing this coding session sandbox. The terminal will connect automatically when it is ready.',
      }
    : {
        title: 'Stopping environment',
        body: 'Shutting down this coding session sandbox. The session status will update automatically.',
      }
  return (
    <div className="flex h-full items-center justify-center bg-kumo-tint/30 px-6 text-center">
      <div className="max-w-md rounded-2xl border border-kumo-line bg-kumo-base p-6 shadow-sm">
        <div className="mx-auto h-10 w-10 rounded-full border-2 border-kumo-line border-t-kumo-brand animate-spin" aria-hidden="true" />
        <h2 className="mt-4 text-lg font-semibold text-kumo-default">{copy.title}</h2>
        <p className="mt-2 text-sm leading-6 text-kumo-subtle">{copy.body}</p>
      </div>
    </div>
  )
}

function ChangesUnavailablePanel({ runtime, editorAvailable, editorBusy, onOpenEditor }: { runtime: CodingSessionRuntime; editorAvailable: boolean; editorBusy: boolean; onOpenEditor: () => void }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-kumo-tint/30 px-6 text-center">
      <div className="max-w-md rounded-2xl border border-kumo-line bg-kumo-base p-6 shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-kumo-fill text-kumo-brand">
          <GitDiff size={20} weight="bold" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-kumo-default">Changes live in your editor</h2>
        <p className="mt-2 text-sm leading-6 text-kumo-subtle">
          {runtimeLabel(runtime)} sessions do not expose structured diff data here yet. Use the Agent terminal for guidance, or open browser VS Code to inspect source control safely in the sandbox.
        </p>
        {editorAvailable && (
          <WorkshopButton tone="primary" className="mt-5 !h-10 !rounded-lg !px-4" disabled={editorBusy} onClick={onOpenEditor} aria-label="Open browser VS Code from Changes">
            <Code size={14} /> Open VS Code
          </WorkshopButton>
        )}
      </div>
    </div>
  )
}

function SessionRecoveryPanel({ session, onRestart }: { session: { id: string; status: string; error?: string }; onRestart: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex h-full items-center justify-center bg-kumo-tint/30 px-6 text-center">
      <div className="max-w-md rounded-2xl border border-kumo-line bg-kumo-base p-6 shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-kumo-fill text-kumo-brand">
          <ArrowClockwise size={20} weight="bold" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-kumo-default">Environment needs restart</h2>
        <p className="mt-2 text-sm leading-6 text-kumo-subtle">
          This coding session is {session.status}. Restart it to create a fresh sandbox and reconnect the terminal.
        </p>
        {session.error && <p className="mt-3 rounded-lg border border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">{session.error}</p>}
        <WorkshopButton
          tone="primary"
          className="mt-5 !h-10 !rounded-lg !px-4"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm('Restart this environment? Uncommitted sandbox changes will be discarded.')) return
            setBusy(true)
            try {
              await onRestart(session.id)
            } finally {
              setBusy(false)
            }
          }}
        >
          <ArrowClockwise size={14} /> {busy ? 'Restarting…' : 'Restart environment'}
        </WorkshopButton>
      </div>
    </div>
  )
}

function CodeSetupScreen() {
  const { github, connect, reconnect, error: providerError } = useSessionsContext()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const expired = github.state === 'expired'

  const handleConnect = async () => {
    setBusy(true)
    setActionError(undefined)
    try {
      if (github.state === 'expired') await reconnect(github.accountId)
      else await connect()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : expired ? 'Could not reconnect GitHub.' : 'Could not connect GitHub.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-full items-center justify-center bg-kumo-tint/30 px-4 py-10 sm:px-8">
      <div className="w-full max-w-3xl overflow-hidden rounded-3xl border border-kumo-line bg-kumo-base shadow-sm">
        <div className="grid gap-0 lg:grid-cols-[1fr_260px]">
          <div className="p-6 sm:p-8">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-kumo-fill text-kumo-brand">
              <TerminalWindow size={22} weight="bold" />
            </div>
            <h1 className="mt-5 text-3xl font-semibold tracking-tight text-kumo-default sm:text-4xl">Set up Code</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-kumo-subtle">
              Code sessions run in isolated sandboxes connected to your GitHub repositories. {expired ? `Reconnect ${github.label} to start or resume coding sessions.` : 'Connect GitHub to choose repositories and start a coding session.'}
            </p>
            <p className="mt-3 max-w-xl text-sm leading-6 text-kumo-subtle">
              Chat remains usable while Code is locked. You can still ask codebase questions in Chat and connect GitHub when you are ready to make changes.
            </p>

            {(providerError || actionError) && (
              <div className="mt-5 rounded-xl border border-kumo-danger/30 bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger">
                {actionError ?? providerError}
              </div>
            )}

            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
              <WorkshopButton tone="primary" className="!h-10 !rounded-lg !px-4" disabled={busy} onClick={handleConnect}>
                <GithubLogo size={16} weight="bold" /> {busy ? (expired ? 'Opening reconnect…' : 'Opening GitHub…') : (expired ? 'Reconnect GitHub' : 'Connect GitHub')}
              </WorkshopButton>
              <span className="text-xs text-kumo-subtle">You will finish authorization in a new tab.</span>
            </div>
          </div>

          <aside className="border-t border-kumo-line bg-kumo-elevated p-6 lg:border-l lg:border-t-0">
            <h2 className="text-sm font-semibold text-kumo-default">After setup</h2>
            <ul className="mt-4 space-y-3 text-sm leading-5 text-kumo-subtle">
              <li className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-kumo-success" /> Pick one or more repositories.</li>
              <li className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-kumo-success" /> Open a coding-agent terminal with shell access.</li>
              <li className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-kumo-success" /> Review tool approvals before changes leave the sandbox.</li>
            </ul>
          </aside>
        </div>
      </div>
    </section>
  )
}

function NewSessionPane() {
  const { enabled: piEnabled, loading: piLoading } = useUiFeatureFlag('pi-coding-session-runtime')
  const {
    activity,
    resolveActivity,
    availablePresets,
    repositories,
    setRepositories,
    repositoryOptions,
    repositorySearch,
    setRepositorySearch,
    repositoryLoading,
    title,
    setTitle,
    runtime,
    setRuntime,
    creating,
    create,
    preparedInput,
    clearPreparedSession,
    error,
  } = useSessionsContext()

  useEffect(() => {
    if (runtime !== 'opencode' && !piLoading && !piEnabled) {
      setRuntime('opencode')
    }
  }, [piEnabled, piLoading, runtime, setRuntime])

  return (
    <section className="flex h-full min-h-0 flex-col bg-kumo-tint/30">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
      <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col">
        {activity.some((entry) => entry.state === 'pending') && (
          <div className="mb-7 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
            <ActivityPanel activity={activity} onResolve={resolveActivity} compact />
          </div>
        )}

        <div className="flex items-center gap-2 text-sm font-semibold text-kumo-default"><Plus size={15} /> New session</div>
        <p className="mt-1 text-xs text-kumo-subtle">Choose repositories from connected GitHub, then open the coding terminal.</p>
        {error && <div className="mt-5 rounded-lg border border-kumo-danger bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger">{error}</div>}

        {preparedInput && (
          <div className="mt-5 rounded-xl border border-kumo-brand/30 bg-kumo-brand/5 p-4" role="status">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-kumo-default">Work Item context</div>
                <p className="mt-1 text-xs leading-5 text-kumo-subtle">{preparedInput}</p>
              </div>
              <WorkshopIconButton aria-label="Remove Work Item context" onClick={clearPreparedSession}>
                <X size={14} />
              </WorkshopIconButton>
            </div>
          </div>
        )}

        {availablePresets.length > 0 && (
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {availablePresets.map((preset) => {
              const selected = preset.repositories.length === repositories.length && preset.repositories.every((repository) => repositories.includes(repository))
              return (
                <button key={preset.id} type="button" aria-pressed={selected} onClick={() => setRepositories(preset.repositories)}
                  className={`rounded-xl border bg-kumo-base p-4 text-left transition-colors ${selected ? 'border-kumo-brand ring-1 ring-kumo-brand/15' : 'border-kumo-line hover:border-kumo-strong'}`}>
                  <div className="text-[13px] font-medium text-kumo-default">{preset.title}</div>
                  <div className="mt-1 text-xs leading-5 text-kumo-subtle">{preset.description}</div>
                </button>
              )
            })}
          </div>
        )}

        {piEnabled && (
          <div className="mt-7">
            <div className="text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">Coding agent</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3" role="group" aria-label="Coding agent runtime">
              {([
                ['opencode', 'OpenCode', 'Established runtime with your account plugins and skills.'],
                ['pi', 'Pi', 'Focused runtime using Team PI Codex and Workshop tools.'],
                ['prime-agent', 'Prime Agent', 'IPython-based runtime using shared Codex and Workshop tools.'],
              ] as const).map(([value, label, description]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={runtime === value}
                  onClick={() => setRuntime(value)}
                  className={`rounded-xl border bg-kumo-base p-3 text-left transition-colors ${runtime === value ? 'border-kumo-brand ring-1 ring-kumo-brand/15' : 'border-kumo-line hover:border-kumo-strong'}`}
                >
                  <span className="block text-[13px] font-medium text-kumo-default">{label}</span>
                  <span className="mt-1 block text-xs leading-5 text-kumo-subtle">{description}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-7 text-[11px] font-medium uppercase tracking-wider text-kumo-subtle">Repositories</div>
        <div className="relative mt-2">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
          <WorkshopInput value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} placeholder="Search connected GitHub repositories…" aria-label="Search repositories" className="w-full pl-9" />
        </div>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-kumo-line bg-kumo-base p-2">
          <div className="grid gap-2 sm:grid-cols-2">
          {repositoryOptions.map((option) => (
            <RepositoryOptionRow
              key={option.repository}
              name={option.repository}
              label={option.title}
              description={option.description}
              checked={repositories.includes(option.repository)}
              onChange={(checked) => setRepositories(checked ? [...repositories, option.repository] : repositories.filter((item) => item !== option.repository))}
            />
          ))}
          </div>
        </div>
        {repositoryLoading && <p className="mt-2 text-xs text-kumo-subtle">Searching repositories…</p>}
        {!repositoryLoading && repositoryOptions.length === 0 && <p className="mt-3 text-sm text-kumo-subtle">No connected repositories match that search.</p>}

      </div>
      </div>
      <div className="shrink-0 border-t border-kumo-line bg-kumo-base/95 px-6 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.03)] backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center">
          <WorkshopInput value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Session title" className="flex-1" />
          <WorkshopButton tone="primary" className="shrink-0 gap-1.5 !rounded-lg !px-3" disabled={creating || !repositories.length || !title.trim()} onClick={create}>
            <TerminalWindow size={14} /> {creating ? 'Starting…' : 'Open session'}
          </WorkshopButton>
        </div>
      </div>
    </section>
  )
}

function RepositoryOptionRow({ name, label, description, checked, onChange }: { name: CodingSessionRepository; label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-xs text-kumo-default">
      <input className="mt-0.5" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{label}</span>
        {description && <span className="mt-0.5 block truncate text-[11px] text-kumo-subtle">{description}</span>}
        {label !== name && <span className="mt-0.5 block truncate text-[11px] text-kumo-inactive">{name}</span>}
      </span>
    </label>
  )
}

function ActivityPanel({ activity, onResolve, compact = false }: { activity: CodingSessionActivity[]; onResolve: (id: string, decision: 'approve' | 'reject') => Promise<void>; compact?: boolean }) {
  const pending = activity.filter((entry) => entry.state === 'pending')
  const [resolvingId, setResolvingId] = useState<string>()
  const resolve = async (id: string, decision: 'approve' | 'reject') => {
    if (resolvingId) return
    setResolvingId(id)
    try {
      await onResolve(id, decision)
    } finally {
      setResolvingId(undefined)
    }
  }
  return (
    <aside className={`${compact ? '' : 'min-h-0 max-h-[40vh] overflow-y-auto border-t border-kumo-line bg-kumo-base lg:max-h-none lg:border-l lg:border-t-0'}`}>
      <div className="flex h-11 items-center gap-2 border-b border-kumo-line px-3 text-xs font-medium text-kumo-default">
        <ShieldCheck size={14} className="text-kumo-brand" /> Tool approvals
        <span className="ml-auto rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] text-kumo-subtle">{pending.length}</span>
      </div>
      <div className="space-y-2 p-3">
        {pending.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-kumo-line bg-kumo-base p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">{entry.resourceTitle}</div>
            <div className="mt-1 text-[13px] font-medium text-kumo-default">{entry.description.title}</div>
            <div className="mt-1 line-clamp-4 text-xs leading-5 text-kumo-subtle">{entry.description.description}</div>
            <div className="mt-3 flex gap-2">
              <WorkshopButton tone="primary" disabled={Boolean(resolvingId)} onClick={() => void resolve(entry.id, 'approve')}><Check size={13} /> Approve</WorkshopButton>
              <WorkshopButton disabled={Boolean(resolvingId)} onClick={() => void resolve(entry.id, 'reject')}><X size={13} /> Reject</WorkshopButton>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-kumo-subtle"><div>{children}</div></div>
}
