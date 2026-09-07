import { useEffect, useRef, useState } from 'react'
import type { AuthenticatedApi, CodingSessionPiCommand, CodingSessionPiConnection } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../WorkshopControls'
import LazySessionTerminal from './LazySessionTerminal'

type Api = Pick<AuthenticatedApi, 'callCodingSessionPi'> & {
  connectCodingSessionPi: (...args: Parameters<AuthenticatedApi['connectCodingSessionPi']>) => Promise<
    Exclude<CodingSessionPiConnection, { mode: 'rpc' }> | (Omit<Connection, 'runtime' | 'capabilities'> & Partial<Pick<Connection, 'runtime' | 'capabilities'>>)
  >
}
type Props = { sessionId: string; runtime?: 'pi' | 'prime-agent'; initialInput?: string; onInitialInputSent?: () => void; onSessionUnavailable?: () => void }
type Connection = Extract<CodingSessionPiConnection, { mode: 'rpc' }>
type RecordValue = Record<string, unknown>
type Dialog = { id: string; method: string; title: string; message: string; options: string[]; value: string }
type Snapshot = { state: RecordValue; entries?: RecordValue[]; historyError?: string; tree: unknown; treeError?: string; dialogs: Dialog[]; events: unknown[]; gap: boolean; dead: boolean; settled: boolean; awaitingStart: boolean; inputAttempted: boolean }
const emptySnapshot = (): Snapshot => ({ state: {}, tree: undefined, dialogs: [], events: [], gap: false, dead: false, settled: false, awaitingStart: false, inputAttempted: false })
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value : ''

function parse(json: string): unknown {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > 2 * 1024 * 1024) throw new Error('Invalid or oversized Pi response.')
  const parsed: unknown = JSON.parse(json)
  const pending = [{ value: parsed, depth: 0 }]
  while (pending.length) {
    const item = pending.pop()!
    if (item.depth > 64) throw new Error('Pi response nesting is too deep.')
    if (item.value !== null && typeof item.value === 'object') {
      for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 })
    }
  }
  return parsed
}

function parseDialogs(value: unknown): Dialog[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid Pi dialogs.')
  return value.map((item) => {
    if (!record(item) || !text(item.id) || !['confirm', 'select', 'input', 'editor'].includes(text(item.method))) throw new Error('Invalid Pi dialog.')
    if (item.options !== undefined && (!Array.isArray(item.options) || !item.options.every((option) => typeof option === 'string'))) throw new Error('Invalid Pi options.')
    return { id: text(item.id), method: text(item.method), title: text(item.title), message: text(item.message), options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [], value: text(item.prefill) }
  })
}

function downloadHtml(value: unknown, runtime: Connection['runtime']) {
  const filename = `${runtime}-session.html`
  if (!record(value) || value.filename !== filename || value.mediaType !== 'text/html' || typeof value.base64 !== 'string' || value.base64.length > 1_398_104) throw new Error('Invalid Pi export.')
  const bytes = Uint8Array.from(atob(value.base64), (character) => character.charCodeAt(0))
  if (bytes.length > 1024 * 1024) throw new Error('Pi export is too large.')
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/html' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  try { link.click() } finally {
    link.remove()
    // Allow the browser to begin the download before revoking its backing URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export default function PiWorkbench(props: Props) {
  const { authenticatedApi } = useAuthenticatedApi()
  return <PiWorkbenchInner key={props.sessionId} {...props} authenticatedApi={authenticatedApi} />
}

/** The keyed body isolates drafts, in-flight responses and dialog attempts by session. */
export function PiWorkbenchInner(props: Props & { authenticatedApi: Api }) {
  return <PiSession key={props.sessionId} {...props} />
}

function PiSession({ authenticatedApi, sessionId, runtime = 'pi', initialInput, onInitialInputSent, onSessionUnavailable }: Props & { authenticatedApi: Api }) {
  const [transport, setTransport] = useState<Connection>()
  const label = transport ? transport.runtime === 'prime' ? 'Prime' : 'Pi' : runtime === 'prime-agent' ? 'Prime' : 'Pi'
  const fullHistory = transport?.capabilities.history === 'persisted-entries'
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
  const [draft, setDraft] = useState(initialInput ?? '')
  const [mode, setMode] = useState<'prompt' | 'steer' | 'follow_up'>('prompt')
  const [terminalReason, setTerminalReason] = useState<string>()
  const [readError, setReadError] = useState<string>()
  const [writeNotice, setWriteNotice] = useState<string>()
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const attemptedDialogs = useRef(new Set<string>())
  const initialDraft = useRef(initialInput)
  const write = useRef<(command: CodingSessionPiCommand, attempted?: () => void) => Promise<void>>(async () => {})

  useEffect(() => {
    if (!initialDraft.current && initialInput) {
      initialDraft.current = initialInput
      setDraft((previous) => previous || initialInput)
    }
  }, [initialInput])

  useEffect(() => {
    let alive = true
    let stopped = false
    let writing = false
    let cursor = 0
    let historyLoading = false
    let connection: Extract<CodingSessionPiConnection, { mode: 'rpc' }> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    setReady(false)
    setBusy(false)
    setReadError(undefined)
    setTerminalReason(undefined)
    setSnapshot((previous) => ({ ...emptySnapshot(), awaitingStart: previous.awaitingStart, inputAttempted: previous.inputAttempted }))

    const call = async (command: CodingSessionPiCommand) => {
      if (!alive || !connection) throw new Error('Pi is not connected.')
      const result = await authenticatedApi.callCodingSessionPi(sessionId, connection.connectionId, command)
      if (!alive) throw new Error('Stale Pi response.')
      return parse(result.json)
    }

    // Large reads are independent of the control loop, including while they hang.
    // Each result commits separately; neither failure hides healthy state/dialogs.
    const refreshHistory = async () => {
      if (historyLoading || !connection) return
      const capabilities = connection.capabilities
      historyLoading = true
      await Promise.all([
        (async () => {
          try {
            const history = await call({ type: capabilities.history === 'persisted-entries' ? 'get_entries' : 'get_messages' })
            const entries = record(history) ? history[capabilities.history === 'persisted-entries' ? 'entries' : 'messages'] : undefined
            if (!Array.isArray(entries) || !entries.every(record)) throw new Error('Invalid history/context response.')
            if (alive && !stopped) setSnapshot((previous) => ({ ...previous, entries, historyError: undefined }))
          } catch (error) {
            if (alive && !stopped) setSnapshot((previous) => ({ ...previous, entries: undefined, historyError: error instanceof Error ? error.message : 'Could not read Pi history.' }))
          }
        })(),
        (async () => {
          if (!capabilities.tree) return
          try {
            const tree = await call({ type: 'get_tree' })
            if (!record(tree) && !Array.isArray(tree)) throw new Error('Invalid Pi tree response.')
            if (alive && !stopped) setSnapshot((previous) => ({ ...previous, tree, treeError: undefined }))
          } catch (error) {
            if (alive && !stopped) setSnapshot((previous) => ({ ...previous, tree: undefined, treeError: error instanceof Error ? error.message : 'Could not read Pi tree.' }))
          }
        })(),
      ])
      historyLoading = false
    }

    const poll = async () => {
      try {
        if (!alive || stopped) return
        if (!connection || connection.expiresAt.valueOf() <= Date.now()) {
          setReady(false)
          let attached = await authenticatedApi.connectCodingSessionPi(sessionId)
          if (!alive) return
          if (attached.mode === 'terminal') {
            stopped = true
            setTerminalReason(attached.reason)
            return
          }
          if (attached.mode !== 'rpc' || attached.version !== 1 || typeof attached.connectionId !== 'string' || !attached.connectionId || !(attached.expiresAt instanceof Date) || !Number.isFinite(attached.expiresAt.valueOf()) || attached.expiresAt.valueOf() <= Date.now()) throw new Error('Invalid Pi connection.')
          // Deployed Pi v1 predates metadata. Never infer Prime support or repair partial metadata.
          if (runtime === 'pi' && !('runtime' in attached) && !('capabilities' in attached)) {
            attached = { ...attached, runtime: 'pi', capabilities: { messages: 'current-context', history: 'persisted-entries', tree: true, settlement: 'agent_settled', messageUpdates: 'delta' } }
          }
          if ((attached.runtime !== 'pi' && attached.runtime !== 'prime') || !attached.capabilities || attached.capabilities.messages !== 'current-context' || !['persisted-entries', 'unavailable'].includes(attached.capabilities.history) || typeof attached.capabilities.tree !== 'boolean' || !['agent_settled', 'unavailable'].includes(attached.capabilities.settlement) || !['delta', 'cumulative'].includes(attached.capabilities.messageUpdates)) throw new Error('Invalid workbench capabilities.')
          connection = { ...attached, runtime: attached.runtime, capabilities: attached.capabilities }
          setTransport(connection)
        }
        const events = await call({ type: 'events', after: cursor })
        if (!record(events) || typeof events.cursor !== 'number' || !Number.isSafeInteger(events.cursor) || events.cursor < cursor || typeof events.truncated !== 'boolean' || typeof events.dead !== 'boolean' || !Array.isArray(events.events)) throw new Error('Invalid Pi event response.')
        if (!events.events.every((event) => record(event) && Number.isSafeInteger(event.cursor) && typeof event.cursor === 'number' && event.cursor > cursor && event.cursor <= Number(events.cursor) && record(event.data))) throw new Error('Invalid Pi event frame.')
        const dialogs = parseDialogs(events.dialogs)
        if (events.dead) {
          stopped = true
          setReady(false)
          setSnapshot((previous) => ({ ...previous, dead: true, dialogs: [], settled: false }))
          return
        }
        cursor = events.cursor
        const recentEvents = events.events
        const gap = events.truncated === true || recentEvents.some((event) => record(event) && record(event.data) && event.data.type === 'bridge_frame_omitted')
        setSnapshot((previous) => {
          let settled = previous.settled
          let awaitingStart = previous.awaitingStart
          if (gap || previous.inputAttempted) {
            settled = false
            awaitingStart = true
          }
          else for (const event of recentEvents.toSorted((a, b) => Number(a.cursor) - Number(b.cursor))) {
            if (!record(event) || !record(event.data)) continue
            if (event.data.type === 'agent_start') {
              settled = false
              awaitingStart = false
            }
            if (connection?.runtime === 'pi' && connection.capabilities.settlement === 'agent_settled' && event.data.type === 'agent_settled' && !awaitingStart) settled = true
          }
          return { ...previous, dialogs, settled, awaitingStart, events: recentEvents.length ? recentEvents : previous.events, gap: previous.gap || gap }
        })
        const state = await call({ type: 'get_state' })
        if (!record(state)) throw new Error('Invalid Pi state response.')
        setSnapshot((previous) => ({ ...previous, state, settled: state.isStreaming === true ? false : previous.settled }))
        setReady(true)
        // Only supported reads; current context is never presented as full history.
        void refreshHistory()
        timer = setTimeout(() => void poll(), 3000)
      } catch (error) {
        if (!alive) return
        stopped = true
        setReady(false)
        setSnapshot((previous) => ({ ...previous, settled: false, awaitingStart: true }))
        setReadError(error instanceof Error ? error.message : 'Could not read Pi.')
      }
    }

    write.current = async (command, attempted) => {
      // Never reconnect or replay a write. Only the polling/read path renews handles.
      if (!alive || stopped || writing || !connection) return
      if (connection.expiresAt.valueOf() <= Date.now()) {
        setWriteNotice('Handle expired. Wait for the read connection to refresh, then explicitly submit again. Nothing was sent.')
        return
      }
      if (command.type === 'extension_ui_response') {
        if (attemptedDialogs.current.has(command.id)) return
        attemptedDialogs.current.add(command.id)
      }
      writing = true
      if (command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up') {
        // Neither start nor settlement events identify the local input they belong
        // to. Even a later poll may contain an entire unread prior turn. Do not
        // infer correlation: keep settlement unknown for this mount, on reconnect too.
        setSnapshot((previous) => ({ ...previous, settled: false, inputAttempted: true }))
      }
      setBusy(true)
      setWriteNotice(undefined)
      try {
        attempted?.()
        const result = await call(command)
        if (!alive) return
        if (command.type === 'export_html') downloadHtml(result, connection.runtime)
        setWriteNotice(command.type === 'export_html' ? 'HTML downloaded; not displayed in Workshop.' : 'Request acknowledged, not proof of turn completion or settlement.')
      } catch (error) {
        if (alive) setWriteNotice(`Outcome unknown; this request was not retried. Inspect history before sending another request. ${error instanceof Error ? error.message : 'Pi request failed.'}`)
      } finally {
        writing = false
        if (alive) setBusy(false)
      }
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
      // API returns plain data, not an RPC stub. In-flight reads cannot be cancelled,
      // but their continuations cannot update state, download or issue more reads.
    }
  }, [authenticatedApi, sessionId, runtime, revision])

  if (terminalReason !== undefined) return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="border-b border-kumo-line p-3 text-xs text-kumo-subtle">{label} terminal mode: {terminalReason} Initial input is not automatically sent; paste it explicitly in the terminal.</p>
      {initialInput && <details className="p-3 text-xs"><summary>Prepared input (not sent)</summary><pre className="whitespace-pre-wrap">{initialInput}</pre></details>}
      <div className="min-h-0 flex-1"><LazySessionTerminal sessionId={sessionId} terminalKind="opencode" runtime={runtime} onSessionUnavailable={onSessionUnavailable} /></div>
    </div>
  )

  const disabled = !ready || busy || snapshot.dead
  return (
    <section aria-label={`${label} workbench`} className="flex h-full min-h-0 flex-col bg-kumo-base text-kumo-default">
      <header className="flex flex-wrap items-center gap-2 border-b border-kumo-line p-3 text-xs">
        <h2 className="font-semibold">{label}</h2>
        <span role="status">{snapshot.dead ? `${label} exited. Explicit environment restart required.` : !ready ? `${label} status unavailable / connecting` : snapshot.state.isStreaming === true ? 'Streaming' : snapshot.state.isStreaming === false ? 'Not streaming (not proof of settlement)' : 'Connected; streaming status unknown'}</span>
        <span role="status" aria-label={`${label} settlement`}>{transport?.runtime === 'prime' || transport?.capabilities.settlement === 'unavailable' ? 'Whole-tree settlement unavailable' : snapshot.settled && snapshot.state.isStreaming !== true ? 'Verified Pi settlement' : 'Pi settlement unknown'}</span>
        <WorkshopButton disabled={disabled} onClick={() => void write.current({ type: 'abort' })}>Cancel turn</WorkshopButton>
        <WorkshopButton disabled={disabled} onClick={() => void write.current({ type: 'export_html' })}>Download HTML</WorkshopButton>
        {readError && <WorkshopButton disabled={busy} onClick={() => setRevision((value) => value + 1)}>Reconnect reads</WorkshopButton>}
      </header>
      {readError && <p role="alert" className="p-3 text-xs text-kumo-danger">Read failed; history may be stale. No terminal fallback or agent restart was attempted. {readError}</p>}
      {writeNotice && <p role="status" className="p-3 text-xs text-kumo-subtle">{writeNotice}</p>}
      {snapshot.inputAttempted && <p className="p-3 text-xs text-kumo-subtle">Settlement remains unknown after local input for this mounted session, including reconnects: runtime events cannot be correlated with that input. Streaming state and bounded raw events remain available.</p>}
      {snapshot.gap && <p role="status" className="p-3 text-xs text-kumo-subtle">Event gap detected. State/history refresh requested; missing live events cannot be reconstructed and do not prove settlement.</p>}
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <h3 className="text-sm font-semibold">{fullHistory ? 'Full persisted Pi history' : 'Current model context (not full history)'}</h3>
        {snapshot.historyError && <p role="alert" className="text-xs text-kumo-danger">{fullHistory ? 'Full history is unavailable, not complete.' : 'Current model context unavailable.'} {snapshot.historyError} Control polling continues; writes are never automatically retried.</p>}
        <p className="text-xs text-kumo-subtle">{fullHistory ? 'All returned entries, including branches and compaction records. Current model context is not full history.' : 'Full persisted history unavailable. Current context may omit earlier messages, branches and compaction records.'}</p>
        {!snapshot.historyError && snapshot.entries === undefined && <p className="text-sm">Loading {fullHistory ? 'full history' : 'current context'}…</p>}
        {snapshot.entries?.length === 0 && <p className="text-sm">{fullHistory ? 'No persisted entries yet.' : 'No messages in current context.'}</p>}
        {snapshot.entries?.map((entry, index) => <HistoryEntry key={`${text(entry.id)}:${index}`} entry={fullHistory ? entry : { message: entry }} />)}
        <details className="text-xs"><summary>{label} state</summary><Json value={snapshot.state} /></details>
        <details className="text-xs"><summary>{label} branch tree</summary>{!transport?.capabilities.tree ? <p>Branch tree unavailable through this transport.</p> : snapshot.treeError ? <p role="alert">Branch tree unavailable, not complete. {snapshot.treeError}</p> : snapshot.tree === undefined ? <p>Loading branch tree…</p> : <Json value={snapshot.tree} />}</details>
        <details className="text-xs"><summary>Latest {label} events ({transport?.capabilities.messageUpdates === 'cumulative' ? 'cumulative updates, not deltas' : 'deltas are not full messages'})</summary><p>Bounded event history, not complete conversation history. Original runtime shapes, including tools and results.</p><Json value={snapshot.events} /></details>
        {snapshot.dialogs.length > 0 && <aside aria-label={`${label} extension dialogs`} className="space-y-3 rounded-lg border border-kumo-line p-3">
          <h3 className="text-sm font-semibold">{label} extension dialogs — not Workshop approvals</h3>
          <p className="text-xs text-kumo-subtle">These expire within 30 seconds. Workshop tool approvals remain in the separate activity panel. Replies here do not approve Workshop actions.</p>
          {snapshot.dialogs.map((dialog) => <PiDialog key={dialog.id} label={label} dialog={dialog} disabled={disabled || attemptedDialogs.current.has(dialog.id)} respond={(command) => void write.current(command)} />)}
        </aside>}
      </div>
      <form className="space-y-2 border-t border-kumo-line p-3" onSubmit={(event) => {
        event.preventDefault()
        if (disabled || !draft.trim() || new TextEncoder().encode(draft).length > 32768) return
        void write.current({ type: mode, message: draft }, () => { setDraft(''); onInitialInputSent?.() })
      }}>
        <label className="block text-xs">{label} input (draft, never sent automatically)
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} className="mt-2 w-full rounded-lg border border-kumo-line bg-kumo-tint p-3 text-sm" rows={3} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs">Input mode <select className="rounded border border-kumo-line bg-kumo-base p-2" value={mode} onChange={(event) => { const value = event.target.value; if (value === 'prompt' || value === 'steer' || value === 'follow_up') setMode(value) }}>
            <option value="prompt">Input</option><option value="steer">Steer</option><option value="follow_up">Follow up</option>
          </select></label>
          <WorkshopButton type="submit" tone="primary" disabled={disabled || !draft.trim() || new TextEncoder().encode(draft).length > 32768}>Send to {label}</WorkshopButton>
          <span className="text-xs text-kumo-subtle">32 KiB maximum. Steer / follow up explicitly queue streaming input.</span>
        </div>
      </form>
    </section>
  )
}

function Json({ value }: { value: unknown }) {
  return <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-kumo-tint p-3 text-xs">{JSON.stringify(value, null, 2)}</pre>
}

function HistoryEntry({ entry }: { entry: RecordValue }) {
  const message = record(entry.message) ? entry.message : undefined
  return <article className="space-y-2 rounded-lg border border-kumo-line p-3 text-sm">
    <h4 className="font-medium">{message ? text(message.role) || 'Message' : text(entry.type) || 'Entry'}{message && text(message.toolName) ? ` · ${text(message.toolName)}` : ''}</h4>
    <p className="text-xs text-kumo-subtle">{text(entry.id)}{text(entry.parentId) ? ` ← ${text(entry.parentId)}` : ''} {text(entry.timestamp)}</p>
    {message && (typeof message.content === 'string' ? <p className="whitespace-pre-wrap break-words">{message.content}</p> : Array.isArray(message.content) ? message.content.map((part, index) => (
      <div key={index}>{record(part) && (part.type === 'text' || part.type === 'thinking') ? <p className="whitespace-pre-wrap break-words">{text(part.text) || text(part.thinking)}</p> : <Json value={part} />}</div>
    )) : null)}
    <details><summary className="text-xs">Complete entry data</summary><Json value={entry} /></details>
  </article>
}

function PiDialog({ dialog, label, disabled, respond }: { dialog: Dialog; label: string; disabled: boolean; respond: (command: CodingSessionPiCommand) => void }) {
  const [value, setValue] = useState(dialog.value)
  const reply = (fields: { value?: string; confirmed?: boolean; cancelled?: boolean }) => respond({ type: 'extension_ui_response', id: dialog.id, ...fields })
  return <fieldset disabled={disabled} className="space-y-2 rounded border border-kumo-line p-3 text-xs">
    <legend>{dialog.title || `${label} ${dialog.method}`}</legend><p className="whitespace-pre-wrap">{dialog.message}</p>
    {dialog.method === 'confirm' ? <><WorkshopButton onClick={() => reply({ confirmed: true })}>Confirm {label} dialog</WorkshopButton> <WorkshopButton onClick={() => reply({ confirmed: false })}>Decline {label} dialog</WorkshopButton></> : <>
      <label className="block">{label} dialog response{dialog.method === 'select' ? <select className="ml-2 bg-kumo-base" value={value} onChange={(event) => setValue(event.target.value)}><option value="" disabled>Choose…</option>{dialog.options.map((option, index) => <option key={index} value={option}>{option}</option>)}</select> : <textarea className="block w-full border border-kumo-line bg-kumo-base p-2" value={value} onChange={(event) => setValue(event.target.value)} />}</label>
      <WorkshopButton disabled={new TextEncoder().encode(value).length > 32768 || (dialog.method === 'select' && !dialog.options.includes(value))} onClick={() => reply({ value })}>Reply to {label}</WorkshopButton>
    </>}
    <WorkshopButton onClick={() => reply({ cancelled: true })}>Dismiss {label} dialog</WorkshopButton>
  </fieldset>
}
