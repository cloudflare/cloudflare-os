import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple } from '@phosphor-icons/react'
import { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { bindLiveDocClientId, seedClientIdForGadget, seedRootFromFiles }
  from '@gadgets/workshop-shared/yjs-seed'
import { RpcStub } from 'capnweb'
import * as Y from 'yjs'
import FileSidebar from './FileSidebar'
import type { FileChangeStatus, FileSidebarHandle } from './FileSidebar'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import CodeEditor from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'
import type { ChatCodeChanges, StreamingProposedChanges } from './ChatInterface'
import { deriveVerifiedPinSeed, pinSetSignature } from './chatCodeDoc'
import { reportIssue } from './errorReporting'
import { saveTextToFile } from './fileTransfers'
import { isTransientRpcError } from './rpcErrors'

// The code view over git-backed gadget code.
//
// Committed code is git commits; the gadget's head commit (`headCommitId`, from
// WorkpieceSummary.commitId) is fetched with Overseer.getCodeAtCommit() -- immutable, so cached
// by oid -- and is both the read-only view outside any chat and the "original" side of in-chat
// diffs. A chat's uncommitted changes are a Yjs doc the browser derives itself, per gadget and
// lazily (see ChatCodeBase in the API): a gadget joins the doc only when its code is first
// modified in the chat, pinned at a commit whose tree seeds the gadget's root (the deterministic
// `seedRootFromFiles` from @gadgets/workshop-shared/yjs-seed, verified against the pin's seed
// hash). The chat's current-epoch change updates (`chatChanges`), live drafts, and streaming
// agent edits apply on top, and the user's own edits are recorded as chat drafts via
// Overseer.updateCode(). Chats predating commit-seeded docs use the server-provided legacy base
// instead (ChatCodeBase.legacy / Overseer.getLegacyChatDocBase()).
//
// A gadget not pinned in the chat tracks mainline head live. To let the user start editing it
// without an extra round trip, the editable doc *eagerly* seeds the selected root from the head
// commit locally (never sent anywhere -- every side derives the identical bytes); the first
// actual edit then declares the pin on its updateCode() call (see LocalPin). If the server
// refuses an update -- the chat's generation moved under a merge/revert/draft-discard, or the
// pin declaration lost a race -- the queued local edits are discarded with a notice and the view
// rebuilds from server state, per ChatCodeBase.generation's contract.
//
// There is no standalone (out-of-chat) editing: gadget heads only advance when a chat's changes
// are accepted.

interface GadgetCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  // The selected workpiece's ID: the gadget whose files the editor shows, used for pin
  // declarations and the per-gadget seed clientID (see ChatCodeBase).
  workpieceId: WorkpieceId
  // Name of the Y.Doc root map holding the selected workpiece's files (see
  // WorkpieceSummary.filesRoot). Chat code docs span the whole workspace; this selects which
  // workpiece's files the editor shows.
  filesRoot: string
  // The selected workpiece's head commit (WorkpieceSummary.commitId). Absent while the gadget is
  // still pending in a chat (see WorkpieceSummary.commitId: every permanent gadget has a head),
  // which reads as an empty committed file set.
  headCommitId?: string
  height?: string | number
  selectedChatId?: number | null
  // The selected chat's code-branch snapshot (see ChatCodeChanges): its ChatCodeBase plus the
  // current epoch's recorded code changes, derived together. `undefined` until the chat's
  // metadata and history have loaded; the view stays in its loading state until it arrives.
  chatChanges?: ChatCodeChanges
  draftProposedChanges?: StreamingProposedChanges
  streamingProposedChanges?: StreamingProposedChanges
  // The file the agent is currently streaming edits into, if it is in this workpiece's root.
  streamingActiveFile?: string | null
  isAgentActive: boolean
  isVisible?: boolean
  onHasCodeChange?: (hasCode: boolean) => void
}

const EMPTY_FILES: ReadonlyMap<string, string> = new Map()

// Commit trees are immutable, so their file maps are cached by oid for the page's lifetime --
// across chat switches, workpiece switches, and component remounts. Failures are evicted so a
// later attempt retries.
const commitFilesCache = new Map<string, Promise<ReadonlyMap<string, string>>>()

function fetchCommitFiles(
  overseer: RpcStub<Overseer>, commitId: string,
): Promise<ReadonlyMap<string, string>> {
  let cached = commitFilesCache.get(commitId)
  if (!cached) {
    cached = overseer.getCodeAtCommit(commitId).then(({ files }) => {
      const map = new Map<string, string>()
      for (const [name, content] of Object.entries(files)) {
        map.set(name, content)
      }
      return map as ReadonlyMap<string, string>
    })
    cached.catch(() => commitFilesCache.delete(commitId))
    commitFilesCache.set(commitId, cached)
  }
  return cached
}

// A pin this client holds locally, ahead of the chat's own codeBase. Two kinds share the shape:
//
// - An *eager* seed (declared: false): the selected root is not pinned in the chat, so its head
//   commit's seed is applied to the editable doc purely locally, letting the user start typing
//   against real content. It is never sent anywhere and is rederived at the current head
//   whenever mainline advances (an unpinned gadget tracks head live).
// - A *declared* pin (declared: true): the first local edit converted the eager seed into a pin
//   declaration riding its updateCode() call. The entry carries the seed until the pin is
//   echoed back in the chat's codeBase, whose fetched seed is byte-identical by construction.
//
// Entries always belong to the selected chat; the map is cleared on chat switch, generation
// change, and local-edit discard.
type LocalPin = {
  filesRoot: string
  baseCommit: string
  seed: Uint8Array
  declared: boolean
}

function didFileChange(originalMap: Y.Map<Y.Text>, previewMap: Y.Map<Y.Text>, filename: string) {
  const original = originalMap.get(filename)
  const preview = previewMap.get(filename)
  if (!original || !preview) return original !== preview
  return original.toString() !== preview.toString()
}

function computeChangedFiles(originalMap: Y.Map<Y.Text>, previewMap: Y.Map<Y.Text>) {
  const changed = new Set<string>()
  const allFiles = new Set([
    ...Array.from(originalMap.keys()),
    ...Array.from(previewMap.keys()),
  ])

  for (const filename of allFiles) {
    if (didFileChange(originalMap, previewMap, filename)) {
      changed.add(filename)
    }
  }

  return changed
}

function areSetsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function areArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function getTouchedFilesFromEvents(events: Y.YEvent<any>[], rootMap: Y.Map<Y.Text>) {
  const filenames = new Set<string>()

  for (const event of events) {
    if (event.target === rootMap && 'keysChanged' in event) {
      for (const key of (event as Y.YMapEvent<Y.Text>).keysChanged) {
        if (typeof key === 'string') {
          filenames.add(key)
        }
      }
      continue
    }

    const filename = event.path[0]
    if (typeof filename === 'string') {
      filenames.add(filename)
    }
  }

  return filenames
}

type QueuedCodeUpdate = {
  chatId: number
  update: Uint8Array
  // The ChatCodeBase.generation the editable doc that produced this update was built against
  // (see Overseer.updateCode()).
  generation: number
  // Pin declaration riding this update: present on the first edit to a gadget not yet pinned in
  // the chat (see LocalPin).
  pin?: { gadgetId: WorkpieceId, baseCommit: string }
}

export default function GadgetCodeInterface({ overseer, workpieceId, filesRoot, headCommitId, height = '100%', selectedChatId = null, chatChanges, draftProposedChanges, streamingProposedChanges, streamingActiveFile, isAgentActive, isVisible = true, onHasCodeChange }: GadgetCodeInterfaceProps) {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const branchMode = selectedChatId !== null

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

  // A local Y.Doc holding the committed files, purely as display state: the read-only view
  // outside any chat and the "original" side of in-chat diffs. Never synced anywhere, so its
  // (random) identity doesn't matter; rebuilt whenever the head or the selected root changes.
  const headDoc = useMemo(() => {
    const doc = new Y.Doc()
    if (headFiles !== null && headFiles.size > 0) {
      const map = doc.getMap<Y.Text>(filesRoot)
      doc.transact(() => {
        for (const [name, content] of headFiles) {
          map.set(name, new Y.Text(content))
        }
      })
    }
    return doc
  }, [headFiles, filesRoot])
  const headFilesMapRef = useRef<Y.Map<Y.Text>>(headDoc.getMap(filesRoot))
  headFilesMapRef.current = headDoc.getMap(filesRoot)

  // The chat's code base for its current epoch, from the snapshot delivered with the changes
  // (see ChatCodeChanges). An absent codeBase reads as `{gadgets: [], generation: 0}` (see
  // ChatCodeBase).
  const codeBase = chatChanges?.codeBase
  const generation = codeBase?.generation ?? 0
  const isLegacyChat = codeBase?.legacy === true
  const metaPins = codeBase?.gadgets

  // The chat doc's base updates: the deterministic per-pin seeds derived from the pins'
  // commits, or (for a legacy chat) the server-provided whole-doc legacy base. Keyed by the
  // pin-set signature, so a pin arriving -- or the whole set resetting at an epoch boundary --
  // rederives it; while a rederivation is in flight the docs built from the previous base stay
  // up rather than flashing a loading state. `chatBaseError` marks a failed derivation (most
  // seriously a per-pin seed-hash mismatch); the view renders an error state rather than an
  // editable doc that would diverge.
  const [chatBase, setChatBase] =
    useState<{ chatId: number, key: string, updates: Uint8Array[] } | null>(null)
  const [chatBaseError, setChatBaseError] = useState(false)
  const chatChangesRef = useRef(chatChanges)
  chatChangesRef.current = chatChanges
  const chatDocKnown = chatChanges !== undefined
  const baseKey = isLegacyChat ? 'legacy' : pinSetSignature(metaPins ?? [])
  useEffect(() => {
    setChatBaseError(false)
    if (selectedChatId === null || !chatDocKnown) {
      setChatBase(null)
      return
    }
    let cancelled = false
    ;(async () => {
      let updates: Uint8Array[]
      if (isLegacyChat) {
        updates = [await overseer.getLegacyChatDocBase(selectedChatId)]
      } else {
        // The seed is a pure function of the seedCommit-bearing pins, whose signature is the
        // `baseKey` dependency; the pins themselves are read through the ref.
        const pins = (chatChangesRef.current?.codeBase?.gadgets ?? [])
          .filter(pin => pin.seedCommit !== undefined)
        updates = await Promise.all(pins.map(async pin =>
          deriveVerifiedPinSeed(pin, await fetchCommitFiles(overseer, pin.seedCommit!))))
      }
      if (!cancelled) setChatBase({ chatId: selectedChatId, key: baseKey, updates })
    })().catch(err => {
      if (cancelled) return
      console.error('Failed to build the chat code doc base:', err)
      reportIssue('code-view.chat-base', err, { handled: true })
      setChatBaseError(true)
    })
    return () => { cancelled = true }
  }, [selectedChatId, chatDocKnown, isLegacyChat, baseKey, overseer])
  // The base usable for building docs right now: possibly a stale pin set for the same chat
  // (rederived momentarily), never another chat's.
  const usableChatBase =
    chatBase !== null && chatBase.chatId === selectedChatId ? chatBase : null

  // Updates originating locally are enqueued to this array.
  const updateQueueRef = useRef<QueuedCodeUpdate[]>([]);

  // Track whether we're currently sending updates to prevent concurrent sends
  const isSendingRef = useRef<boolean>(false)

  // Pins this client holds locally (see LocalPin), keyed by gadget.
  const localPinsRef = useRef(new Map<WorkpieceId, LocalPin>())

  // React state for UI
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const fileSidebarRef = useRef<FileSidebarHandle | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [, setEditableDocVersion] = useState(0)

  // Bumped whenever queued local edits are discarded outside the branch-docs effect (a rejected
  // updateCode() call), forcing the editable doc to rebuild without them.
  const [localDiscardToken, setLocalDiscardToken] = useState(0)

  // Discard the chat's queued (not yet acknowledged) local edits and local pins: a merge,
  // revert, or draft discard invalidated the doc they were made in, or the server refused them
  // outright (see ChatCodeBase.generation). The notice is shown only when keystrokes were
  // actually lost.
  const discardQueuedEdits = useCallback((chatId: number) => {
    const hadQueued = updateQueueRef.current.some(entry => entry.chatId === chatId)
    updateQueueRef.current = updateQueueRef.current.filter(entry => entry.chatId !== chatId)
    // Local pins only ever belong to the selected chat; a rejected send for a chat the user has
    // since left must not clear the current one's.
    if (chatId === selectedChatIdRef.current) {
      localPinsRef.current.clear()
    }
    setHasUnsavedChanges(false)
    if (hadQueued) {
      toastsRef.current.add({
        title: "Your latest code edits were discarded — this conversation's changes were " +
          'merged, reverted, or changed by someone else at the same time.',
        variant: 'warning',
      })
    }
    setLocalDiscardToken(token => token + 1)
  }, [])

  // Sorted committed file list (the base layer of the sidebar; in-chat additions arrive through
  // previewFileNames below).
  const fileNames = useMemo(
    () => headFiles !== null ? Array.from(headFiles.keys()).toSorted() : [],
    [headFiles])

  // Branch and preview docs layered on top of the chat doc base.
  const durableBranchYdocRef = useRef<Y.Doc | null>(null)
  const editableYdocRef = useRef<Y.Doc | null>(null)
  const editableFilesMapRef = useRef<Y.Map<Y.Text> | null>(null)
  const streamingYdocRef = useRef<Y.Doc | null>(null)
  const streamingFilesMapRef = useRef<Y.Map<Y.Text> | null>(null)
  const editableDraftCursorRef = useRef(0)
  const editableDraftUpdatesRef = useRef<Uint8Array[] | undefined>(undefined)
  const editableBaseChangesRef = useRef<Uint8Array | undefined>(undefined)
  // The seed set the editable doc's roots were built from: the fetched base's pin signature
  // unioned with the local pins' (see the branch-docs effect). Comparing signatures rather than
  // update identities keeps the editable doc alive across rederivations that don't change its
  // content -- above all the metadata echo of a pin this client itself declared, which lands
  // exactly when the user has just started typing.
  const editableDocBaseSigRef = useRef<string | null>(null)
  const editableGenerationRef = useRef(0)
  const editableDiscardTokenRef = useRef(0)
  const editableChatIdRef = useRef<number | null>(null)
  // The files root the editable/streaming docs' map refs were derived from; a root switch forces
  // a rebuild so the refs point into the newly-selected workpiece's map.
  const editableRootRef = useRef<string | null>(null)
  const streamingRootRef = useRef<string | null>(null)
  const selectedChatIdRef = useRef<number | null>(selectedChatId)
  selectedChatIdRef.current = selectedChatId
  const workpieceIdRef = useRef(workpieceId)
  workpieceIdRef.current = workpieceId
  const previewObserverCleanupRef = useRef<(() => void) | null>(null)
  const editableObserverCleanupRef = useRef<(() => void) | null>(null)
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())
  // Sorted list of file names present in the currently-observed preview map (streaming preview or
  // editable branch doc). Tracked as state so the file sidebar updates when files are added/removed
  // mid-turn — the preview map is a mutable ref whose identity doesn't change on incremental edits.
  const [previewFileNames, setPreviewFileNames] = useState<string[]>([])
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

  // Keep a ref to the current overseer so operations always use the latest stub
  const currentOverseerRef = useRef(overseer)
  currentOverseerRef.current = overseer

  // Keep a ref to the current sender so editable-doc listeners don't need to
  // re-register just because the component rendered again.
  const sendUpdateToServerRef = useRef<(update: Uint8Array, chatId: number) => Promise<void>>(async () => {})

  // When the selected workpiece changes, the previous root's file selection and per-turn state
  // are meaningless; reset so the auto-select effect picks a file from the new root.
  const prevFilesRootRef = useRef(filesRoot)
  useEffect(() => {
    if (prevFilesRootRef.current === filesRoot) return
    prevFilesRootRef.current = filesRoot
    setActiveFile(null)
    hasUserSwitchedFilesThisTurnRef.current = false
  }, [filesRoot])

  // Auto-select first file when files appear and nothing is selected.
  useEffect(() => {
    if (activeFile !== null) return

    const previewMap = streamingFilesMapRef.current ?? editableFilesMapRef.current
    const displayed = previewMap
      ? Array.from(new Set([...fileNames, ...previewFileNames])).toSorted()
      : fileNames

    if (displayed.length > 0) {
      setActiveFile(displayed[0])
    }
  }, [fileNames, activeFile, previewFileNames])

  // Avoid reporting an empty state before the committed files have loaded.
  const onHasCodeChangeRef = useRef(onHasCodeChange)
  onHasCodeChangeRef.current = onHasCodeChange
  useEffect(() => {
    if (headFiles !== null) {
      onHasCodeChangeRef.current?.(headFiles.size > 0)
    }
  }, [headFiles])

  // Select the file currently being edited by the agent, unless the user has
  // manually switched files during this turn.
  useEffect(() => {
    const previewMap = streamingFilesMapRef.current ?? editableFilesMapRef.current
    if (streamingActiveFile) lastStreamingActiveFileRef.current = streamingActiveFile
    let target = streamingActiveFile ?? lastStreamingActiveFileRef.current
    if (hasUserSwitchedFilesThisTurnRef.current || !target) {
      return
    }

    if (headFilesMapRef.current.has(target) || previewMap?.has(target)) {
      setActiveFile(target)
    }
  }, [isAgentActive, previewFileNames, selectedChatId, streamingActiveFile])

  const replaceChangedFiles = useCallback((previewMap: Y.Map<Y.Text> | null) => {
    setChangedFiles(prev => {
      const next = previewMap ? computeChangedFiles(headFilesMapRef.current, previewMap) : new Set<string>()
      return areSetsEqual(prev, next) ? prev : next
    })
  }, [])

  const updateChangedFilesForNames = useCallback((previewMap: Y.Map<Y.Text> | null, filenames: Iterable<string>) => {
    setChangedFiles(prev => {
      if (!previewMap) {
        return prev.size === 0 ? prev : new Set<string>()
      }

      let next = prev
      for (const filename of filenames) {
        const changed = didFileChange(headFilesMapRef.current, previewMap, filename)
        const alreadyChanged = next.has(filename)
        if (changed === alreadyChanged) continue

        if (next === prev) {
          next = new Set(prev)
        }

        if (changed) {
          next.add(filename)
        } else {
          next.delete(filename)
        }
      }

      return next
    })
  }, [])

  // Sync the reactive previewFileNames state from a preview map's current keys, so the file
  // sidebar reflects files added/removed in the (mutable) preview map.
  const syncPreviewFileNames = useCallback((previewMap: Y.Map<Y.Text> | null) => {
    setPreviewFileNames(prev => {
      const next = previewMap ? Array.from(previewMap.keys()).toSorted() : []
      return areArraysEqual(prev, next) ? prev : next
    })
  }, [])

  const observePreviewMap = useCallback((previewMap: Y.Map<Y.Text> | null) => {
    previewObserverCleanupRef.current?.()
    previewObserverCleanupRef.current = null

    syncPreviewFileNames(previewMap)

    if (!previewMap) {
      return
    }

    const observer = (events: Y.YEvent<any>[]) => {
      const touchedFiles = getTouchedFilesFromEvents(events, previewMap)
      if (touchedFiles.size > 0) {
        updateChangedFilesForNames(previewMap, touchedFiles)
      }
      // The map's key set may have changed (file added/removed); keep the sidebar in sync.
      syncPreviewFileNames(previewMap)
    }

    previewMap.observeDeep(observer)
    previewObserverCleanupRef.current = () => {
      previewMap.unobserveDeep(observer)
    }
  }, [updateChangedFilesForNames, syncPreviewFileNames])

  const observeEditableDoc = useCallback((ydoc: Y.Doc | null) => {
    editableObserverCleanupRef.current?.()
    editableObserverCleanupRef.current = null

    if (!ydoc) {
      return
    }

    const updateHandler = async (update: Uint8Array, origin: any) => {
      const currentSelectedChatId = selectedChatIdRef.current
      if (origin === 'server' || currentSelectedChatId === null) {
        return
      }

      await sendUpdateToServerRef.current(update, currentSelectedChatId)
    }

    ydoc.on('updateV2', updateHandler)
    editableObserverCleanupRef.current = () => {
      ydoc.off('updateV2', updateHandler)
    }
  }, [])

  useEffect(() => {
    return () => {
      previewObserverCleanupRef.current?.()
      previewObserverCleanupRef.current = null
      editableObserverCleanupRef.current?.()
      editableObserverCleanupRef.current = null
    }
  }, [])

  // The committed head is immutable per doc (headDoc is rebuilt when the head advances), so the
  // "original side changed" signal is simply a new headDoc: recompute the changed-files set
  // against whichever preview map is showing.
  useEffect(() => {
    const previewMap = streamingFilesMapRef.current ?? editableFilesMapRef.current
    if (previewMap) {
      replaceChangedFiles(previewMap)
    }
  }, [headDoc, replaceChangedFiles])

  // Build the durable branch doc and editable draft doc whenever the selected chat or
  // server-backed branch state changes. The durable doc is the chat's server-recorded state --
  // the current epoch's base (per-pin seeds or the legacy base) plus its recorded change
  // updates -- and the editable doc layers local pins, drafts, and not-yet-acknowledged local
  // edits on top.
  useEffect(() => {
    if (!branchMode || chatChanges === undefined || usableChatBase === null) {
      // Not in a chat, or the chat's base/history hasn't loaded yet (the view shows its loading
      // state until both have).
      observeEditableDoc(null)
      durableBranchYdocRef.current = null
      editableYdocRef.current = null
      editableFilesMapRef.current = null
      editableDraftCursorRef.current = 0
      editableDraftUpdatesRef.current = undefined
      editableBaseChangesRef.current = undefined
      editableDocBaseSigRef.current = null
      editableChatIdRef.current = null
      localPinsRef.current.clear()
      if (!streamingYdocRef.current) {
        observePreviewMap(null)
        replaceChangedFiles(null)
      }
      return
    }

    if (usableChatBase.key !== baseKey) {
      // The pin set changed and its seeds are being rederived; keep showing the docs built from
      // the previous base rather than tearing down. (Change updates that arrive ahead of a new
      // pin's seed park as Yjs pending structs until a rebuild applies it.)
      //
      // This deliberately returns before the generation check below, leaving a stale doc
      // editable for the rederivation's duration. That is safe: edits made now are enqueued
      // with the doc's own (stale) generation -- editableGenerationRef only advances at
      // rebuild -- so the server rejects them and discardQueuedEdits handles the cleanup, the
      // same backstop that covers keystrokes already in flight when a merge or revert lands
      // (no client-side ordering can close that race). The window is also inherently short
      // where it matters: a generation bump only ever *shrinks* the pin set, so its seeds
      // rederive from the already-populated commit-files cache with no network fetch. The
      // rederivations that do fetch (a collaborator's new pin, the echo of this client's own
      // first-keystroke pin) leave the generation unchanged, and the current doc stays valid
      // for editing throughout (pin additions don't invalidate docs -- see
      // ChatCodeBase.generation). Running the generation discard from here instead would spin:
      // it bumps localDiscardToken, which reruns this effect, which would land right back here
      // until the new base arrives.
      return
    }

    if (editableYdocRef.current && editableChatIdRef.current === selectedChatId &&
        editableGenerationRef.current !== generation) {
      // A merge, revert, or draft discard invalidated every doc built on the previous
      // generation (see ChatCodeBase.generation): queued keystrokes are rooted in erased
      // history (or already swept into the merge), so they are discarded rather than submitted.
      discardQueuedEdits(selectedChatId)
    }

    const durableDoc = new Y.Doc()
    for (const update of usableChatBase.updates) {
      Y.applyUpdateV2(durableDoc, update, 'server')
    }
    if (chatChanges.update) {
      Y.applyUpdateV2(durableDoc, chatChanges.update, 'server')
    }
    durableBranchYdocRef.current = durableDoc

    // The local pins the editable doc should carry (see LocalPin): declared pins not yet echoed
    // in the chat's codeBase, plus -- when the selected root is unpinned everywhere -- an eager
    // seed of its head. The union of the fetched base's pins and these is the editable doc's
    // seed-set signature; a rebuild is needed exactly when it (or any other layer) changes.
    const carriedLocalPins = [...localPinsRef.current].filter(([gadgetId, pin]) =>
      pin.declared &&
      !metaPins?.some(p => p.gadgetId === gadgetId && p.seedCommit !== undefined))
    const selectedRootPinned =
      metaPins?.some(pin => pin.gadgetId === workpieceId && pin.seedCommit !== undefined) ||
      carriedLocalPins.some(([gadgetId]) => gadgetId === workpieceId)
    const eagerBaseCommit = !isLegacyChat && !selectedRootPinned &&
        headCommitId !== undefined && headFiles !== null ? headCommitId : undefined
    const sigParts = new Set<string>(
      usableChatBase.key === '' ? [] : usableChatBase.key.split(','))
    for (const [gadgetId, pin] of carriedLocalPins) {
      sigParts.add(`${gadgetId}:${pin.baseCommit}`)
    }
    if (eagerBaseCommit !== undefined) {
      sigParts.add(`${workpieceId}:${eagerBaseCommit}`)
    }
    const docBaseSig = [...sigParts].toSorted().join(',')

    const draftUpdates = draftProposedChanges?.updates ?? []
    const draftUpdateCount = draftProposedChanges?.count ?? 0
    const shouldRebuildEditable = !editableYdocRef.current
      || editableChatIdRef.current !== selectedChatId
      || editableRootRef.current !== filesRoot
      || editableDocBaseSigRef.current !== docBaseSig
      || editableBaseChangesRef.current !== chatChanges.update
      || editableGenerationRef.current !== generation
      || editableDiscardTokenRef.current !== localDiscardToken
      || editableDraftCursorRef.current > draftUpdateCount

    if (shouldRebuildEditable) {
      // Materialize the local-pin set the signature was computed from, reusing a still-valid
      // eager entry (same head) and rederiving otherwise -- an unpinned root tracks head live.
      const nextLocalPins = new Map(carriedLocalPins)
      if (eagerBaseCommit !== undefined) {
        const existing = localPinsRef.current.get(workpieceId)
        nextLocalPins.set(workpieceId,
          existing !== undefined && !existing.declared &&
              existing.baseCommit === eagerBaseCommit && existing.filesRoot === filesRoot
            ? existing
            : {
                filesRoot,
                baseCommit: eagerBaseCommit,
                seed: seedRootFromFiles(
                  filesRoot, headFiles!, seedClientIdForGadget(workpieceId)),
                declared: false,
              })
      }
      localPinsRef.current = nextLocalPins

      const editableDoc = new Y.Doc()
      // The editable doc authors chat updates, so its clientID must stay outside the reserved
      // seed band for its whole lifetime (see yjs-seed in workshop-shared).
      bindLiveDocClientId(editableDoc)
      Y.applyUpdateV2(editableDoc, Y.encodeStateAsUpdateV2(durableDoc))
      for (const pin of localPinsRef.current.values()) {
        // Seeds are only ever *applied* as remote updates, never authored in place (see
        // seedRootFromFiles). This runs before the update observer attaches, so nothing here is
        // ever sent to the server.
        Y.applyUpdateV2(editableDoc, pin.seed)
      }
      for (const update of draftUpdates) {
        Y.applyUpdateV2(editableDoc, update, 'server')
      }
      for (const queued of updateQueueRef.current) {
        if (queued.chatId === selectedChatId) {
          Y.applyUpdateV2(editableDoc, queued.update)
        }
      }

      editableYdocRef.current = editableDoc
      editableFilesMapRef.current = editableDoc.getMap<Y.Text>(filesRoot)
      observeEditableDoc(editableDoc)
      editableDraftCursorRef.current = draftUpdateCount
      editableDraftUpdatesRef.current = draftUpdates
      editableBaseChangesRef.current = chatChanges.update
      editableDocBaseSigRef.current = docBaseSig
      editableGenerationRef.current = generation
      editableDiscardTokenRef.current = localDiscardToken
      editableChatIdRef.current = selectedChatId
      editableRootRef.current = filesRoot
      setEditableDocVersion((prev) => prev + 1)

      if (!streamingYdocRef.current) {
        observePreviewMap(editableFilesMapRef.current)
        replaceChangedFiles(editableFilesMapRef.current)
      }
      return
    }

    if (editableYdocRef.current && editableDraftCursorRef.current < draftUpdateCount) {
      for (let i = editableDraftCursorRef.current; i < draftUpdateCount; i++) {
        Y.applyUpdateV2(editableYdocRef.current, draftUpdates[i], 'server')
      }
      editableDraftCursorRef.current = draftUpdateCount
      editableDraftUpdatesRef.current = draftUpdates
    }
  }, [
    branchMode,
    baseKey,
    chatChanges,
    discardQueuedEdits,
    draftProposedChanges?.count,
    draftProposedChanges?.updates,
    filesRoot,
    generation,
    headCommitId,
    headFiles,
    isLegacyChat,
    localDiscardToken,
    metaPins,
    observePreviewMap,
    observeEditableDoc,
    replaceChangedFiles,
    selectedChatId,
    usableChatBase,
    workpieceId,
  ])

  // Incrementally apply streaming updates to a persistent streaming Y.Doc.
  // Only new updates (beyond the cursor) are applied each frame.
  const streamingCursorRef = useRef(0)
  const streamingBaseChangesRef = useRef<Uint8Array | undefined>(undefined)
  const streamingUpdatesRef = useRef<Uint8Array[] | undefined>(undefined)
  const streamingBaseDocRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    const streamingUpdates = streamingProposedChanges?.updates
    const streamingUpdateCount = streamingProposedChanges?.count ?? 0

    if (!streamingUpdates || streamingUpdateCount === 0) {
      streamingYdocRef.current = null
      streamingFilesMapRef.current = null
      streamingCursorRef.current = 0
      streamingBaseChangesRef.current = undefined
      streamingUpdatesRef.current = undefined
      streamingBaseDocRef.current = null
      observePreviewMap(branchMode ? editableFilesMapRef.current : null)
      replaceChangedFiles(branchMode ? editableFilesMapRef.current : null)
      return
    }

    // Streaming edits only ever happen within a chat; until the chat's durable doc is built,
    // there is nothing to layer them on (the view shows its loading state anyway).
    const baseDoc = durableBranchYdocRef.current
    if (!baseDoc) {
      return
    }

    let rebuiltStreamingDoc = false

    // Rebuild streaming doc if not yet initialized, if the durable base changed, if the selected
    // workpiece root changed, or if the stream history was replaced (chat switch or codeReset).
    if (!streamingYdocRef.current
        || streamingBaseChangesRef.current !== chatChanges?.update
        || streamingBaseDocRef.current !== baseDoc
        || streamingRootRef.current !== filesRoot
        || streamingUpdatesRef.current !== streamingUpdates
        || streamingCursorRef.current > streamingUpdateCount) {
      const streamingDoc = new Y.Doc()
      Y.applyUpdateV2(streamingDoc, Y.encodeStateAsUpdateV2(baseDoc))
      streamingYdocRef.current = streamingDoc
      streamingFilesMapRef.current = streamingDoc.getMap<Y.Text>(filesRoot)
      streamingBaseChangesRef.current = chatChanges?.update
      streamingUpdatesRef.current = streamingUpdates
      streamingBaseDocRef.current = baseDoc
      streamingRootRef.current = filesRoot
      streamingCursorRef.current = 0
      rebuiltStreamingDoc = true
    }

    // Apply only the new incremental updates.
    for (let i = streamingCursorRef.current; i < streamingUpdateCount; i++) {
      Y.applyUpdateV2(streamingYdocRef.current!, streamingUpdates[i])
    }
    streamingCursorRef.current = streamingUpdateCount
    if (rebuiltStreamingDoc) {
      observePreviewMap(streamingFilesMapRef.current)
      replaceChangedFiles(streamingFilesMapRef.current)
    }
  }, [branchMode, chatChanges?.update, filesRoot, observePreviewMap, replaceChangedFiles, selectedChatId, streamingProposedChanges?.count, streamingProposedChanges?.updates])

  // Helper to send updates to server based on what it's missing
  // Uses a loop to ensure all changes get sent, with only one send in flight at a time
  const sendUpdateToServer = async (update: Uint8Array, chatId: number) => {
    // The first local edit to a not-yet-pinned gadget converts its eager seed into a pin
    // declaration riding this update (see LocalPin). Local edits only ever touch the selected
    // workpiece's root -- the editor and sidebar expose nothing else.
    let pin: QueuedCodeUpdate['pin']
    const localPin = localPinsRef.current.get(workpieceIdRef.current)
    if (localPin !== undefined && !localPin.declared) {
      localPin.declared = true
      pin = { gadgetId: workpieceIdRef.current, baseCommit: localPin.baseCommit }
    }
    updateQueueRef.current.push({
      chatId, update, generation: editableGenerationRef.current,
      ...(pin !== undefined ? { pin } : {}),
    });

    // If already sending, return early - the running instance will pick up our changes
    if (isSendingRef.current) {
      return
    }

    isSendingRef.current = true

    try {
      // Loop until there's nothing left to send
      while (updateQueueRef.current.length > 0) {
        const queue = updateQueueRef.current
        const head = queue[0]
        // Batch consecutive updates rooted in the same base. One updateCode() call carries at
        // most one pin declaration, so an entry declaring its own pin starts a new batch.
        const batch = [head]
        for (let i = 1; i < queue.length; i++) {
          const entry = queue[i]
          if (entry.chatId !== head.chatId || entry.generation !== head.generation ||
              entry.pin !== undefined) {
            break
          }
          batch.push(entry)
        }

        const outgoingUpdate = batch.length === 1
          ? head.update
          : Y.mergeUpdatesV2(batch.map((entry) => entry.update))

        try {
          await currentOverseerRef.current.updateCode(outgoingUpdate, head.chatId, {
            generation: head.generation,
            ...(head.pin !== undefined ? { pin: head.pin } : {}),
          })
          // Successfully sent - clear unsaved changes indicator
          setHasUnsavedChanges(false)
        } catch (error) {
          if (isTransientRpcError(error)) {
            // Connection trouble: keep the queue (the next local edit or reconnect retries) and
            // stop trying for now to avoid hammering the server.
            console.debug('Failed to send code update to server:', error)
            setHasUnsavedChanges(true)
            break
          }
          // The server refused the update outright: the chat's generation moved under a merge,
          // revert, or draft discard, or the pin declaration lost a race (see
          // Overseer.updateCode()). The doc these keystrokes were made in no longer matches the
          // chat, so discard them and rebuild from server state.
          console.error('Code update rejected; discarding local edits:', error)
          reportIssue('code-view.update-rejected', error, { handled: true })
          discardQueuedEdits(head.chatId)
          continue
        }

        // Discard exactly the entries we sent -- a concurrent discard may have replaced the
        // queue in the meantime.
        const sent = new Set<QueuedCodeUpdate>(batch)
        updateQueueRef.current = updateQueueRef.current.filter(entry => !sent.has(entry))

        // More updates may have been queued in the meantime. Loop to handle them.

        // TODO: Consider putting a small delay here to coalesce more continuous keystrokes?
      }
    } finally {
      isSendingRef.current = false
    }
  }
  sendUpdateToServerRef.current = sendUpdateToServer

  // Handle file selection
  const handleFileSelect = (filename: string) => {
    if (activeFile !== filename) {
      hasUserSwitchedFilesThisTurnRef.current = true
    }
    setActiveFile(filename)
  }

  // Handle file creation. All editing happens within a chat: outside one (or while an agent is
  // streaming) the sidebar's mutating affordances are locked, so these handlers only ever act on
  // the editable branch doc.
  const handleFileCreate = (filename: string) => {
    const filesMap = branchMode ? editableFilesMapRef.current : null
    if (!filesMap) {
      return
    }

    // Check if file already exists
    if (filesMap.has(filename)) {
      toasts.add({ title: `File already exists: ${filename}`, variant: 'error' })
      return
    }

    // Create new Y.Text for the file
    filesMap.set(filename, new Y.Text())
    setActiveFile(filename)
    toasts.add({ title: `Created file: ${filename}`, variant: 'success' })
  }

  // Handle file deletion
  const handleFileDelete = (filename: string) => {
    const filesMap = branchMode ? editableFilesMapRef.current : null
    if (!filesMap) {
      return
    }

    if (!filesMap.has(filename)) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }

    // Delete from Y.Map
    filesMap.delete(filename)

    // Switch to another file if the deleted file was active
    if (activeFile === filename) {
      const remainingFiles = Array.from(filesMap.keys()).toSorted()
      setActiveFile(remainingFiles.length > 0 ? remainingFiles[0] : null)
    }

    toasts.add({ title: `Deleted file: ${filename}`, variant: 'success' })
  }

  // Handle file renaming
  const handleFileRename = (oldName: string, newName: string) => {
    const filesMap = branchMode ? editableFilesMapRef.current : null
    if (!filesMap) {
      return
    }

    // Check if old file exists
    const ytext = filesMap.get(oldName)
    if (!ytext) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }

    // Check if new name already exists
    if (filesMap.has(newName)) {
      toasts.add({ title: `File already exists: ${newName}`, variant: 'error' })
      return
    }

    // Set new file with the same Y.Text instance
    // We have to clone the Y.Text. We can't reuse the same object in a new location, sadly.
    filesMap.set(newName, ytext.clone())
    // Delete old file
    filesMap.delete(oldName)

    // Update active file if it was the renamed file
    if (activeFile === oldName) {
      setActiveFile(newName)
    }

    toasts.add({ title: `Renamed file: ${oldName} \u2192 ${newName}`, variant: 'success' })
  }

  // Get the Y.Text for the active file (committed version -- the read-only view outside chats
  // and the "original" side of in-chat diffs)
  const activeFileYText = activeFile ? headFilesMapRef.current.get(activeFile) || null : null
  // Editing is locked outside a chat (committed code only changes through a chat's accept) and
  // while an agent is streaming edits into the chat.
  const isEditingLocked = !branchMode || streamingProposedChanges !== undefined

  // Get the modified Y.Text when in diff mode
  const previewFilesMap = streamingFilesMapRef.current ?? (branchMode ? editableFilesMapRef.current : null)
  const activeFileModifiedYText = activeFile && previewFilesMap
    ? previewFilesMap.get(activeFile) || null
    : null

  const getDownloadYText = useCallback((filename: string): Y.Text | null => {
    const previewMap = streamingFilesMapRef.current ?? (branchMode ? editableFilesMapRef.current : null)
    if (previewMap) {
      return previewMap.get(filename) ?? null
    }

    return headFilesMapRef.current.get(filename) ?? null
  }, [branchMode])

  const handleFileDownload = useCallback((filename: string) => {
    const ytext = getDownloadYText(filename)
    if (!ytext) {
      toasts.add({ title: `Could not download ${filename}`, variant: 'error' })
      return
    }

    saveTextToFile(filename, ytext.toString())
  }, [getDownloadYText, toasts])

  // Determine if we're in diff mode
  const isDiffMode = branchMode || (streamingProposedChanges !== undefined && streamingYdocRef.current !== null)

  const displayedFiles = useMemo(() => {
    return isDiffMode && previewFilesMap
      ? Array.from(new Set([...fileNames, ...previewFileNames])).toSorted()
      : fileNames
  }, [fileNames, isDiffMode, previewFilesMap, previewFileNames])

  // `headDoc` is a dependency because the original side is read through headFilesMapRef, whose
  // content changes exactly when headDoc is rebuilt: without it, a head advance that alters file
  // contents but not the changed-files *set* (e.g. a draft-added file now also existing on
  // mainline, "added" -> "modified") could leave stale statuses.
  const fileChangeStatuses = useMemo(() => {
    return isDiffMode && previewFilesMap
      ? computeFileChangeStatuses(headFilesMapRef.current, previewFilesMap, displayedFiles, changedFiles)
      : undefined
  }, [changedFiles, displayedFiles, headDoc, isDiffMode, previewFilesMap])
  const activeFileDownloadable = activeFile ? displayedFiles.includes(activeFile) : false
  const activeFileModeLabel = !branchMode
    ? 'Viewing'
    : isEditingLocked
      ? 'Reviewing changes in'
      : 'Editing changes in'

  // Outside a chat, ready means the committed files have loaded; within one, the chat's doc base
  // and recorded changes must be in too (the branch-docs effect builds the editable doc from them
  // one render later, which CodeDiffEditor tolerates as a transiently detached binding).
  const isReady = headFiles !== null &&
    (!branchMode || (usableChatBase !== null && chatChanges !== undefined))
  const loading = !isReady && !chatBaseError

  // Repair the file selection when the active file stops existing everywhere it could live --
  // e.g. a head advance (another chat's accept) deleted it, or the user left the chat whose
  // draft created it. Clearing the selection lets the auto-select effect pick a remaining file,
  // instead of showing a nonexistent filename over a blank editor. Only while ready: mid-load
  // both sides are transiently empty, and clobbering the selection then would lose it across
  // every ordinary reload.
  useEffect(() => {
    if (!isReady || activeFile === null) return
    const previewMap = streamingFilesMapRef.current ?? (branchMode ? editableFilesMapRef.current : null)
    if (!headFilesMapRef.current.has(activeFile) && !previewMap?.has(activeFile)) {
      setActiveFile(null)
    }
  }, [activeFile, branchMode, fileNames, headDoc, isReady, previewFileNames])

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

  if (chatBaseError) {
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
          files={displayedFiles}
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
            {displayedFiles.length === 0 ? (
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
                originalYText={activeFileYText}
                modifiedYText={activeFileModifiedYText}
                readOnly={isEditingLocked}
                height="100%"
              />
            ) : (
              // Outside any chat the committed head is shown read-only: committed code only
              // changes through a chat's accepted changes.
              <CodeEditor
                filename={activeFile}
                ytext={activeFileYText}
                isReady={false}
                height="100%"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function computeFileChangeStatuses(
  originalMap: Y.Map<Y.Text>,
  previewMap: Y.Map<Y.Text>,
  filenames: string[],
  changedFiles: Set<string>,
) {
  const statuses = new Map<string, FileChangeStatus>()

  for (const filename of filenames) {
    const original = originalMap.get(filename)
    const preview = previewMap.get(filename)

    if (!original && preview) {
      statuses.set(filename, 'added')
    } else if (original && !preview) {
      statuses.set(filename, 'deleted')
    } else if (original && preview && changedFiles.has(filename)) {
      statuses.set(filename, 'modified')
    } else {
      statuses.set(filename, 'unchanged')
    }
  }

  return statuses
}
