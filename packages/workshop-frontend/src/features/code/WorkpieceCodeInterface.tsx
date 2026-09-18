import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple, GitBranch, List } from '@phosphor-icons/react'
import type {
  FileAtCommit, Overseer, WorkpieceId, WorkpieceSummary,
} from '@gadgets/workshop-shared/api'
import {
  MAX_FILE_TEXT_LENGTH, type CodeChange, type FileChange, type TextChange,
} from '@gadgets/workshop-shared/code-change'
import { RpcStub } from 'capnweb'
import FileBrowser, { isOpenableKind, type ExpandedDirs, type FileBrowserHandle } from './FileBrowser'
import { WorkshopButton, WorkshopIconButton } from '../../components/WorkshopControls'
import CodeEditor, { type EditSession } from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'
import type {
  ChatCodeChanges, ChatLiveChangeRows, ChatLiveEditPreviews, EditPreviewEvent,
} from '../../ChatInterface'
import { ChatOtClient, type RemoteFileEvent } from './otClient'
import { commitFileStore, type CommitFileReader } from './commitFileStore'
import { useCommitTree, useFilesAtCommit } from './useCommitContent'
import {
  EMPTY_BROWSER_TREE, browserTreePaths, buildBrowserTree, deriveChanges, type ChangedFile,
  type FileChangeStatus,
} from './workpieceTree'
import { reportIssue } from '../../errorReporting'
import { saveTextToFile } from '../../fileTransfers'
import { isTransientRpcError } from '../../rpcErrors'

// The code view over a workpiece's git-backed files -- a gadget's code or a worktree's checkout.
// The two differ here in exactly two places: which summary field names the *accepted commit*
// (a gadget's `commitId`, a worktree's `pinBase`; see acceptedCommitOf), and what the workpiece
// is called in copy. Everything else is one code path.
//
// Committed content is git commits, read lazily through the per-commit file store (see
// commitFileStore.ts): Overseer.listTree() for a commit's tree, Overseer.readFilesAtCommit()
// for content by path, both immutable and cached by oid. Two commits matter here and are kept
// apart:
//  - The *content base* is what the chat's content is built on: the chat pin's base commit when
//    the workpiece is pinned in the selected chat, else the accepted commit. The tree, an
//    untouched file's text, and the seed for a local edit all come from it -- what the agent
//    reads.
//  - The *review base* is what "changed" means: the diff's original side and the statuses are
//    computed against it. It is the pin's `mergedCommit` -- the mainline commit whose content
//    has been merged into the chat -- else the accepted commit. That is exactly what accepting
//    would apply: a chat not updated from mainline diffs against its pin, so mainline's later
//    commits never show up (accepting doesn't revert them, it is blocked until they are merged
//    in); once updateChatFromMainline has imported them as rows, `mergedCommit` has advanced
//    past the pin and those rows compare equal and vanish, rather than being listed as this
//    chat's own changes. Accept requires `mergedCommit === head`, so where it is enabled the
//    two agree.
// The two coincide except for a gadget chat that has been updated from mainline. For a worktree
// they always coincide (it has no mainline), and in particular the worktree's own `headCommit`
// -- the agent's last explicit commit -- plays no role: an agent that edits and immediately
// commits still shows its work against the last *accepted* commit.
//
// A chat's uncommitted changes are a revisioned stream of code changes (see ChatCodeBase in the
// API), tracked here by a per-chat ChatOtClient (see otClient.ts). Its content is sparse: for
// a pinned workpiece it holds only the paths the epoch touched (plus tombstones for removals),
// so "touched" is exactly "in the client's files or removed paths", and the view reads
// everything else from the content base. The user's edits are composed locally and submitted
// through Overseer.submitCodeChange().
//
// A workpiece not pinned in the chat tracks its accepted commit live. The user can start editing
// it without any extra round trip: the editor shows the base text the store already loaded, and
// the first local edit seeds the client with just that path's base text and declares the pin
// on its next submission (the first-keystroke pin flow; see ChatOtClient.ensureFileEditable).
// If the server refuses a submission -- the chat's generation moved destructively under a
// revert/draft-discard, or the pin declaration lost a race -- the queued local edits are
// discarded with a notice and the view rebuilds from server state, per
// ChatCodeBase.generation's contract. Merges don't discard anything: the client rides the
// epoch reset (and the server's straggler bridge) seamlessly.
//
// There is no standalone (out-of-chat) editing: accepted commits only advance when a chat's
// changes are accepted.

interface WorkpieceCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  // The selected workpiece, whose files the editor shows.
  summary: WorkpieceSummary
  height?: string | number
  selectedChatId?: number | null
  // The selected chat's durable code state (see ChatCodeChanges): its ChatCodeBase plus the
  // current epoch's recorded changes, derived together. `undefined` until the chat's metadata and
  // history have loaded; the view stays in its loading state until it arrives.
  chatChanges?: ChatCodeChanges
  // The selected chat's live change row stream (accepted but not yet materialized rows).
  liveRows?: ChatLiveChangeRows
  // The selected chat's live edit-preview stream: the writeFile/editFile content the agent is
  // still generating, overlaid on the display as it streams (see ChatLiveEditPreviews).
  liveEditPreviews?: ChatLiveEditPreviews
  // Gadgets still pending (chat-created) in the selected chat: they have no head commit and
  // their chat content builds up from nothing (see ChatCodeBase).
  pendingGadgetIds?: ReadonlySet<WorkpieceId>
  // The file the agent is currently streaming edits into, if it is in this workpiece.
  streamingActiveFile?: string | null
  isAgentActive: boolean
  isVisible?: boolean
  onHasCodeChange?: (hasCode: boolean) => void
}

const NO_PENDING_GADGETS: ReadonlySet<WorkpieceId> = new Set()
const NO_PATHS: readonly string[] = []
const NO_REMOVED: ReadonlySet<string> = new Set()
const NO_CHANGES: readonly ChangedFile[] = []

// The workpiece's accepted commit -- the content and review base while it is unpinned in the
// selected chat. The one place the two workpiece types are told apart for content: a gadget's
// mainline head, a worktree's last-accepted commit. Absent while a gadget is still pending in a
// chat, which reads as an empty committed file set.
function acceptedCommitOf(summary: WorkpieceSummary): string | undefined {
  return summary.type === 'worktree' ? summary.pinBase : summary.commitId
}

function areArraysEqual(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

// ---- streaming edit previews (see ChatLiveEditPreviews) ---------------------------------------
//
// The agent's writeFile/editFile calls, overlaid on the displayed content as their text streams
// in. Display-only: none of it ever enters the OT client. Because tool calls execute only after
// the whole model response has streamed, previews outlive their streaming: each finished
// preview's final text stays displayed as a *pending* entry until the call's durable change row
// arrives (rows land in call order; see the interception in the client's onRemoteChange) or an
// editPreviewClear withdraws it. Same-file previews stack: a later call's span is located in the
// text of the finished preview beneath it, mirroring how the agent computes each edit against
// content that includes its earlier edits. A preview targets a file whose text may not be
// loaded yet (content is read lazily): attachment then waits for the read, deltas accumulating
// meanwhile, and a preview that finishes streaming before the read lands is *deferred* and
// joins its file's pending chain once it does -- never dropped.

// The call whose content is currently streaming, attached to the display or not (attachment
// waits for the target's content to load; `text` is cumulative, so attaching can happen late).
// Also the shape of a deferred preview (see deferredPreviewsRef).
type StreamingPreview = {
  toolCallId: string
  gadgetId: WorkpieceId
  path: string
  // editFile's replaced text; absent for writeFile (the streamed text replaces the whole file).
  textToReplace?: string
  // The streamed text received so far.
  text: string
}

// Where a preview's streamed text goes in `fileText`: the whole file for writeFile, editFile's
// uniquely matched span otherwise. Null when there is no unique match -- the tool call itself
// will fail the same test (or our copy has diverged, and anchoring the preview would show it in
// the wrong place), so no preview is shown.
function locatePreviewSpan(
  preview: StreamingPreview, fileText: string | undefined,
): { from: number; to: number } | null {
  if (preview.textToReplace === undefined) return { from: 0, to: fileText?.length ?? 0 }
  const matchPos = fileText !== undefined ? fileText.indexOf(preview.textToReplace) : -1
  if (matchPos < 0 || fileText!.indexOf(preview.textToReplace, matchPos + 1) >= 0) return null
  return { from: matchPos, to: matchPos + preview.textToReplace.length }
}

// The streaming preview's rendering: the streamed `text` replaces [from, to) of `base` -- the
// file's displayed text when the preview attached ('' for a file being created); the whole file
// for writeFile, editFile's matched span otherwise. `text` mirrors the StreamingPreview's (all
// of it is dispatched into open editors as it arrives).
type PreviewOverlay = {
  toolCallId: string
  gadgetId: WorkpieceId
  path: string
  base: string
  from: number
  to: number
  text: string
}

// A finished preview awaiting its durable row: the full file text that row should produce.
type PendingPreview = {
  toolCallId: string
  text: string
}

// Preview maps are keyed like the per-file listener map (see fileListenersRef).
function fileKey(gadgetId: WorkpieceId, path: string): string {
  return `${gadgetId}\u0000${path}`
}

function splitFileKey(key: string): [WorkpieceId, string] {
  const sep = key.indexOf('\u0000')
  return [Number(key.slice(0, sep)), key.slice(sep + 1)]
}

// The previewed file's full display text: the base with the streamed text in place of the span.
function previewedText(overlay: PreviewOverlay): string {
  return overlay.base.slice(0, overlay.from) + overlay.text + overlay.base.slice(overlay.to)
}

// Build the compact-JSON text change replacing [from, to) of a document of length `docLen` with
// `insert`. Only ever consumed by the editors' remote-change converters (see CodeEditor's
// specFromTextChange) -- these synthetic changes never reach the OT client or the server.
function replaceSpanTextChange(
  docLen: number, from: number, to: number, insert: string,
): TextChange {
  const change: TextChange = []
  if (from > 0) change.push(from)
  change.push(insert === '' ? [to - from] : [to - from, ...insert.split('\n')])
  if (docLen > to) change.push(docLen - to)
  return change
}

export default function WorkpieceCodeInterface({
  overseer, summary, height = '100%', selectedChatId = null, chatChanges,
  liveRows, liveEditPreviews, pendingGadgetIds, streamingActiveFile, isAgentActive,
  isVisible = true, onHasCodeChange,
}: WorkpieceCodeInterfaceProps) {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const branchMode = selectedChatId !== null
  const workpieceId = summary.id
  const acceptedCommit = acceptedCommitOf(summary)
  const workpieceNoun = summary.type === 'worktree' ? 'worktree' : 'gadget'

  // Keep refs to the current props so long-lived callbacks (the OT client delegate, editor
  // sessions) always read the latest values.
  const currentOverseerRef = useRef(overseer)
  currentOverseerRef.current = overseer
  const workpieceIdRef = useRef(workpieceId)
  workpieceIdRef.current = workpieceId

  // The store reads through the current stub; the adapter's identity follows it so the hooks'
  // effects re-run on a reconnect.
  const reader = useMemo<CommitFileReader>(() => ({
    listTree: commitId => overseer.listTree(commitId),
    readFilesAtCommit: (commitId, paths) => overseer.readFilesAtCommit(commitId, paths),
  }), [overseer])
  const readerRef = useRef(reader)
  readerRef.current = reader

  // The content and review bases (see the module comment), from the selected chat's pin for
  // this workpiece, else the accepted commit. Both undefined for a pending (chat-created)
  // gadget, whose content is the overlay alone.
  const chatPin = branchMode && chatChanges !== undefined && chatChanges.chatId === selectedChatId
    ? chatChanges.codeBase?.pins.find(pin => pin.gadgetId === workpieceId)
    : undefined
  const contentBase = chatPin?.baseCommit ?? acceptedCommit
  const contentBaseRef = useRef(contentBase)
  contentBaseRef.current = contentBase
  const reviewBase = chatPin?.mergedCommit ?? acceptedCommit

  // The content base's tree. A failed fetch renders an error state with a retry (the store
  // evicts failures, so bumping the token genuinely refetches); without it the pane would sit
  // in its loading state forever.
  const [treeRetryToken, setTreeRetryToken] = useState(0)
  const { tree: baseTree, error: treeError } = useCommitTree(reader, contentBase, treeRetryToken)
  useEffect(() => {
    if (treeError === null) return
    console.error('Failed to load committed code:', treeError)
    reportIssue('code-view.commit-tree', treeError, { handled: true })
  }, [treeError])

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
  const fileListenersRef = useRef(new Map<string, Set<(change: FileChange) => void>>())

  // Streaming edit-preview state (see the module comment above PreviewOverlay): the call whose
  // content is streaming, its display overlay once attached, finished previews awaiting their
  // durable rows (per file, in call order), finished previews that could not attach because
  // their file's base text was still loading (in call order; they join the pending chains once
  // it lands -- see attachDeferred), and the call whose preview could not attach (no unique
  // textToReplace match) and stays skipped. `retryPreviewAttachRef` is the attach function,
  // installed by the subscription effect (it closes over the OT client) so readiness changes
  // and the row interception can retry/re-anchor attachment. `previewBaseReadsRef` dedupes the
  // base reads attachment kicks off, keyed like the previews.
  const streamingPreviewRef = useRef<StreamingPreview | null>(null)
  const activeOverlayRef = useRef<PreviewOverlay | null>(null)
  const pendingPreviewsRef = useRef(new Map<string, PendingPreview[]>())
  const deferredPreviewsRef = useRef<StreamingPreview[]>([])
  const skippedPreviewRef = useRef<string | null>(null)
  const retryPreviewAttachRef = useRef<(() => void) | null>(null)
  const previewBaseReadsRef = useRef(new Set<string>())

  const dispatchFileChange = useCallback(
    (gadgetId: WorkpieceId, path: string, change: FileChange) => {
      fileListenersRef.current.get(fileKey(gadgetId, path))
        ?.forEach(listener => listener(change))
    }, [])

  const contentBumpPendingRef = useRef(false)
  const bumpContentVersion = useCallback(() => {
    if (!contentBumpPendingRef.current) {
      contentBumpPendingRef.current = true
      requestAnimationFrame(() => {
        contentBumpPendingRef.current = false
        setContentVersion(version => version + 1)
      })
    }
  }, [])

  const [clientState, setClientState] =
    useState<{ chatId: number, client: ChatOtClient } | null>(null)
  useEffect(() => {
    if (selectedChatId === null) {
      setClientState(null)
      return
    }
    const chatId = selectedChatId
    const client = new ChatOtClient({
      fetchFilesAtCommit: async (commitId, paths) => {
        const files = await commitFileStore.readFiles(readerRef.current, commitId, paths)
        const texts = new Map<string, string | null>()
        for (const [path, file] of files) {
          if (file.kind === 'unreadable') {
            throw new Error(`base of an edited file is unreadable: ${path}: ${file.message}`)
          }
          texts.set(path, file.kind === 'text' ? file.text : null)
        }
        return texts
      },
      submitCodeChange: submission =>
        currentOverseerRef.current.submitCodeChange(chatId, submission),
      isTransientError: isTransientRpcError,
      onRemoteChange: (events: RemoteFileEvent[]) => {
        if (events.length === 0) {
          // Coarse change (rebuild / epoch reset): open editors reload from the client. Any
          // preview state was part of what's being discarded.
          streamingPreviewRef.current = null
          activeOverlayRef.current = null
          pendingPreviewsRef.current.clear()
          deferredPreviewsRef.current.length = 0
          setResetToken(token => token + 1)
        } else {
          for (const event of events) {
            const key = fileKey(event.gadgetId, event.path)
            const chain = pendingPreviewsRef.current.get(key)
            if (chain !== undefined && chain.length > 0) {
              // The oldest finished preview of this file resolves: rows arrive in call order,
              // so this row should be that call's completion, making the client's new content
              // exactly the preview's final text. The doc -- showing that text, or a later
              // preview stacked on it -- is then already consistent, so forward nothing.
              const confirmed = chain.shift()!
              if (chain.length === 0) pendingPreviewsRef.current.delete(key)
              const clientText = client.getFiles(event.gadgetId)?.get(event.path)
              if (clientText === confirmed.text) continue
              // Divergence (a call this preview stack didn't cover, or our span anchoring
              // drifted): drop the file's whole stack, reset its editors from the client, and
              // re-anchor the streaming preview on the fresh content.
              pendingPreviewsRef.current.delete(key)
              const overlay = activeOverlayRef.current
              if (overlay !== null && overlay.gadgetId === event.gadgetId &&
                  overlay.path === event.path) {
                activeOverlayRef.current = null
              }
              dispatchFileChange(event.gadgetId, event.path,
                clientText !== undefined ? { set: clientText } : { remove: true })
              retryPreviewAttachRef.current?.()
              continue
            }
            // A finished preview still waiting for its base text is resolved by its row the
            // same way -- except that nothing was ever displayed for it, so the row applies as
            // an ordinary change. Left in place, it would attach later against the post-row
            // text and show the edit twice (or fail to match and be skipped).
            const deferred = deferredPreviewsRef.current
            const deferredIndex = deferred.findIndex(preview =>
              preview.gadgetId === event.gadgetId && preview.path === event.path)
            if (deferredIndex >= 0) {
              deferred.splice(deferredIndex, 1)
              dispatchFileChange(event.gadgetId, event.path, event.change)
              continue
            }
            const overlay = activeOverlayRef.current
            const streaming = streamingPreviewRef.current
            if (overlay === null && streaming !== null && streaming.gadgetId === event.gadgetId &&
                streaming.path === event.path) {
              // The streaming call completed before its preview could attach (its base text
              // was still loading): its row is the whole of its effect.
              streamingPreviewRef.current = null
              dispatchFileChange(event.gadgetId, event.path, event.change)
              continue
            }
            if (overlay !== null && overlay.gadgetId === event.gadgetId &&
                overlay.path === event.path) {
              activeOverlayRef.current = null
              const text = client.getFiles(event.gadgetId)?.get(event.path)
              if (text === previewedText(overlay)) {
                // The streaming call's own completion (the ordinary end for the response's last
                // edit, whose preview no later start finalizes): the doc already shows exactly
                // this content, so the preview simply resolves.
                streamingPreviewRef.current = null
                continue
              }
              // Otherwise a row landed *under* the still-streaming preview (a call of this
              // response that streamed no preview, or another producer). Reset the doc from the
              // client -- the incremental change's offsets are against the client's pre-row
              // content, not the previewed document -- and re-anchor the preview on top.
              dispatchFileChange(event.gadgetId, event.path,
                text !== undefined ? { set: text } : { remove: true })
              retryPreviewAttachRef.current?.()
              continue
            }
            dispatchFileChange(event.gadgetId, event.path, event.change)
          }
        }
        bumpContentVersion()
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
  const clientRef = useRef(client)
  clientRef.current = client

  // Feed live rows to the client by subscribing to the chat's row stream: retained rows are
  // replayed at subscribe time (the client dedupes by (generation, revision)) and new rows
  // arrive synchronously from the RPC callback -- before the materialization watermark that
  // absorbs them can prune the buffer, and before the render cycle delivers the durable
  // snapshot they precede (see ChatLiveChangeRows). Declared *before* the durable-state effect so
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
        epochChange: chatChanges.epochChange,
        rowsThrough: chatChanges.rowsThrough,
      })
    }
  }, [client, chatChanges, selectedChatId])

  useEffect(() => {
    client?.setPendingCreations(pendingGadgetIds ?? NO_PENDING_GADGETS)
  }, [client, pendingGadgetIds])

  // Feed the edit-preview event stream into the preview state (see the module comment above
  // PreviewOverlay): attach a starting call's overlay -- locating the replaced span in this
  // client's own copy of the file (or the finished preview stacked beneath it), which mirrors
  // the content the agent computes its edit against -- extend it as text streams in, keep
  // finished previews displayed as pending entries until their rows resolve them, and withdraw
  // cleared ones. Content deltas reach open editors through the same per-file listener channel
  // as OT remote changes; the file list and diff statuses re-derive from the overlaid text via
  // contentVersion.
  useEffect(() => {
    if (client === null || liveEditPreviews === undefined ||
        liveEditPreviews.chatId !== selectedChatId) return

    // The file's real (non-previewed) text: the chat's content when it holds the path (or shows
    // it removed), else the path's text at the selected gadget's content base. `undefined`
    // while still loading -- a base text not yet in the store is fetched, and attachment
    // retried when it lands (`text` is cumulative, so attaching late loses nothing). Only the
    // selected gadget's base is known here; another gadget's preview attaches once selected.
    const resolveRealText = (gadgetId: WorkpieceId, path: string): { text?: string } | undefined => {
      if (!client.isReady()) return undefined
      const files = client.getFiles(gadgetId)
      if (files !== undefined) {
        const text = files.get(path)
        if (text !== undefined) return { text }
        if (client.getRemovedPaths(gadgetId).has(path)) return {}
      }
      if (gadgetId !== workpieceIdRef.current) return undefined
      const base = contentBaseRef.current
      if (base === undefined) return {}  // a pending gadget: nothing but the overlay
      const known = commitFileStore.peekFile(base, path)
      if (known === undefined) {
        const readKey = fileKey(gadgetId, path)
        if (!previewBaseReadsRef.current.has(readKey)) {
          previewBaseReadsRef.current.add(readKey)
          commitFileStore.readFiles(readerRef.current, base, [path]).then(
            () => {
              previewBaseReadsRef.current.delete(readKey)
              retryPreviewAttachRef.current?.()
            },
            () => { previewBaseReadsRef.current.delete(readKey) })
        }
        return undefined
      }
      return known.kind === 'text' ? { text: known.text } : {}
    }

    // Restore one file's open editors to what the display shows without the streaming overlay:
    // its newest pending preview, else the real content (skipped while that is still loading --
    // rare, and the next row or reset settles it).
    const restoreFileDoc = (gadgetId: WorkpieceId, path: string) => {
      const chain = pendingPreviewsRef.current.get(fileKey(gadgetId, path))
      let text: string | undefined
      if (chain !== undefined && chain.length > 0) {
        text = chain[chain.length - 1].text
      } else {
        const real = resolveRealText(gadgetId, path)
        if (real === undefined) return
        text = real.text
      }
      dispatchFileChange(gadgetId, path, text !== undefined ? { set: text } : { remove: true })
    }

    // The text a preview of `path` stacks on: the newest finished preview of the file (the
    // agent computed its edit against content that includes that call's edit, whose row hasn't
    // landed yet), else the real text. Undefined while the real text is still loading.
    const previewBaseText = (gadgetId: WorkpieceId, path: string): { text?: string } | undefined => {
      const chain = pendingPreviewsRef.current.get(fileKey(gadgetId, path))
      if (chain !== undefined && chain.length > 0) return { text: chain[chain.length - 1].text }
      return resolveRealText(gadgetId, path)
    }

    // Move finished previews whose base text has since arrived onto their files' pending
    // chains, in call order, dispatching each file's resulting text to its open editors. A
    // preview whose base is still loading blocks only the later previews of its own file (they
    // stack on it); other files' previews proceed.
    const attachDeferred = () => {
      const deferred = deferredPreviewsRef.current
      const blocked = new Set<string>()
      for (let i = 0; i < deferred.length;) {
        const preview = deferred[i]
        const key = fileKey(preview.gadgetId, preview.path)
        const base = blocked.has(key) ? undefined : previewBaseText(preview.gadgetId, preview.path)
        if (base === undefined) {
          blocked.add(key)
          i++
          continue
        }
        deferred.splice(i, 1)
        const span = locatePreviewSpan(preview, base.text)
        if (span === null) continue  // no unique match: nothing to show (see locatePreviewSpan)
        const fileText = base.text ?? ''
        const text = fileText.slice(0, span.from) + preview.text + fileText.slice(span.to)
        let chain = pendingPreviewsRef.current.get(key)
        if (chain === undefined) {
          chain = []
          pendingPreviewsRef.current.set(key, chain)
        }
        chain.push({ toolCallId: preview.toolCallId, text })
        dispatchFileChange(preview.gadgetId, preview.path, { set: text })
        bumpContentVersion()
      }
    }

    // Attach the streaming preview's overlay, if its base content is available. Idempotent and
    // late-callable (`text` is cumulative): retried on every delta, on readiness changes (the
    // client's first snapshot, a base text arriving), and by the row interception's
    // re-anchoring. Deferred previews go first: the streaming one may stack on them.
    const tryAttach = () => {
      attachDeferred()
      const streaming = streamingPreviewRef.current
      if (streaming === null || activeOverlayRef.current !== null) return
      if (skippedPreviewRef.current === streaming.toolCallId) return
      const streamingBase = previewBaseText(streaming.gadgetId, streaming.path)
      if (streamingBase === undefined) return // still loading; retried per the note above
      const fileText = streamingBase.text
      const span = locatePreviewSpan(streaming, fileText)
      if (span === null) {
        skippedPreviewRef.current = streaming.toolCallId
        return
      }
      const { from, to } = span
      const base = fileText ?? ''
      activeOverlayRef.current = {
        toolCallId: streaming.toolCallId,
        gadgetId: streaming.gadgetId,
        path: streaming.path,
        base, from, to,
        text: streaming.text,
      }
      // Bring open editors to the previewed state in one dispatch: the span replaced by the
      // text streamed so far. (A file being created has no open editor yet -- the overlay makes
      // it appear in the file list, and an editor opened on it builds from getText().)
      if (from !== to || streaming.text !== '') {
        dispatchFileChange(streaming.gadgetId, streaming.path,
          { edit: replaceSpanTextChange(base.length, from, to, streaming.text) })
      }
      bumpContentVersion()
    }
    retryPreviewAttachRef.current = tryAttach

    // End the streaming preview's delta stream, keeping its final text displayed as a pending
    // entry until its durable row (or a clear) resolves it -- restoring the file here would
    // make each edit vanish until the calls execute, which happens only after the whole model
    // response has streamed. One that never attached because its base text is still loading
    // is deferred rather than dropped: with content read lazily, a short edit followed by the
    // next call routinely finishes inside that read's round trip.
    const finalizeStreaming = () => {
      const streaming = streamingPreviewRef.current
      streamingPreviewRef.current = null
      const overlay = activeOverlayRef.current
      if (overlay === null) {
        if (streaming !== null && skippedPreviewRef.current !== streaming.toolCallId) {
          deferredPreviewsRef.current.push(streaming)
        }
        return
      }
      activeOverlayRef.current = null
      const key = fileKey(overlay.gadgetId, overlay.path)
      let chain = pendingPreviewsRef.current.get(key)
      if (chain === undefined) {
        chain = []
        pendingPreviewsRef.current.set(key, chain)
      }
      chain.push({ toolCallId: overlay.toolCallId, text: previewedText(overlay) })
    }

    const unsubscribe = liveEditPreviews.subscribe((event: EditPreviewEvent) => {
      switch (event.kind) {
        case 'start':
          finalizeStreaming()
          streamingPreviewRef.current = {
            toolCallId: event.toolCallId,
            gadgetId: event.workpieceId,
            path: event.filename,
            ...(event.textToReplace !== undefined
              ? { textToReplace: event.textToReplace } : {}),
            text: '',
          }
          tryAttach()
          break

        case 'delta': {
          const streaming = streamingPreviewRef.current
          if (streaming === null || streaming.toolCallId !== event.toolCallId ||
              event.delta === '') break
          streaming.text += event.delta
          const overlay = activeOverlayRef.current
          if (overlay !== null) {
            // Attached: dispatch just the new characters at the growing insertion point.
            const docLen = overlay.base.length - (overlay.to - overlay.from) + overlay.text.length
            const pos = overlay.from + overlay.text.length
            overlay.text = streaming.text
            dispatchFileChange(overlay.gadgetId, overlay.path,
              { edit: replaceSpanTextChange(docLen, pos, pos, event.delta) })
            bumpContentVersion()
          } else {
            tryAttach()
          }
          break
        }

        case 'clear': {
          // The named call will produce no row (it failed -- possibly surfacing only at
          // execution, after later calls' previews streamed -- or was a no-op).
          const streaming = streamingPreviewRef.current
          if (streaming !== null && streaming.toolCallId === event.toolCallId) {
            streamingPreviewRef.current = null
            const overlay = activeOverlayRef.current
            if (overlay !== null) {
              activeOverlayRef.current = null
              restoreFileDoc(overlay.gadgetId, overlay.path)
              bumpContentVersion()
            }
            break
          }
          // A finished preview still waiting for its base: nothing is displayed for it.
          const deferred = deferredPreviewsRef.current
          const deferredIndex = deferred.findIndex(entry => entry.toolCallId === event.toolCallId)
          if (deferredIndex >= 0) {
            deferred.splice(deferredIndex, 1)
            break
          }
          // A finished preview: remove its pending entry. Only a tail removal changes the
          // display; a mid-chain removal leaves the later previews' stacked text visible, and
          // the row interception's mismatch check self-heals when their rows arrive.
          for (const [key, chain] of pendingPreviewsRef.current) {
            const index = chain.findIndex(entry => entry.toolCallId === event.toolCallId)
            if (index < 0) continue
            const wasTail = index === chain.length - 1
            chain.splice(index, 1)
            if (chain.length === 0) pendingPreviewsRef.current.delete(key)
            if (wasTail) {
              const [gadgetId, path] = splitFileKey(key)
              const overlay = activeOverlayRef.current
              if (overlay !== null && overlay.gadgetId === gadgetId && overlay.path === path) {
                // The streaming preview was stacked on the removed text; re-anchor it.
                activeOverlayRef.current = null
                restoreFileDoc(gadgetId, path)
                tryAttach()
              } else {
                restoreFileDoc(gadgetId, path)
              }
              bumpContentVersion()
            }
            break
          }
          break
        }

        case 'reset': {
          // Turn over / stream lost: drop everything and restore affected files' editors to
          // the real content.
          const affected = new Set<string>(pendingPreviewsRef.current.keys())
          const overlay = activeOverlayRef.current
          if (overlay !== null) affected.add(fileKey(overlay.gadgetId, overlay.path))
          streamingPreviewRef.current = null
          activeOverlayRef.current = null
          pendingPreviewsRef.current.clear()
          deferredPreviewsRef.current.length = 0
          if (affected.size > 0) {
            for (const key of affected) {
              const [gadgetId, path] = splitFileKey(key)
              const real = resolveRealText(gadgetId, path)
              if (real === undefined) continue
              dispatchFileChange(gadgetId, path,
                real.text !== undefined ? { set: real.text } : { remove: true })
            }
            bumpContentVersion()
          }
          break
        }
      }
    })
    return () => {
      unsubscribe()
      retryPreviewAttachRef.current = null
      // Chat/client switches tear down the editor sessions these overlays were dispatched
      // into; drop the state rather than restoring into documents being rebuilt anyway.
      streamingPreviewRef.current = null
      activeOverlayRef.current = null
      pendingPreviewsRef.current.clear()
      deferredPreviewsRef.current.length = 0
      previewBaseReadsRef.current.clear()
    }
  }, [client, liveEditPreviews, selectedChatId, dispatchFileChange, bumpContentVersion])

  // The client is ready once its first durable snapshot has been folded.
  const clientReady = branchMode && client !== null && chatChanges !== undefined &&
    chatChanges.chatId === selectedChatId && client.isReady()
  // Re-evaluated per content change; contentVersion is the (deliberate) extra dependency.
  void contentVersion

  // A preview that couldn't attach while its base content was unavailable retries when that
  // changes -- the client's first snapshot folds, the content base moves, or the selection
  // switches to the previewed gadget (the base fallback in resolveRealText applies only to the
  // selected gadget). Without this, a short edit (whose whole preview streams before the base
  // is available) would deliver no further delta to retry on and never appear.
  useEffect(() => {
    retryPreviewAttachRef.current?.()
  }, [clientReady, contentBase, workpieceId])

  // The chat's content for the selected gadget -- its touched paths' text and its removed
  // paths -- or undefined when the gadget is not part of the chat's content (it then tracks
  // mainline head live).
  const chatFiles = clientReady ? client!.getFiles(workpieceId) : undefined
  const removedPaths: ReadonlySet<string> =
    clientReady && chatFiles !== undefined ? client!.getRemovedPaths(workpieceId) : NO_REMOVED
  const removedSignature = [...removedPaths].toSorted().join('\u0000')

  // The preview state's display overrides for the selected gadget: each previewed file shows
  // its preview text -- the streaming overlay's, or its newest finished (pending) preview's --
  // and a file mid-creation appears in the list. Read from the refs per render; the preview
  // handlers bump contentVersion whenever any of it changes.
  const previewOverrides = new Map<string, string>()
  if (branchMode) {
    for (const [key, chain] of pendingPreviewsRef.current) {
      if (chain.length === 0) continue
      const [gadgetId, path] = splitFileKey(key)
      if (gadgetId === workpieceId) previewOverrides.set(path, chain[chain.length - 1].text)
    }
    const overlay = activeOverlayRef.current
    if (overlay !== null && overlay.gadgetId === workpieceId) {
      previewOverrides.set(overlay.path, previewedText(overlay))
    }
  }

  // The text the view displays for a path, without reading any base content: a preview's, the
  // chat's, or -- for a path the chat removed -- null. Undefined means the path is untouched
  // and its text is the content base's (readDisplayedText and the active-file resolution below
  // complete the picture).
  const overlayText = (path: string): string | undefined | null => {
    const preview = previewOverrides.get(path)
    if (preview !== undefined) return preview
    if (chatFiles !== undefined) {
      const text = chatFiles.get(path)
      if (text !== undefined) return text
      if (removedPaths.has(path)) return null
    }
    return undefined
  }

  // An unpinned workpiece's editor shows the accepted commit's content; when that advances (a
  // gadget: another chat's accept; a worktree: this chat's), open editors must reload from the
  // new base.
  const prevUnpinnedBaseRef = useRef(acceptedCommit)
  useEffect(() => {
    if (!clientReady) return
    if (!client!.hasGadget(workpieceId) && prevUnpinnedBaseRef.current !== acceptedCommit) {
      setResetToken(token => token + 1)
    }
    prevUnpinnedBaseRef.current = acceptedCommit
  }, [client, clientReady, acceptedCommit, workpieceId])

  // ---- file selection ----------------------------------------------------------------------

  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false)
  const [compactLayout, setCompactLayout] = useState(false)
  const fileBrowserRef = useRef<FileBrowserHandle | null>(null)
  // Which directories the user opened or closed in each workpiece's tree, kept for as long as
  // this view is mounted (the workspace's session): the browser remounts on a workpiece switch,
  // and switching back should find the tree as it was left rather than at its defaults.
  const expandedDirsByWorkpieceRef = useRef(new Map<WorkpieceId, ExpandedDirs>())
  const fileDrawerRef = useRef<HTMLDivElement | null>(null)
  const fileDrawerTriggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!isVisible) setFileDrawerOpen(false)
  }, [isVisible])

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(max-width: 767px)')
    const update = () => {
      setCompactLayout(query.matches)
      if (!query.matches) setFileDrawerOpen(false)
    }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!compactLayout || !fileDrawerOpen) return
    const drawer = fileDrawerRef.current
    drawer?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileDrawerOpen(false)
        return
      }
      if (event.key !== 'Tab' || !drawer) return
      const focusable = [...drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (fileDrawerTriggerRef.current?.isConnected) fileDrawerTriggerRef.current.focus()
    }
  }, [compactLayout, fileDrawerOpen])

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

  // When the selected workpiece changes, the previous workpiece's file selection and per-turn
  // state are meaningless; reset so the auto-select effect picks a file from the new one. Done
  // during render, not in an effect: the file browser remounts in this same render (keyed by
  // workpiece) and reveals the active file's directories, so an effect would let it open -- and
  // remember, as the new workpiece's expansion state -- the old workpiece's path.
  const [activeFileWorkpiece, setActiveFileWorkpiece] = useState(workpieceId)
  if (activeFileWorkpiece !== workpieceId) {
    setActiveFileWorkpiece(workpieceId)
    setActiveFile(null)
    hasUserSwitchedFilesThisTurnRef.current = false
  }

  // The paths whose text differs (or may differ) from the content base: the chat's touched
  // paths plus the previewed ones. Everything else displays the base's text and needs no
  // review-base read.
  const previewedNamesSignature = [...previewOverrides.keys()].toSorted().join('\u0000')
  const touchedPaths: readonly string[] = useMemo(() => {
    const names = new Set<string>(chatFiles !== undefined ? chatFiles.keys() : [])
    if (removedSignature !== '') for (const name of removedSignature.split('\u0000')) names.add(name)
    if (previewedNamesSignature !== '') {
      for (const name of previewedNamesSignature.split('\u0000')) names.add(name)
    }
    return [...names].toSorted()
  }, [chatFiles, removedSignature, previewedNamesSignature])

  // Review-base content for the touched paths and the open file: the "original" side of diffs
  // and the source of the statuses. One coalesced read per render that adds paths.
  const reviewPaths = useMemo(() => {
    if (activeFile === null || touchedPaths.includes(activeFile)) return touchedPaths
    return [...touchedPaths, activeFile].toSorted()
  }, [touchedPaths, activeFile])
  // A failed read of either leaves the open file's pane in an error state with a retry; the
  // token re-runs both reads.
  const [fileRetryToken, setFileRetryToken] = useState(0)
  const { files: reviewFiles, error: reviewError } =
    useFilesAtCommit(reader, branchMode ? reviewBase : undefined, reviewPaths, fileRetryToken)
  // Content-base text for the open file, when the overlay doesn't cover it.
  const activeBasePaths = useMemo(
    () => (activeFile !== null ? [activeFile] : NO_PATHS), [activeFile])
  const { files: activeBaseFiles, error: activeBaseError } =
    useFilesAtCommit(reader, contentBase, activeBasePaths, fileRetryToken)

  // ---- the tree and the changes list -------------------------------------------------------

  // The displayed tree (see buildBrowserTree): the content base's tree less the chat's removals,
  // plus the chat's and the previews' files (which may be mid-creation). Null while the base
  // tree is loading. A removed file is not in the tree; it is reviewable from the Changes list
  // below, which lists it as deleted while it exists at the review base.
  //
  // Keyed on the *set* of overlaid paths (as signatures), not on the content maps: the tree is
  // proportional to the repository, and a keystroke must not rebuild it.
  const presentSignature = branchMode
    ? touchedPaths.filter(path => !removedPaths.has(path)).join('\u0000')
    : ''
  const browserTree = useMemo(() => {
    if (baseTree === null) return null
    const present = presentSignature === '' ? NO_PATHS : presentSignature.split('\u0000')
    const removed = removedSignature === '' ? NO_REMOVED : new Set(removedSignature.split('\u0000'))
    return buildBrowserTree(baseTree, present, removed)
  }, [baseTree, presentSignature, removedSignature])

  // Statuses against the review base. Only touched paths can differ from it: an untouched path
  // displays the content base's text, and every path where the review base differs from the
  // content base was touched by the rows that imported the difference. A touched path whose
  // review-base read is still in flight has no status yet; a removed one is listed as pending
  // meanwhile (see deriveChanges), so that if the read fails the deletion candidate is still
  // there to select and its pane shows the error and retry. `changes` is in path order.
  const isDiffMode = branchMode
  let fileChangeStatuses: Map<string, FileChangeStatus> | undefined
  let changes: readonly ChangedFile[] = NO_CHANGES
  if (isDiffMode) {
    const derived = deriveChanges(touchedPaths, overlayText, reviewFiles, reviewBase !== undefined)
    fileChangeStatuses = derived.statuses
    changes = derived.changes
  }

  // Every path the view can show, changed files first (so the auto-selection below lands on
  // one) and then the tree's leaves in display order. Empty while the tree is loading.
  const treePaths = useMemo(
    () => (browserTree !== null ? browserTreePaths(browserTree.roots) : NO_PATHS), [browserTree])
  const changedSignature = changes.map(change => change.path).join('\u0000')
  const displayedFiles: readonly string[] = useMemo(() => {
    if (browserTree === null) return NO_PATHS
    const names = changedSignature === '' ? [] : changedSignature.split('\u0000')
    const seen = new Set(names)
    for (const path of treePaths) {
      if (!seen.has(path)) names.push(path)
    }
    return names
  }, [browserTree, treePaths, changedSignature])
  const displayedFilesRef = useRef(displayedFiles)
  const prevDisplayedFilesRef = useRef<readonly string[]>(NO_PATHS)
  // Stabilize identity so downstream effects don't churn per contentVersion bump.
  const stableDisplayedFiles = areArraysEqual(prevDisplayedFilesRef.current, displayedFiles)
    ? prevDisplayedFilesRef.current
    : displayedFiles
  prevDisplayedFilesRef.current = stableDisplayedFiles
  displayedFilesRef.current = stableDisplayedFiles
  // A displayed path's entry kind; a path not in the tree (a deleted file, listed only under
  // Changes) opens as a file.
  const browserTreeRef = useRef(browserTree)
  browserTreeRef.current = browserTree
  const leafKindOf = (path: string) => browserTreeRef.current?.leaves.get(path) ?? 'file'
  // Whether a path currently names a file: a leaf of the displayed tree. Not the same as being
  // listed -- a deleted (or pending) path is listed under Changes but is free to be created or
  // renamed onto again.
  const fileExists = (path: string) => browserTreeRef.current?.leaves.has(path) ?? false

  // Auto-select a file when files appear and nothing is selected: the first changed file when
  // there is one, else the first leaf that can open (a symlink or submodule cannot).
  useEffect(() => {
    if (activeFile !== null) return
    const first = stableDisplayedFiles.find(path => isOpenableKind(leafKindOf(path)))
    if (first !== undefined) setActiveFile(first)
  }, [activeFile, stableDisplayedFiles])

  // Avoid reporting an empty state before the committed tree has loaded. The content base's
  // tree stands in for the accepted commit's: they differ only for a chat pinned at an older
  // commit, and whether the workpiece has code at all doesn't turn on that.
  const onHasCodeChangeRef = useRef(onHasCodeChange)
  onHasCodeChangeRef.current = onHasCodeChange
  useEffect(() => {
    if (baseTree !== null) {
      onHasCodeChangeRef.current?.(baseTree.length > 0)
    }
  }, [baseTree])

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

  // ---- editing -----------------------------------------------------------------------------

  // Editing is locked outside a chat (committed code only changes through a chat's accept),
  // while an agent turn is active (its edits stream into the same file), and until the chat's
  // content has loaded.
  const isEditingLocked = !branchMode || isAgentActive || !clientReady

  // Apply whole-file operations (create / delete / rename) as local changes. `set` and `remove`
  // need no base text; the seeding call matters for an unpinned gadget, which it makes part of
  // the chat's content (with nothing held) so the pin is declared on submission.
  const applyLocalFileChanges = useCallback((changes: [string, FileChange][]) => {
    if (client === null) return false
    for (const [path] of changes) {
      client.ensureFileEditable(workpieceIdRef.current, contentBaseRef.current, path, undefined)
    }
    const change: CodeChange = { [workpieceIdRef.current]: changes }
    client.applyLocalChange(change)
    // Local edits get no client notification (our own echo is silent -- see
    // ChatOtClientDelegate.onRemoteChange), so re-derive the file list and statuses here.
    bumpContentVersion()
    return true
  }, [client, bumpContentVersion])

  // The text of a path at the content base, read through the store (for operations on files
  // the overlay doesn't cover, whose text may not be loaded yet). Null when it has none.
  const readBaseText = useCallback(async (path: string): Promise<string | null> => {
    const base = contentBaseRef.current
    if (base === undefined) return null
    const files = await commitFileStore.readFiles(readerRef.current, base, [path])
    const file = files.get(path)
    return file?.kind === 'text' ? file.text : null
  }, [])

  // The active file's editing session (see EditSession in CodeEditor). Identity is stable
  // across content changes -- the editor patches its document from remote deltas -- and rolls
  // over on chat/gadget/file switches and wholesale resets.
  const activeSession: EditSession | undefined = useMemo(() => {
    if (!branchMode || client === null || activeFile === null) return undefined
    const gadgetId = workpieceId
    const path = activeFile
    const listenerKey = fileKey(gadgetId, path)
    return {
      key: `${selectedChatId}:${resetToken}:${gadgetId}:${path}`,
      getText: () => {
        // An editor (re)built while previews cover this file starts from the previewed text:
        // the streaming overlay's (subsequent deltas continue from it), else the newest
        // finished preview's (still displayed while awaiting its row).
        const overlay = activeOverlayRef.current
        if (overlay !== null && overlay.gadgetId === gadgetId && overlay.path === path) {
          return previewedText(overlay)
        }
        const chain = pendingPreviewsRef.current.get(listenerKey)
        if (chain !== undefined && chain.length > 0) {
          return chain[chain.length - 1].text
        }
        // The chat's text when it holds the path; a path the chat removed is *deleted* and
        // surfaces as empty (the diff view's original side shows the removed content), not as
        // the base text masquerading as unchanged; anything else is untouched and reads from
        // the content base, which the store has loaded (the editor renders only once it has).
        const files = client.getFiles(gadgetId)
        if (files !== undefined) {
          const text = files.get(path)
          if (text !== undefined) return text
          if (client.getRemovedPaths(gadgetId).has(path)) return undefined
        }
        const base = contentBaseRef.current
        const known = base !== undefined ? commitFileStore.peekFile(base, path) : undefined
        return known?.kind === 'text' ? known.text : undefined
      },
      applyLocal: (change: FileChange, docText: string) => {
        try {
          const files = client.getFiles(gadgetId)
          let fileChange: FileChange
          if (files?.has(path)) {
            fileChange = change
          } else if (files !== undefined && client.getRemovedPaths(gadgetId).has(path)) {
            // Editing a file the chat's content removed (e.g. it was deleted in the chat while
            // its editor stayed open) re-creates it with the editor's text.
            fileChange = { set: docText }
          } else {
            // An untouched path (or an unpinned gadget): seed its base text -- the text this
            // editor was built from -- so the edit has something to apply to, pinning the
            // gadget on its first edit if need be.
            const base = contentBaseRef.current
            const known = base !== undefined ? commitFileStore.peekFile(base, path) : undefined
            const baseText = known?.kind === 'text' ? known.text : undefined
            client.ensureFileEditable(gadgetId, base, path, baseText)
            fileChange = baseText !== undefined ? change : { set: docText }
          }
          client.applyLocalChange({ [gadgetId]: [[path, fileChange]] })
          // Local edits get no client notification (our own echo is silent -- see
          // ChatOtClientDelegate.onRemoteChange), so re-derive the sidebar's diff statuses here.
          bumpContentVersion()
        } catch (err) {
          // The editor's document drifted from the client's content (a bug); reload it from
          // the client rather than corrupting the chat.
          console.error('Local edit did not fit chat content; reloading editor:', err)
          reportIssue('code-view.local-edit', err, { handled: true })
          setResetToken(token => token + 1)
        }
      },
      subscribeRemote: (listener: (change: FileChange) => void) => {
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
  }, [branchMode, client, activeFile, workpieceId, selectedChatId, resetToken,
      bumpContentVersion])

  // ---- file management (create / delete / rename / download) --------------------------------

  const handleFileSelect = (filename: string) => {
    if (!isOpenableKind(leafKindOf(filename))) return
    if (activeFile !== filename) {
      hasUserSwitchedFilesThisTurnRef.current = true
    }
    setActiveFile(filename)
  }

  // A displayed file's text: the overlay's when it covers the path, else read from the content
  // base (async: the store may not hold it yet). Null for a file with no text (removed, absent,
  // unreadable).
  const readDisplayedText = async (filename: string): Promise<string | null> => {
    const overlaid = overlayText(filename)
    if (overlaid !== undefined) return overlaid
    return readBaseText(filename)
  }

  const handleFileCreate = (filename: string) => {
    if (isEditingLocked) return
    if (fileExists(filename)) {
      toasts.add({ title: `File already exists: ${filename}`, variant: 'error' })
      return
    }
    if (applyLocalFileChanges([[filename, { set: '' }]])) {
      setActiveFile(filename)
      toasts.add({ title: `Created file: ${filename}`, variant: 'success' })
    }
  }

  const handleFileDelete = (filename: string) => {
    if (isEditingLocked) return
    if (!fileExists(filename)) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }
    if (applyLocalFileChanges([[filename, { remove: true }]])) {
      if (activeFile === filename) {
        const remaining = displayedFilesRef.current.filter(name => name !== filename)
        setActiveFile(remaining.length > 0 ? remaining[0] : null)
      }
      toasts.add({ title: `Deleted file: ${filename}`, variant: 'success' })
    }
  }

  const handleFileRename = async (oldName: string, newName: string) => {
    if (isEditingLocked) return
    // Only a plain file can be renamed: the browser withholds the action from other kinds (see
    // FileBrowser for why an executable is among them), and this is the backstop.
    if (leafKindOf(oldName) !== 'file') return
    if (fileExists(newName)) {
      toasts.add({ title: `File already exists: ${newName}`, variant: 'error' })
      return
    }
    const target = { client, gadgetId: workpieceId, contentBase }
    const baseText = fileExists(oldName)
      ? await readDisplayedText(oldName).catch(() => null)
      : null
    // The read may have outlasted the selection: applyLocalFileChanges targets the *current*
    // gadget, and this rename belongs to the one it started on.
    if (target.client === null || clientRef.current !== target.client ||
        workpieceIdRef.current !== target.gadgetId ||
        contentBaseRef.current !== target.contentBase) {
      return
    }
    // The gadget's own files may have moved meanwhile too (a collaborator's rows): take the
    // source text as the chat holds it *now* -- the read is only right while the path is still
    // untouched -- and refuse a destination that has since come to exist.
    const chatFilesNow = target.client.getFiles(target.gadgetId)
    const text = chatFilesNow?.get(oldName) ??
      (target.client.getRemovedPaths(target.gadgetId).has(oldName) ? null : baseText)
    if (text === null) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }
    if (chatFilesNow?.has(newName) || fileExists(newName)) {
      toasts.add({ title: `File already exists: ${newName}`, variant: 'error' })
      return
    }
    if (applyLocalFileChanges([[oldName, { remove: true }], [newName, { set: text }]])) {
      if (activeFile === oldName) {
        setActiveFile(newName)
      }
      toasts.add({ title: `Renamed file: ${oldName} \u2192 ${newName}`, variant: 'success' })
    }
  }

  const handleFileDownload = async (filename: string) => {
    const text = await readDisplayedText(filename).catch(() => null)
    if (text === null) {
      toasts.add({ title: `Could not download ${filename}`, variant: 'error' })
      return
    }
    saveTextToFile(filename, text)
  }

  // ---- render ------------------------------------------------------------------------------

  // Outside a chat, ready means the content base's tree has loaded; within one, the chat's
  // content must be in too. File content loads per file, under the tree.
  const isReady = browserTree !== null && (!branchMode || clientReady)
  const loading = !isReady && !clientError && treeError === null

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

  if (treeError !== null && browserTree === null) {
    return (
      <div
        className="flex flex-col justify-center items-center gap-3 px-6 text-center"
        style={{ height }}
      >
        <p className="m-0 text-sm text-kumo-danger">
          Failed to load this {workpieceNoun}&apos;s code.
        </p>
        <WorkshopButton
          tone="secondary"
          className="!h-8"
          onClick={() => setTreeRetryToken(token => token + 1)}
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

  // The open file's text as displayed -- what the agent reads: the overlay's (preview, chat
  // content, or removed), else the content base's. Undefined while the base read is in flight.
  let activeResolved: FileAtCommit | undefined = { kind: 'absent' }
  if (activeFile !== null) {
    const overlaid = overlayText(activeFile)
    if (overlaid !== undefined) {
      activeResolved = overlaid !== null ? { kind: 'text', text: overlaid } : { kind: 'absent' }
    } else if (contentBase !== undefined) {
      activeResolved = activeBaseFiles.get(activeFile)
    }
  }
  const activeFileText = activeResolved?.kind === 'text' ? activeResolved.text : null
  // A base entry with no readable text (symlink, binary, oversized) shows its reason in place
  // of content, read-only; a readable file beyond the change size cap is viewable but not
  // editable, since no change could carry its new text.
  const activeFileUnreadable = activeResolved?.kind === 'unreadable'
    ? activeResolved.message : null
  const activeFileOversized = activeFileText !== null && activeFileText.length > MAX_FILE_TEXT_LENGTH
  // The diff's original side: the review base's text (null = absent there: an added file). The
  // diff waits for that read too, so a file never opens as "added" for the round trip before
  // its original arrives. An original with no readable text (a binary the chat replaced or
  // deleted) is stood in for by its explanation, so the diff reads as a change to an existing
  // file -- what the Changes list reports it as -- rather than as an addition or an empty
  // deletion.
  const activeReview = activeFile !== null ? reviewFiles.get(activeFile) : undefined
  const activeReviewLoading = isDiffMode && activeFile !== null && reviewBase !== undefined &&
    activeReview === undefined
  const activeFileOriginal = activeReview === undefined || activeReview.kind === 'absent'
    ? null
    : activeReview.kind === 'text'
      ? activeReview.text
      : `(${activeReview.message}; its previous content cannot be shown)`
  // Either of the open file's two reads failing is shown in its pane, with a retry.
  const activeFileError = (activeResolved === undefined ? activeBaseError : null) ??
    (activeReviewLoading ? reviewError : null)
  const activeFileDownloadable = activeFileText !== null
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
      <div className="relative flex min-h-0 flex-1">
        {fileDrawerOpen && (
          <button
            type="button"
            aria-label="Close files"
            onClick={() => setFileDrawerOpen(false)}
            className="absolute inset-0 z-20 bg-black/25 md:hidden"
          />
        )}
        <div
          ref={fileDrawerRef}
          role={compactLayout ? 'dialog' : undefined}
          aria-modal={compactLayout ? true : undefined}
          aria-label={compactLayout ? 'Files' : undefined}
          aria-hidden={compactLayout && !fileDrawerOpen ? true : undefined}
          inert={compactLayout && !fileDrawerOpen ? true : undefined}
          tabIndex={compactLayout ? -1 : undefined}
          className={`flex h-full shrink-0 outline-none max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-30 max-md:w-[min(85vw,320px)] max-md:shadow-xl max-md:transition-transform max-md:duration-200 ${
            fileDrawerOpen
              ? 'max-md:visible max-md:translate-x-0'
              : 'max-md:invisible max-md:-translate-x-full'
          }`}
        >
          <FileBrowser
            // Expansion state is per workpiece: a switch remounts the browser, which picks up
            // where that workpiece's tree was left (or its defaults, the first time).
            key={workpieceId}
            ref={fileBrowserRef}
            tree={browserTree ?? EMPTY_BROWSER_TREE}
            changes={changes}
            statuses={fileChangeStatuses}
            activeFile={activeFile}
            streamingActiveFile={streamingActiveFile}
            isDiffMode={isDiffMode}
            editLocked={isEditingLocked}
            workpieceNoun={workpieceNoun}
            initialExpanded={expandedDirsByWorkpieceRef.current.get(workpieceId)}
            onExpandedChange={expanded => expandedDirsByWorkpieceRef.current.set(workpieceId, expanded)}
            onFileSelect={(filename) => {
              handleFileSelect(filename)
              setFileDrawerOpen(false)
            }}
            onFileCreate={handleFileCreate}
            onFileDelete={handleFileDelete}
            onFileRename={handleFileRename}
            onFileDownload={handleFileDownload}
            onRequestClose={() => setFileDrawerOpen(false)}
            className="max-md:!w-full"
          />
        </div>
        <div
          className="flex flex-col bg-kumo-base"
          style={{ flex: 1, minWidth: 0 }}
          inert={compactLayout && fileDrawerOpen ? true : undefined}
          aria-hidden={compactLayout && fileDrawerOpen ? true : undefined}
        >
          <div className={`${activeFile ? 'flex' : 'flex md:hidden'} h-11 shrink-0 items-center justify-between gap-2 border-b border-kumo-line bg-kumo-base px-2 md:h-9 md:px-3`}>
            <WorkshopIconButton
              aria-label="Open files"
              title="Files"
              onClick={() => setFileDrawerOpen(true)}
              ref={fileDrawerTriggerRef}
              className="!h-9 !w-9 md:!hidden"
            >
              <List size={18} />
            </WorkshopIconButton>
            <div className="min-w-0 flex-1 truncate text-[13px] leading-4 text-kumo-subtle md:text-[12px]">
              {activeFile ? (
                <>{activeFileModeLabel} <span className="font-mono font-medium text-kumo-default">{activeFile}</span></>
              ) : 'Files'}
            </div>
            {summary.type === 'worktree' && (
              // The worktree's HEAD -- the agent's last explicit commit. Display only: what the
              // view shows as changed is relative to the accepted commit, never to this.
              <span
                className="flex shrink-0 items-center gap-1 rounded bg-kumo-tint px-1.5 py-0.5 font-mono text-[11px] leading-4 text-kumo-subtle"
                title={summary.headCommit === summary.baseCommit
                  ? `HEAD ${summary.headCommit} (no commits since the worktree was created)`
                  : `HEAD ${summary.headCommit}\nCreated at ${summary.baseCommit}`}
              >
                <GitBranch size={11} aria-hidden="true" />
                <span className="sr-only">HEAD </span>
                {summary.headCommit.slice(0, 7)}
              </span>
            )}
            {activeFile && (
              <WorkshopIconButton
                aria-label={`Download ${activeFile}`}
                title="Download file"
                onClick={() => handleFileDownload(activeFile)}
                disabled={!activeFileDownloadable}
                className="!h-9 !w-9 md:!h-6 md:!w-6"
              >
                <DownloadSimple size={14} weight="bold" />
              </WorkshopIconButton>
            )}
          </div>
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
                        onClick={() => fileBrowserRef.current?.openCreateModal()}
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
            ) : activeResolved === undefined || activeReviewLoading ? (
              activeFileError !== null ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-kumo-base px-6 text-center">
                  <p className="m-0 text-sm text-kumo-danger">Failed to load this file.</p>
                  <WorkshopButton
                    tone="secondary"
                    className="!h-8"
                    onClick={() => setFileRetryToken(token => token + 1)}
                  >
                    Try again
                  </WorkshopButton>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center bg-kumo-base text-kumo-subtle">
                  Loading file...
                </div>
              )
            ) : activeFileUnreadable !== null ? (
              <CodeEditor
                filename={activeFile}
                text={activeFileUnreadable}
                readOnly
                height="100%"
              />
            ) : isDiffMode ? (
              <CodeDiffEditor
                filename={activeFile}
                original={activeFileOriginal}
                text={activeFileText}
                session={activeSession}
                readOnly={isEditingLocked || activeFileOversized}
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
