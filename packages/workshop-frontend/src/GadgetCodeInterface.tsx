import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple, List } from '@phosphor-icons/react'
import { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import type { CodeChange, FileChange, TextChange } from '@gadgets/workshop-shared/code-change'
import { RpcStub } from 'capnweb'
import FileSidebar from './FileSidebar'
import type { FileChangeStatus, FileSidebarHandle } from './FileSidebar'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import CodeEditor, { type EditSession } from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'
import type {
  ChatCodeChanges, ChatLiveChangeRows, ChatLiveEditPreviews, EditPreviewEvent,
} from './ChatInterface'
import { ChatOtClient, type RemoteFileEvent } from './otClient'
import { reportIssue } from './errorReporting'
import { saveTextToFile } from './fileTransfers'
import { isTransientRpcError } from './rpcErrors'

// The code view over git-backed gadget code.
//
// Committed code is git commits; the gadget's head commit (`headCommitId`, from
// WorkpieceSummary.commitId) is fetched with Overseer.getCodeAtCommit() -- immutable, so cached
// by oid -- and is both the read-only view outside any chat and the "original" side of in-chat
// diffs. A chat's uncommitted changes are a revisioned stream of code changes (see ChatCodeBase in
// the API), tracked here by a per-chat ChatOtClient (see otClient.ts): the chat's content is
// its pins' base trees plus the epoch's recorded changes plus live rows, and the user's edits are
// composed locally and submitted through Overseer.submitCodeChange().
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

// ---- streaming edit previews (see ChatLiveEditPreviews) ---------------------------------------
//
// The agent's writeFile/editFile calls, overlaid on the displayed content as their text streams
// in. Display-only: none of it ever enters the OT client. Because tool calls execute only after
// the whole model response has streamed, previews outlive their streaming: each finished
// preview's final text stays displayed as a *pending* entry until the call's durable change row
// arrives (rows land in call order; see the interception in the client's onRemoteChange) or an
// editPreviewClear withdraws it. Same-file previews stack: a later call's span is located in the
// text of the finished preview beneath it, mirroring how the agent computes each edit against
// content that includes its earlier edits.

// The call whose content is currently streaming, attached to the display or not (attachment
// waits for the target's content to load; `text` is cumulative, so attaching can happen late).
type StreamingPreview = {
  toolCallId: string
  gadgetId: WorkpieceId
  path: string
  // editFile's replaced text; absent for writeFile (the streamed text replaces the whole file).
  textToReplace?: string
  // The streamed text received so far.
  text: string
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

export default function GadgetCodeInterface({
  overseer, workpieceId, headCommitId, height = '100%', selectedChatId = null, chatChanges,
  liveRows, liveEditPreviews, pendingGadgetIds, streamingActiveFile, isAgentActive,
  isVisible = true, onHasCodeChange,
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
  const fileListenersRef = useRef(new Map<string, Set<(change: FileChange) => void>>())

  // Streaming edit-preview state (see the module comment above PreviewOverlay): the call whose
  // content is streaming, its display overlay once attached, finished previews awaiting their
  // durable rows (per file, in call order), and the call whose preview could not attach (no
  // unique textToReplace match) and stays skipped. `retryPreviewAttachRef` is the attach
  // function, installed by the subscription effect (it closes over the OT client) so readiness
  // changes and the row interception can retry/re-anchor attachment.
  const streamingPreviewRef = useRef<StreamingPreview | null>(null)
  const activeOverlayRef = useRef<PreviewOverlay | null>(null)
  const pendingPreviewsRef = useRef(new Map<string, PendingPreview[]>())
  const skippedPreviewRef = useRef<string | null>(null)
  const retryPreviewAttachRef = useRef<(() => void) | null>(null)

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
      fetchCommitFiles: commitId => fetchCommitFiles(currentOverseerRef.current, commitId),
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
            const overlay = activeOverlayRef.current
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

    // The file's real (non-previewed) content source: the chat's content when it covers the
    // gadget, the committed head otherwise. `undefined` while still loading.
    const resolveRealFiles = (gadgetId: WorkpieceId): ReadonlyMap<string, string> | undefined => {
      if (!client.isReady()) return undefined
      if (client.hasGadget(gadgetId)) return client.getFiles(gadgetId)
      if (gadgetId === workpieceIdRef.current) return headFilesRef.current ?? undefined
      return undefined
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
        const files = resolveRealFiles(gadgetId)
        if (files === undefined) return
        text = files.get(path)
      }
      dispatchFileChange(gadgetId, path, text !== undefined ? { set: text } : { remove: true })
    }

    // Attach the streaming preview's overlay, if its base content is available. Idempotent and
    // late-callable (`text` is cumulative): retried on every delta, on readiness changes (the
    // client's first snapshot, the head tree arriving), and by the row interception's
    // re-anchoring.
    const tryAttach = () => {
      const streaming = streamingPreviewRef.current
      if (streaming === null || activeOverlayRef.current !== null) return
      if (skippedPreviewRef.current === streaming.toolCallId) return
      const chain = pendingPreviewsRef.current.get(fileKey(streaming.gadgetId, streaming.path))
      let fileText: string | undefined
      if (chain !== undefined && chain.length > 0) {
        // Stack on the finished preview beneath: the agent computed this edit against content
        // that includes that call's edit, whose row hasn't landed yet.
        fileText = chain[chain.length - 1].text
      } else {
        const files = resolveRealFiles(streaming.gadgetId)
        if (files === undefined) return // still loading; retried per the note above
        fileText = files.get(streaming.path)
      }
      let from: number
      let to: number
      if (streaming.textToReplace !== undefined) {
        const matchPos = fileText !== undefined ? fileText.indexOf(streaming.textToReplace) : -1
        if (matchPos < 0 || fileText!.indexOf(streaming.textToReplace, matchPos + 1) >= 0) {
          // No unique match: the tool call itself will fail the same test (or our copy has
          // diverged, and anchoring the preview would show it in the wrong place). No preview.
          skippedPreviewRef.current = streaming.toolCallId
          return
        }
        from = matchPos
        to = matchPos + streaming.textToReplace.length
      } else {
        from = 0
        to = fileText?.length ?? 0
      }
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
    // response has streamed.
    const finalizeStreaming = () => {
      streamingPreviewRef.current = null
      const overlay = activeOverlayRef.current
      if (overlay === null) return // never attached: nothing is displayed to keep
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
          if (affected.size > 0) {
            for (const key of affected) {
              const [gadgetId, path] = splitFileKey(key)
              const files = resolveRealFiles(gadgetId)
              if (files === undefined) continue
              const text = files.get(path)
              dispatchFileChange(gadgetId, path,
                text !== undefined ? { set: text } : { remove: true })
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
    }
  }, [client, liveEditPreviews, selectedChatId, dispatchFileChange, bumpContentVersion])

  // The client is ready once its first durable snapshot has been folded.
  const clientReady = branchMode && client !== null && chatChanges !== undefined &&
    chatChanges.chatId === selectedChatId && client.isReady()
  // Re-evaluated per content change; contentVersion is the (deliberate) extra dependency.
  void contentVersion

  // A preview that couldn't attach while its base content was unavailable retries when that
  // changes -- the client's first snapshot folds, the committed head's tree arrives, or the
  // selection switches to the previewed gadget (the head fallback in resolveRealFiles applies
  // only to the selected gadget, and headFiles alone doesn't signal such a switch: between two
  // headless gadgets it stays the same EMPTY_FILES instance). Without this, a short edit (whose
  // whole preview streams before the base is available) would deliver no further delta to retry
  // on and never appear.
  useEffect(() => {
    retryPreviewAttachRef.current?.()
  }, [clientReady, headFiles, workpieceId])

  // The chat's uncommitted files for the selected gadget, or undefined when the gadget is not
  // part of the chat's content (it then tracks mainline head live).
  const chatFiles = clientReady ? client!.getFiles(workpieceId) : undefined

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

  // What the view displays for the selected gadget: chat content when the chat owns it, the
  // committed head otherwise, with the edit previews overlaid on their target files. Null
  // while loading.
  const baseDisplayFiles: ReadonlyMap<string, string> | null =
    branchMode ? (chatFiles ?? headFiles) : headFiles
  let displayFiles = baseDisplayFiles
  if (previewOverrides.size > 0 && baseDisplayFiles !== null) {
    const overlaid = new Map(baseDisplayFiles)
    for (const [path, text] of previewOverrides) overlaid.set(path, text)
    displayFiles = overlaid
  }

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
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false)
  const [compactLayout, setCompactLayout] = useState(false)
  const fileSidebarRef = useRef<FileSidebarHandle | null>(null)
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

  // When the selected workpiece changes, the previous gadget's file selection and per-turn
  // state are meaningless; reset so the auto-select effect picks a file from the new gadget.
  const prevWorkpieceRef = useRef(workpieceId)
  useEffect(() => {
    if (prevWorkpieceRef.current === workpieceId) return
    prevWorkpieceRef.current = workpieceId
    setActiveFile(null)
    hasUserSwitchedFilesThisTurnRef.current = false
  }, [workpieceId])

  // Sorted list of files the view shows: the union of committed and chat files (plus the
  // previewed files, which may be mid-creation), so deletions remain visible (marked
  // "deleted") and additions appear.
  const previewedNamesSignature = [...previewOverrides.keys()].toSorted().join('\u0000')
  const displayedFiles = useMemo(() => {
    const names = new Set<string>(headFiles !== null ? headFiles.keys() : [])
    if (branchMode && chatFiles !== undefined) {
      for (const name of chatFiles.keys()) names.add(name)
    }
    if (previewedNamesSignature !== '') {
      for (const name of previewedNamesSignature.split('\u0000')) names.add(name)
    }
    return [...names].toSorted()
  }, [headFiles, chatFiles, branchMode, previewedNamesSignature])
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

  const applyLocalFileChanges = useCallback((changes: [string, FileChange][]) => {
    if (!ensureEditable() || client === null) return false
    const change: CodeChange = { [workpieceIdRef.current]: changes }
    client.applyLocalChange(change)
    // Local edits get no client notification (our own echo is silent -- see
    // ChatOtClientDelegate.onRemoteChange), so re-derive the file list and statuses here.
    bumpContentVersion()
    return true
  }, [client, ensureEditable, bumpContentVersion])

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
        // Fall back to the committed head only when the chat's content doesn't cover the
        // gadget at all (it then tracks head live). A gadget the chat owns but whose file is
        // absent is a *deleted* file: surface it as empty (the diff view's original side shows
        // the removed content), not as the head text masquerading as unchanged.
        const files = client.getFiles(gadgetId)
        return files !== undefined ? files.get(path) : headFilesRef.current?.get(path)
      },
      applyLocal: (change: FileChange, docText: string) => {
        try {
          if (!client.hasGadget(gadgetId)) {
            client.ensureGadgetEditable(
              gadgetId, headCommitIdRef.current, headFilesRef.current ?? EMPTY_FILES)
          }
          // Editing a file the chat's content no longer has (e.g. it was deleted in the chat
          // while its editor stayed open) re-creates it with the editor's text.
          const fileChange: FileChange = client.getFiles(gadgetId)?.has(path)
            ? change
            : { set: docText }
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
    if (applyLocalFileChanges([[filename, { set: '' }]])) {
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
    if (applyLocalFileChanges([[filename, { remove: true }]])) {
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
    if (applyLocalFileChanges([[oldName, { remove: true }], [newName, { set: text }]])) {
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
