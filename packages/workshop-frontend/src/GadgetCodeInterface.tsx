import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple } from '@phosphor-icons/react'
import { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CodeOp, FileOp } from '@gadgets/workshop-shared/code-op'
import { RpcStub } from 'capnweb'
import FileSidebar from './FileSidebar'
import type { FileChangeStatus, FileSidebarHandle } from './FileSidebar'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import CodeEditor, { type EditSession } from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'
import type { ChatCodeChanges, ChatLiveOpRows } from './ChatInterface'
import { ChatOtClient, type RemoteFileEvent } from './otClient'
import { reportIssue } from './errorReporting'
import { saveTextToFile } from './fileTransfers'
import { isTransientRpcError } from './rpcErrors'

// The code view over git-backed gadget code.
//
// Committed code is git commits; the gadget's head commit (`headCommitId`, from
// WorkpieceSummary.commitId) is fetched with Overseer.getCodeAtCommit() -- immutable, so cached
// by oid -- and is both the read-only view outside any chat and the "original" side of in-chat
// diffs. A chat's uncommitted changes are a revisioned stream of code ops (see ChatCodeBase in
// the API), tracked here by a per-chat ChatOtClient (see otClient.ts): the chat's content is
// its pins' base trees plus the epoch's recorded ops plus live rows, and the user's edits are
// composed locally and submitted through Overseer.submitCodeOp().
//
// A gadget not pinned in the chat tracks mainline head live. The user can start editing it
// without any round trip: the editor shows the head tree, and the first local edit seeds the
// client's content from that same tree and declares the pin on its next submission (the
// first-keystroke pin flow; see ChatOtClient.ensureGadgetEditable). If the server refuses a
// submission -- the chat's generation moved destructively under a revert/draft-discard, or the
// pin declaration lost a race -- the queued local edits are discarded with a notice and the
// view rebuilds from server state, per ChatCodeBase.generation's contract. Merges don't
// discard anything: the client rides the epoch reset (and the server's straggler bridge)
// seamlessly.
//
// There is no standalone (out-of-chat) editing: gadget heads only advance when a chat's
// changes are accepted.

interface GadgetCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  // The selected workpiece: the gadget whose files the editor shows.
  workpieceId: WorkpieceId
  // The selected workpiece's head commit (WorkpieceSummary.commitId). Absent while the gadget
  // is still pending in a chat, which reads as an empty committed file set.
  headCommitId?: string
  height?: string | number
  selectedChatId?: number | null
  // The selected chat's durable code state (see ChatCodeChanges): its ChatCodeBase plus the
  // current epoch's recorded ops, derived together. `undefined` until the chat's metadata and
  // history have loaded; the view stays in its loading state until it arrives.
  chatChanges?: ChatCodeChanges
  // The selected chat's live op row stream (accepted but not yet materialized rows).
  liveRows?: ChatLiveOpRows
  // Gadgets still pending (chat-created) in the selected chat: they have no head commit and
  // their chat content builds up from nothing (see ChatCodeBase).
  pendingGadgetIds?: ReadonlySet<WorkpieceId>
  // The file the agent is currently streaming edits into, if it is in this workpiece.
  streamingActiveFile?: string | null
  isAgentActive: boolean
  isVisible?: boolean
  onHasCodeChange?: (hasCode: boolean) => void
}

const EMPTY_FILES: ReadonlyMap<string, string> = new Map()
const NO_PENDING_GADGETS: ReadonlySet<WorkpieceId> = new Set()

// Commit trees are immutable, so their file maps are cached by oid for the page's lifetime --
// across chat switches, workpiece switches, and component remounts. Failures are evicted so a
// later attempt retries.
const commitFilesCache = new Map<string, Promise<ReadonlyMap<string, string>>>()

function fetchCommitFiles(
  overseer: RpcStub<Overseer>, commitId: string,
): Promise<ReadonlyMap<string, string>> {
  let cached = commitFilesCache.get(commitId)
  if (!cached) {
    cached = overseer.getCodeAtCommit(commitId).then(
      ({ files }) => new Map(files) as ReadonlyMap<string, string>)
    cached.catch(() => commitFilesCache.delete(commitId))
    commitFilesCache.set(commitId, cached)
  }
  return cached
}

function areArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

export default function GadgetCodeInterface({
  overseer, workpieceId, headCommitId, height = '100%', selectedChatId = null, chatChanges,
  liveRows, pendingGadgetIds, streamingActiveFile, isAgentActive, isVisible = true,
  onHasCodeChange,
}: GadgetCodeInterfaceProps) {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const branchMode = selectedChatId !== null

  // Keep refs to the current props so long-lived callbacks (the OT client delegate, editor
  // sessions) always read the latest values.
  const currentOverseerRef = useRef(overseer)
  currentOverseerRef.current = overseer
  const workpieceIdRef = useRef(workpieceId)
  workpieceIdRef.current = workpieceId
  const headCommitIdRef = useRef(headCommitId)
  headCommitIdRef.current = headCommitId

  // The committed head's file map, fetched by oid (see fetchCommitFiles). `commitId` records
  // which commit the entry is for, so a switch to a different gadget or a head advance reads as
  // "loading" rather than briefly showing the previous commit's files.
  const [headFilesState, setHeadFilesState] =
    useState<{ commitId: string, files: ReadonlyMap<string, string> } | null>(null)
  // A failed head fetch renders an error state with a retry (fetchCommitFiles evicts failures
  // from its cache, so bumping the token genuinely refetches); without this the pane would sit
  // in its loading state forever, since nothing else re-triggers the fetch.
  const [headLoadFailed, setHeadLoadFailed] = useState(false)
  const [headRetryToken, setHeadRetryToken] = useState(0)
  useEffect(() => {
    setHeadLoadFailed(false)
    if (headCommitId === undefined) return
    let cancelled = false
    fetchCommitFiles(overseer, headCommitId)
      .then(files => {
        if (!cancelled) setHeadFilesState({ commitId: headCommitId, files })
      })
      .catch(err => {
        if (cancelled) return
        console.error('Failed to load committed code:', err)
        reportIssue('code-view.head-commit', err, { handled: true })
        setHeadLoadFailed(true)
      })
    return () => { cancelled = true }
  }, [headCommitId, overseer, headRetryToken])

  // The committed files currently applicable: an absent head reads as an empty committed file
  // set (the gadget is still pending in a chat); null while the head's tree is still loading.
  const headFiles: ReadonlyMap<string, string> | null = headCommitId === undefined
    ? EMPTY_FILES
    : headFilesState !== null && headFilesState.commitId === headCommitId
      ? headFilesState.files
      : null
  const headFilesRef = useRef(headFiles)
  headFilesRef.current = headFiles

  // ---- OT client (one per selected chat) --------------------------------------------------

  // Bumped (rAF-coalesced) whenever the client's content changes, driving re-derivation of the
  // sidebar's file list and statuses.
  const [contentVersion, setContentVersion] = useState(0)
  // Bumped when the client's content changed *wholesale* (a rebuild or epoch reset), forcing
  // open editors to rebuild their document from the client instead of patching it.
  const [resetToken, setResetToken] = useState(0)
  // The client hit an unrecoverable error (e.g. a pin base fetch failed).
  const [clientError, setClientError] = useState(false)
  // Unacknowledged local edits are stuck behind a failing submission ("connection issue").
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // Per-open-file remote-delta listeners, keyed by `${gadgetId}\u0000${path}` (see EditSession).
  const fileListenersRef = useRef(new Map<string, Set<(op: FileOp) => void>>())

  const [clientState, setClientState] =
    useState<{ chatId: number, client: ChatOtClient } | null>(null)
  const contentBumpPendingRef = useRef(false)
  useEffect(() => {
    if (selectedChatId === null) {
      setClientState(null)
      return
    }
    const chatId = selectedChatId
    const client = new ChatOtClient({
      fetchCommitFiles: commitId => fetchCommitFiles(currentOverseerRef.current, commitId),
      submitCodeOp: submission =>
        currentOverseerRef.current.submitCodeOp(chatId, submission),
      isTransientError: isTransientRpcError,
      onRemoteChange: (events: RemoteFileEvent[]) => {
        if (events.length === 0) {
          // Coarse change (rebuild / epoch reset): open editors reload from the client.
          setResetToken(token => token + 1)
        } else {
          for (const event of events) {
            fileListenersRef.current.get(`${event.gadgetId}\u0000${event.path}`)
              ?.forEach(listener => listener(event.op))
          }
        }
        if (!contentBumpPendingRef.current) {
          contentBumpPendingRef.current = true
          requestAnimationFrame(() => {
            contentBumpPendingRef.current = false
            setContentVersion(version => version + 1)
          })
        }
      },
      onLocalEditsDiscarded: () => {
        toastsRef.current.add({
          title: "Your latest code edits were discarded — this conversation's changes were " +
            'reverted or changed by someone else at the same time.',
          variant: 'warning',
        })
      },
      onDirtyState: setHasUnsavedChanges,
      onFatalError: err => {
        console.error('Chat code state failed to load:', err)
        reportIssue('code-view.ot-client', err, { handled: true })
        setClientError(true)
      },
    })
    setClientState({ chatId, client })
    setClientError(false)
    setHasUnsavedChanges(false)
    return () => {
      client.dispose()
      setClientState(current => (current?.client === client ? null : current))
    }
  }, [selectedChatId])

  const client = clientState !== null && clientState.chatId === selectedChatId
    ? clientState.client
    : null

  // Feed live rows to the client by subscribing to the chat's row stream: retained rows are
  // replayed at subscribe time (the client dedupes by (generation, revision)) and new rows
  // arrive synchronously from the RPC callback -- before the materialization watermark that
  // absorbs them can prune the buffer, and before the render cycle delivers the durable
  // snapshot they precede (see ChatLiveOpRows). Declared *before* the durable-state effect so
  // the replay keeps that same row-then-snapshot order into the client's queue on mount.
  useEffect(() => {
    // The chatId gate matters on chat switches: the rows prop lags the selection by a render,
    // and another chat's rows must never enter this chat's client.
    if (client === null || liveRows === undefined || liveRows.chatId !== selectedChatId) return
    return liveRows.subscribe(row => client.pushRow(row))
  }, [client, liveRows, selectedChatId])

  useEffect(() => {
    // Same chatId gate as the rows feed: never fold another chat's snapshot into this client.
    if (client !== null && chatChanges !== undefined && chatChanges.chatId === selectedChatId) {
      client.setDurableState({
        codeBase: chatChanges.codeBase,
        epochOp: chatChanges.epochOp,
        rowsThrough: chatChanges.rowsThrough,
      })
    }
  }, [client, chatChanges, selectedChatId])

  useEffect(() => {
    client?.setPendingCreations(pendingGadgetIds ?? NO_PENDING_GADGETS)
  }, [client, pendingGadgetIds])

  // The client is ready once its first durable snapshot has been folded.
  const clientReady = branchMode && client !== null && chatChanges !== undefined &&
    chatChanges.chatId === selectedChatId && client.isReady()
  // Re-evaluated per content change; contentVersion is the (deliberate) extra dependency.
  void contentVersion

  // The chat's uncommitted files for the selected gadget, or undefined when the gadget is not
  // part of the chat's content (it then tracks mainline head live).
  const chatFiles = clientReady ? client!.getFiles(workpieceId) : undefined

  // What the view displays for the selected gadget: chat content when the chat owns it, the
  // committed head otherwise. Null while loading.
  const displayFiles: ReadonlyMap<string, string> | null =
    branchMode ? (chatFiles ?? headFiles) : headFiles

  // An unpinned gadget's editor shows head content; when the head advances (another chat's
  // accept), open editors must reload from the new tree.
  const prevUnpinnedHeadRef = useRef(headCommitId)
  useEffect(() => {
    if (!clientReady) return
    if (!client!.hasGadget(workpieceId) && prevUnpinnedHeadRef.current !== headCommitId) {
      setResetToken(token => token + 1)
    }
    prevUnpinnedHeadRef.current = headCommitId
  }, [client, clientReady, headCommitId, workpieceId])

  // ---- file selection ----------------------------------------------------------------------

  const [activeFile, setActiveFile] = useState<string | null>(null)
  const fileSidebarRef = useRef<FileSidebarHandle | null>(null)
  const hasUserSwitchedFilesThisTurnRef = useRef(false)
  const wasAgentActiveRef = useRef(isAgentActive)
  const lastStreamingActiveFileRef = useRef<string | null>(streamingActiveFile ?? null)
  const selectionChatIdRef = useRef(selectedChatId)
  useLayoutEffect(() => {
    if (selectionChatIdRef.current !== selectedChatId ||
        (!wasAgentActiveRef.current && isAgentActive)) {
      hasUserSwitchedFilesThisTurnRef.current = false
      lastStreamingActiveFileRef.current = null
    }
    selectionChatIdRef.current = selectedChatId
    wasAgentActiveRef.current = isAgentActive
  }, [isAgentActive, selectedChatId])

  // When the selected workpiece changes, the previous gadget's file selection and per-turn
  // state are meaningless; reset so the auto-select effect picks a file from the new gadget.
  const prevWorkpieceRef = useRef(workpieceId)
  useEffect(() => {
    if (prevWorkpieceRef.current === workpieceId) return
    prevWorkpieceRef.current = workpieceId
    setActiveFile(null)
    hasUserSwitchedFilesThisTurnRef.current = false
  }, [workpieceId])

  // Sorted list of files the view shows: the union of committed and chat files, so deletions
  // remain visible (marked "deleted") and additions appear.
  const displayedFiles = useMemo(() => {
    const names = new Set<string>(headFiles !== null ? headFiles.keys() : [])
    if (branchMode && chatFiles !== undefined) {
      for (const name of chatFiles.keys()) names.add(name)
    }
    return [...names].toSorted()
  }, [headFiles, chatFiles, branchMode])
  const displayedFilesRef = useRef(displayedFiles)
  const prevDisplayedFilesRef = useRef<string[]>([])
  // Stabilize identity so downstream memos don't churn per contentVersion bump.
  const stableDisplayedFiles = areArraysEqual(prevDisplayedFilesRef.current, displayedFiles)
    ? prevDisplayedFilesRef.current
    : displayedFiles
  prevDisplayedFilesRef.current = stableDisplayedFiles
  displayedFilesRef.current = stableDisplayedFiles

  // Auto-select the first file when files appear and nothing is selected.
  useEffect(() => {
    if (activeFile === null && stableDisplayedFiles.length > 0) {
      setActiveFile(stableDisplayedFiles[0])
    }
  }, [activeFile, stableDisplayedFiles])

  // Avoid reporting an empty state before the committed files have loaded.
  const onHasCodeChangeRef = useRef(onHasCodeChange)
  onHasCodeChangeRef.current = onHasCodeChange
  useEffect(() => {
    if (headFiles !== null) {
      onHasCodeChangeRef.current?.(headFiles.size > 0)
    }
  }, [headFiles])

  // Select the file currently being edited by the agent, unless the user has manually switched
  // files during this turn.
  useEffect(() => {
    if (streamingActiveFile) lastStreamingActiveFileRef.current = streamingActiveFile
    const target = streamingActiveFile ?? lastStreamingActiveFileRef.current
    if (hasUserSwitchedFilesThisTurnRef.current || !target) {
      return
    }
    if (displayedFilesRef.current.includes(target)) {
      setActiveFile(target)
    }
  }, [isAgentActive, selectedChatId, streamingActiveFile, stableDisplayedFiles])

  // ---- statuses ----------------------------------------------------------------------------

  const isDiffMode = branchMode
  const { changedFiles, fileChangeStatuses } = useMemo(() => {
    const changed = new Set<string>()
    if (!isDiffMode || headFiles === null || displayFiles === null) {
      return { changedFiles: changed, fileChangeStatuses: undefined }
    }
    const statuses = new Map<string, FileChangeStatus>()
    for (const name of stableDisplayedFiles) {
      const original = headFiles.get(name)
      const preview = displayFiles.get(name)
      if (original === undefined && preview !== undefined) {
        statuses.set(name, 'added')
        changed.add(name)
      } else if (original !== undefined && preview === undefined) {
        statuses.set(name, 'deleted')
        changed.add(name)
      } else if (original !== preview) {
        statuses.set(name, 'modified')
        changed.add(name)
      } else {
        statuses.set(name, 'unchanged')
      }
    }
    return { changedFiles: changed, fileChangeStatuses: statuses }
  }, [isDiffMode, headFiles, displayFiles, stableDisplayedFiles])

  // ---- editing -----------------------------------------------------------------------------

  // Editing is locked outside a chat (committed code only changes through a chat's accept),
  // while an agent turn is active (its edits stream into the same file), and until the chat's
  // content has loaded.
  const isEditingLocked = !branchMode || isAgentActive || !clientReady

  // Make the selected gadget part of the chat's content if it isn't yet: the first local edit
  // to an unpinned gadget pins it at the head tree the user is looking at.
  const ensureEditable = useCallback(() => {
    const activeClient = client
    if (activeClient === null) return false
    if (!activeClient.hasGadget(workpieceIdRef.current)) {
      activeClient.ensureGadgetEditable(
        workpieceIdRef.current, headCommitIdRef.current, headFilesRef.current ?? EMPTY_FILES)
    }
    return true
  }, [client])

  const applyLocalFileOps = useCallback((ops: [string, FileOp][]) => {
    if (!ensureEditable() || client === null) return false
    const op: CodeOp = { [workpieceIdRef.current]: ops }
    client.applyLocalOp(op)
    return true
  }, [client, ensureEditable])

  // The active file's editing session (see EditSession in CodeEditor). Identity is stable
  // across content changes -- the editor patches its document from remote deltas -- and rolls
  // over on chat/gadget/file switches and wholesale resets.
  const activeSession: EditSession | undefined = useMemo(() => {
    if (!branchMode || client === null || activeFile === null) return undefined
    const gadgetId = workpieceId
    const path = activeFile
    const listenerKey = `${gadgetId}\u0000${path}`
    return {
      key: `${selectedChatId}:${resetToken}:${gadgetId}:${path}`,
      getText: () => {
        // Fall back to the committed head only when the chat's content doesn't cover the
        // gadget at all (it then tracks head live). A gadget the chat owns but whose file is
        // absent is a *deleted* file: surface it as empty (the diff view's original side shows
        // the removed content), not as the head text masquerading as unchanged.
        const files = client.getFiles(gadgetId)
        return files !== undefined ? files.get(path) : headFilesRef.current?.get(path)
      },
      applyLocal: (op: FileOp, docText: string) => {
        try {
          if (!client.hasGadget(gadgetId)) {
            client.ensureGadgetEditable(
              gadgetId, headCommitIdRef.current, headFilesRef.current ?? EMPTY_FILES)
          }
          // Editing a file the chat's content no longer has (e.g. it was deleted in the chat
          // while its editor stayed open) re-creates it with the editor's text.
          const fileOp: FileOp = client.getFiles(gadgetId)?.has(path)
            ? op
            : { set: docText }
          client.applyLocalOp({ [gadgetId]: [[path, fileOp]] })
        } catch (err) {
          // The editor's document drifted from the client's content (a bug); reload it from
          // the client rather than corrupting the chat.
          console.error('Local edit did not fit chat content; reloading editor:', err)
          reportIssue('code-view.local-edit', err, { handled: true })
          setResetToken(token => token + 1)
        }
      },
      subscribeRemote: (listener: (op: FileOp) => void) => {
        let listeners = fileListenersRef.current.get(listenerKey)
        if (!listeners) {
          listeners = new Set()
          fileListenersRef.current.set(listenerKey, listeners)
        }
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) fileListenersRef.current.delete(listenerKey)
        }
      },
    }
  }, [branchMode, client, activeFile, workpieceId, selectedChatId, resetToken])

  // ---- file management (create / delete / rename / download) --------------------------------

  const handleFileSelect = (filename: string) => {
    if (activeFile !== filename) {
      hasUserSwitchedFilesThisTurnRef.current = true
    }
    setActiveFile(filename)
  }

  const handleFileCreate = (filename: string) => {
    if (isEditingLocked || displayFiles === null) return
    if (displayFiles.has(filename)) {
      toasts.add({ title: `File already exists: ${filename}`, variant: 'error' })
      return
    }
    if (applyLocalFileOps([[filename, { set: '' }]])) {
      setActiveFile(filename)
      toasts.add({ title: `Created file: ${filename}`, variant: 'success' })
    }
  }

  const handleFileDelete = (filename: string) => {
    if (isEditingLocked || displayFiles === null) return
    if (!displayFiles.has(filename)) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }
    if (applyLocalFileOps([[filename, { remove: true }]])) {
      if (activeFile === filename) {
        const remaining = displayedFilesRef.current.filter(name => name !== filename)
        setActiveFile(remaining.length > 0 ? remaining[0] : null)
      }
      toasts.add({ title: `Deleted file: ${filename}`, variant: 'success' })
    }
  }

  const handleFileRename = (oldName: string, newName: string) => {
    if (isEditingLocked || displayFiles === null) return
    const text = displayFiles.get(oldName)
    if (text === undefined) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }
    if (displayFiles.has(newName)) {
      toasts.add({ title: `File already exists: ${newName}`, variant: 'error' })
      return
    }
    if (applyLocalFileOps([[oldName, { remove: true }], [newName, { set: text }]])) {
      if (activeFile === oldName) {
        setActiveFile(newName)
      }
      toasts.add({ title: `Renamed file: ${oldName} \u2192 ${newName}`, variant: 'success' })
    }
  }

  const handleFileDownload = useCallback((filename: string) => {
    const text = displayFiles?.get(filename)
    if (text === undefined) {
      toasts.add({ title: `Could not download ${filename}`, variant: 'error' })
      return
    }
    saveTextToFile(filename, text)
  }, [displayFiles, toasts])

  // ---- render ------------------------------------------------------------------------------

  // Outside a chat, ready means the committed files have loaded; within one, the chat's
  // content must be in too.
  const isReady = headFiles !== null && (!branchMode || clientReady)
  const loading = !isReady && !clientError && !headLoadFailed

  // Repair the file selection when the active file stops existing anywhere it could live --
  // e.g. a head advance (another chat's accept) deleted it, or the user left the chat whose
  // edits created it. Clearing the selection lets the auto-select effect pick a remaining
  // file. Only while ready: mid-load everything is transiently empty, and clobbering the
  // selection then would lose it across every ordinary reload.
  useEffect(() => {
    if (!isReady || activeFile === null) return
    if (!displayedFilesRef.current.includes(activeFile)) {
      setActiveFile(null)
    }
  }, [activeFile, isReady, stableDisplayedFiles])

  if (headLoadFailed && headFiles === null) {
    return (
      <div
        className="flex flex-col justify-center items-center gap-3 px-6 text-center"
        style={{ height }}
      >
        <p className="m-0 text-sm text-kumo-danger">
          Failed to load this gadget&apos;s code.
        </p>
        <WorkshopButton
          tone="secondary"
          className="!h-8"
          onClick={() => setHeadRetryToken(token => token + 1)}
        >
          Try again
        </WorkshopButton>
      </div>
    )
  }

  if (clientError) {
    return (
      <div
        className="flex justify-center items-center px-6 text-center text-kumo-danger text-sm"
        style={{ height }}
      >
        Failed to load this conversation&apos;s code changes. Try reloading the page.
      </div>
    )
  }

  if (loading) {
    return (
      <div
        className="flex justify-center items-center text-kumo-subtle"
        style={{ height }}
      >
        Loading code files...
      </div>
    )
  }

  if (!isVisible) {
    return <div style={{ height, width: '100%' }} />
  }

  const activeFileText = activeFile !== null
    ? displayFiles?.get(activeFile) ?? null
    : null
  // The committed side of the diff; null = the file doesn't exist at head (an added file).
  const activeFileOriginal = activeFile !== null
    ? headFiles?.get(activeFile) ?? null
    : null
  const activeFileDownloadable =
    activeFile !== null && displayFiles?.get(activeFile) !== undefined
  const activeFileModeLabel = !branchMode
    ? 'Viewing'
    : isEditingLocked
      ? 'Reviewing changes in'
      : 'Editing changes in'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height, width: '100%' }}>
      {hasUnsavedChanges && (
        <div className="bg-kumo-tint border-b border-kumo-line px-4 py-2 flex items-center gap-2 text-sm text-kumo-warning">
          <span className="text-base">&#9888;&#65039;</span>
          <span>Connection issue - changes will be saved when connection is restored</span>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <FileSidebar
          ref={fileSidebarRef}
          files={stableDisplayedFiles}
          activeFile={activeFile}
          streamingActiveFile={streamingActiveFile}
          dirtyFiles={new Set()}
          changedFiles={changedFiles}
          fileChangeStatuses={fileChangeStatuses}
          isDiffMode={isDiffMode}
          editLocked={isEditingLocked}
          onFileSelect={handleFileSelect}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
          onFileRename={handleFileRename}
          onFileDownload={handleFileDownload}
        />
        <div className="flex flex-col bg-kumo-base" style={{ flex: 1, minWidth: 0 }}>
          {activeFile && (
            <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-3">
              <div className="min-w-0 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                {activeFileModeLabel} <span className="font-mono font-medium text-kumo-default">{activeFile}</span>
              </div>
              <WorkshopIconButton
                aria-label={`Download ${activeFile}`}
                title="Download file"
                onClick={() => handleFileDownload(activeFile)}
                disabled={!activeFileDownloadable}
                className="!h-6 !w-6"
              >
                <DownloadSimple size={14} weight="bold" />
              </WorkshopIconButton>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {stableDisplayedFiles.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center bg-kumo-base px-6 text-center">
                <div className="max-w-[360px]">
                  <p className="m-0 text-[15px] leading-[22px] font-semibold tracking-[-0.3px] text-kumo-default">
                    No files yet
                  </p>
                  <p className="mt-1.5 mb-0 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
                    {branchMode
                      ? 'Keep building with the agent in chat and files will appear here as it works, or create one yourself.'
                      : 'Open a conversation and build with the agent, and its accepted files will appear here.'}
                  </p>
                  {branchMode && (
                    <div className="mt-4 flex justify-center">
                      <WorkshopButton
                        onClick={() => fileSidebarRef.current?.openCreateModal()}
                        disabled={isEditingLocked}
                        tone="primary"
                        className="!h-8"
                      >
                        New file
                      </WorkshopButton>
                    </div>
                  )}
                </div>
              </div>
            ) : isDiffMode ? (
              <CodeDiffEditor
                filename={activeFile}
                original={activeFileOriginal}
                text={activeFileText}
                session={activeSession}
                readOnly={isEditingLocked}
                height="100%"
              />
            ) : (
              // Outside any chat the committed head is shown read-only: committed code only
              // changes through a chat's accepted changes.
              <CodeEditor
                filename={activeFile}
                text={activeFileText}
                readOnly
                height="100%"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
