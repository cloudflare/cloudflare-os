import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple, List } from '@phosphor-icons/react'
import { Overseer, CodeSubscriber, CodeUpdate } from '@gadgets/workshop-shared/api'
import { RpcStub, RpcTarget } from 'capnweb'
import * as Y from 'yjs'
import FileSidebar from './FileSidebar'
import type { FileChangeStatus, FileSidebarHandle } from './FileSidebar'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import CodeEditor from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'
import type { StreamingProposedChanges } from './ChatInterface'
import { saveTextToFile } from './fileTransfers'

// RpcTarget implementation for receiving code updates from the server
class CodeSubscriberImpl extends RpcTarget implements CodeSubscriber {
  private disabled: boolean = false;

  constructor(
    private ydoc: Y.Doc,
    private onReady: () => void,
    private onVersionUpdate: (version: number) => void
  ) {
    super()
  }

  update(up: CodeUpdate): void {
    if (this.disabled) return;

    // Apply the Yjs update to our local document
    // Mark origin as 'server' so we don't echo it back
    Y.applyUpdateV2(this.ydoc, up.update, 'server')

    // Update version and pass the update to be applied to server shadow doc
    this.onVersionUpdate(up.version)
  }

  ready(): void {
    if (this.disabled) return;

    // Called when we're initially synced with the server
    this.onReady()
  }

  // local call
  disable(): void {
    this.disabled = true;
  }
}

interface GadgetCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  // Name of the Y.Doc root map holding the selected workpiece's files (see
  // WorkpieceSummary.filesRoot). The Yjs doc is shared by the whole workspace; this selects which
  // workpiece's files the editor shows.
  filesRoot: string
  height?: string | number
  onCodeChange?: () => void
  selectedChatId?: number | null
  proposedChanges?: Uint8Array
  draftProposedChanges?: StreamingProposedChanges
  streamingProposedChanges?: StreamingProposedChanges
  // The file the agent is currently streaming edits into, if it is in this workpiece's root.
  streamingActiveFile?: string | null
  isAgentActive: boolean
  isVisible?: boolean
  onHasCodeChange?: (hasCode: boolean) => void
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
  chatId: number | null
  update: Uint8Array
}

export default function GadgetCodeInterface({ overseer, filesRoot, height = '100%', onCodeChange, selectedChatId = null, proposedChanges, draftProposedChanges, streamingProposedChanges, streamingActiveFile, isAgentActive, isVisible = true, onHasCodeChange }: GadgetCodeInterfaceProps) {
  const toasts = useKumoToastManager()
  const branchMode = selectedChatId !== null

  // Yjs document and files map - persistent across reconnections. The doc holds the whole
  // workspace (sync is whole-doc; updates may span workpieces); `filesRoot` selects the current
  // workpiece's file map within it. Y.Doc.getMap() returns the same instance for the same name,
  // so re-pointing the ref on every render is cheap and idempotent.
  const ydocRef = useRef<Y.Doc>(new Y.Doc())
  const filesMapRef = useRef<Y.Map<Y.Text>>(ydocRef.current.getMap(filesRoot))
  filesMapRef.current = ydocRef.current.getMap(filesRoot)

  // Updates originating locally are enqueued to this array.
  const updateQueueRef = useRef<QueuedCodeUpdate[]>([]);

  // Track the server's version for reconnection
  const serverVersionRef = useRef<number>(0)

  // Track whether we're currently sending updates to prevent concurrent sends
  const isSendingRef = useRef<boolean>(false)

  // React state for UI
  const [fileNames, setFileNames] = useState<string[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false)
  const [compactLayout, setCompactLayout] = useState(false)
  const fileSidebarRef = useRef<FileSidebarHandle | null>(null)
  const fileDrawerRef = useRef<HTMLDivElement | null>(null)
  const fileDrawerTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [committedDocVersion, setCommittedDocVersion] = useState(0)
  const [, setEditableDocVersion] = useState(0)

  // Branch and preview docs layered on top of committed mainline code.
  const durableBranchYdocRef = useRef<Y.Doc | null>(null)
  const editableYdocRef = useRef<Y.Doc | null>(null)
  const editableFilesMapRef = useRef<Y.Map<Y.Text> | null>(null)
  const streamingYdocRef = useRef<Y.Doc | null>(null)
  const streamingFilesMapRef = useRef<Y.Map<Y.Text> | null>(null)
  const editableDraftCursorRef = useRef(0)
  const editableDraftUpdatesRef = useRef<Uint8Array[] | undefined>(undefined)
  const editableBaseProposedRef = useRef<Uint8Array | undefined>(undefined)
  const editableCommittedVersionRef = useRef(0)
  const editableChatIdRef = useRef<number | null>(null)
  // The files root the editable/streaming docs' map refs were derived from; a root switch forces
  // a rebuild so the refs point into the newly-selected workpiece's map.
  const editableRootRef = useRef<string | null>(null)
  const streamingRootRef = useRef<string | null>(null)
  const selectedChatIdRef = useRef<number | null>(selectedChatId)
  selectedChatIdRef.current = selectedChatId
  const previewObserverCleanupRef = useRef<(() => void) | null>(null)
  const editableObserverCleanupRef = useRef<(() => void) | null>(null)
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())

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
  const sendUpdateToServerRef = useRef<(update?: Uint8Array, chatId?: number | null) => Promise<void>>(async () => {})

  // Keep a ref to the ready state so we can check it in error handlers without closure issues
  const isReadyRef = useRef(false)

  // Subscription stub for cleanup
  const subscriptionRef = useRef<RpcStub<{}> | null>(null)

  // When the selected workpiece changes, the previous root's file selection and per-turn state
  // are meaningless; reset so the auto-select effect picks a file from the new root.
  const prevFilesRootRef = useRef(filesRoot)
  useEffect(() => {
    if (prevFilesRootRef.current === filesRoot) return
    prevFilesRootRef.current = filesRoot
    setActiveFile(null)
    hasUserSwitchedFilesThisTurnRef.current = false
  }, [filesRoot])

  // Set up Y.Map observer to sync file list to React state
  useEffect(() => {
    const filesMap = ydocRef.current.getMap<Y.Text>(filesRoot)

    const updateFileList = () => {
      const names = Array.from(filesMap.keys()).toSorted()
      setFileNames(names)
    }

    // Initial sync
    updateFileList()

    // Observe changes to the map
    const observer = (_event: Y.YMapEvent<Y.Text>) => {
      updateFileList()
    }

    filesMap.observe(observer)

    return () => {
      filesMap.unobserve(observer)
    }
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

  // Avoid reporting an empty state before the first code sync is ready.
  const onHasCodeChangeRef = useRef(onHasCodeChange)
  onHasCodeChangeRef.current = onHasCodeChange
  useEffect(() => {
    if (isReady) {
      onHasCodeChangeRef.current?.(fileNames.length > 0)
    }
  }, [isReady, fileNames.length])

  // Select the file currently being edited by the agent, unless the user has
  // manually switched files during this turn.
  useEffect(() => {
    const previewMap = streamingFilesMapRef.current ?? editableFilesMapRef.current
    if (streamingActiveFile) lastStreamingActiveFileRef.current = streamingActiveFile
    let target = streamingActiveFile ?? lastStreamingActiveFileRef.current
    if (hasUserSwitchedFilesThisTurnRef.current || !target) {
      return
    }

    if (filesMapRef.current.has(target) || previewMap?.has(target)) {
      setActiveFile(target)
    }
  }, [isAgentActive, previewFileNames, selectedChatId, streamingActiveFile])

  const replaceChangedFiles = useCallback((previewMap: Y.Map<Y.Text> | null) => {
    setChangedFiles(prev => {
      const next = previewMap ? computeChangedFiles(filesMapRef.current, previewMap) : new Set<string>()
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
        const changed = didFileChange(filesMapRef.current, previewMap, filename)
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

  useEffect(() => {
    const originalMap = ydocRef.current.getMap<Y.Text>(filesRoot)
    const observer = (events: Y.YEvent<any>[]) => {
      const previewMap = streamingFilesMapRef.current ?? editableFilesMapRef.current
      if (!previewMap) {
        return
      }

      const touchedFiles = getTouchedFilesFromEvents(events, originalMap)
      if (touchedFiles.size > 0) {
        updateChangedFilesForNames(previewMap, touchedFiles)
      }
    }

    originalMap.observeDeep(observer)
    return () => {
      originalMap.unobserveDeep(observer)
    }
  }, [filesRoot, updateChangedFilesForNames])

  // Build the durable branch doc and editable draft doc whenever the selected chat or
  // server-backed branch state changes.
  useEffect(() => {
    if (!branchMode) {
      observeEditableDoc(null)
      durableBranchYdocRef.current = null
      editableYdocRef.current = null
      editableFilesMapRef.current = null
      editableDraftCursorRef.current = 0
      editableDraftUpdatesRef.current = undefined
      editableBaseProposedRef.current = undefined
      editableCommittedVersionRef.current = 0
      editableChatIdRef.current = null
      if (!streamingYdocRef.current) {
        observePreviewMap(null)
        replaceChangedFiles(null)
      }
      return
    }

    const durableDoc = new Y.Doc()
    Y.applyUpdateV2(durableDoc, Y.encodeStateAsUpdateV2(ydocRef.current))
    if (proposedChanges) {
      Y.applyUpdateV2(durableDoc, proposedChanges, 'server')
    }
    durableBranchYdocRef.current = durableDoc

    const draftUpdates = draftProposedChanges?.updates ?? []
    const draftUpdateCount = draftProposedChanges?.count ?? 0
    const shouldRebuildEditable = !editableYdocRef.current
      || editableChatIdRef.current !== selectedChatId
      || editableRootRef.current !== filesRoot
      || editableBaseProposedRef.current !== proposedChanges
      || editableCommittedVersionRef.current !== committedDocVersion
      || editableDraftCursorRef.current > draftUpdateCount

    if (shouldRebuildEditable) {
      const editableDoc = new Y.Doc()
      Y.applyUpdateV2(editableDoc, Y.encodeStateAsUpdateV2(durableDoc))
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
      editableBaseProposedRef.current = proposedChanges
      editableCommittedVersionRef.current = committedDocVersion
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
    committedDocVersion,
    draftProposedChanges?.count,
    draftProposedChanges?.updates,
    filesRoot,
    observePreviewMap,
    proposedChanges,
    replaceChangedFiles,
    selectedChatId,
  ])

  // Incrementally apply streaming updates to a persistent streaming Y.Doc.
  // Only new updates (beyond the cursor) are applied each frame.
  const streamingCursorRef = useRef(0)
  const streamingBaseProposedRef = useRef<Uint8Array | undefined>(undefined)
  const streamingUpdatesRef = useRef<Uint8Array[] | undefined>(undefined)
  const streamingBaseDocRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    const streamingUpdates = streamingProposedChanges?.updates
    const streamingUpdateCount = streamingProposedChanges?.count ?? 0

    if (!streamingUpdates || streamingUpdateCount === 0) {
      streamingYdocRef.current = null
      streamingFilesMapRef.current = null
      streamingCursorRef.current = 0
      streamingBaseProposedRef.current = undefined
      streamingUpdatesRef.current = undefined
      streamingBaseDocRef.current = null
      observePreviewMap(branchMode ? editableFilesMapRef.current : null)
      replaceChangedFiles(branchMode ? editableFilesMapRef.current : null)
      return
    }

    let rebuiltStreamingDoc = false

    // Rebuild streaming doc if not yet initialized, if the durable base changed, if the selected
    // workpiece root changed, or if the stream history was replaced (chat switch or codeReset).
    if (!streamingYdocRef.current
        || streamingBaseProposedRef.current !== proposedChanges
        || streamingBaseDocRef.current !== durableBranchYdocRef.current
        || streamingRootRef.current !== filesRoot
        || streamingUpdatesRef.current !== streamingUpdates
        || streamingCursorRef.current > streamingUpdateCount) {
      const streamingDoc = new Y.Doc()
      const baseState = branchMode && durableBranchYdocRef.current
        ? Y.encodeStateAsUpdateV2(durableBranchYdocRef.current)
        : Y.encodeStateAsUpdateV2(ydocRef.current)
      Y.applyUpdateV2(streamingDoc, baseState)
      streamingYdocRef.current = streamingDoc
      streamingFilesMapRef.current = streamingDoc.getMap<Y.Text>(filesRoot)
      streamingBaseProposedRef.current = proposedChanges
      streamingUpdatesRef.current = streamingUpdates
      streamingBaseDocRef.current = durableBranchYdocRef.current
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
  }, [branchMode, committedDocVersion, filesRoot, observePreviewMap, proposedChanges, replaceChangedFiles, selectedChatId, streamingProposedChanges?.count, streamingProposedChanges?.updates])

  // Helper to send updates to server based on what it's missing
  // Uses a loop to ensure all changes get sent, with only one send in flight at a time
  const sendUpdateToServer = async (update?: Uint8Array, chatId: number | null = null) => {
    if (update) {
      updateQueueRef.current.push({ update, chatId });
    }

    // If already sending, return early - the running instance will pick up our changes
    if (isSendingRef.current) {
      return
    }

    isSendingRef.current = true

    try {
      // Loop until there's nothing left to send
      while (updateQueueRef.current.length > 0) {
        const currentTarget = updateQueueRef.current[0].chatId
        let sameTargetCount = 1
        while (
          sameTargetCount < updateQueueRef.current.length &&
          updateQueueRef.current[sameTargetCount].chatId === currentTarget
        ) {
          sameTargetCount++
        }

        let outgoingUpdate = updateQueueRef.current[0].update
        if (sameTargetCount > 1) {
          outgoingUpdate = Y.mergeUpdatesV2(
            updateQueueRef.current
              .slice(0, sameTargetCount)
              .map((entry) => entry.update),
          )
        }

        try {
          await currentOverseerRef.current.updateCode(
            outgoingUpdate,
            currentTarget ?? undefined,
          )
          // Successfully sent - clear unsaved changes indicator
          setHasUnsavedChanges(false)
        } catch (error) {
          console.error('Failed to send update to server:', error)
          // Mark that we have unsaved changes
          setHasUnsavedChanges(true)
          // On error, stop trying to avoid hammering the server
          break
        }

        // Discard the update we successfully sent.
        updateQueueRef.current.splice(0, sameTargetCount);

        // More updates may have been queued in the meantime. Loop to handle them.

        // TODO: Consider putting a small delay here to coalesce more continuous keystrokes?
      }
    } finally {
      isSendingRef.current = false
    }
  }
  sendUpdateToServerRef.current = sendUpdateToServer

  // Subscribe to code updates from server
  useEffect(() => {
    const ydoc = ydocRef.current
    const isInitialLoad = serverVersionRef.current === 0

    const subscriberImpl = new CodeSubscriberImpl(
      ydoc,
      () => {
        setIsReady(true)
        isReadyRef.current = true
        setLoading(false)
        // Send any local changes after we're synced with server
        // This handles reconnection after offline edits
        sendUpdateToServer()
      },
      (version: number) => {
        // Update version
        serverVersionRef.current = version
        setCommittedDocVersion(version)
      }
    )

    const subscribe = async () => {
      try {
        // Only show loading state on initial load, not on reconnection
        if (isInitialLoad) {
          setLoading(true)
        }

        // Subscribe from the last known version (0 for initial load)
        const subscriptionStub = await currentOverseerRef.current.subscribeToCode(
          subscriberImpl,
          serverVersionRef.current
        )
        subscriptionRef.current = subscriptionStub

        // If this is a reconnection, the user can continue editing immediately
        if (!isInitialLoad) {
          setIsReady(true)
        }
      } catch (error) {
        console.error('Failed to subscribe to code updates:', error)
        // Only show error if we've never successfully loaded (never reached ready state)
        if (!isReadyRef.current) {
          toasts.add({ title: 'Failed to load code files', variant: 'error' })
          setLoading(false)
        }
        // For reconnection failures after we've loaded, don't show toast - user can keep editing
      }
    }

    subscribe()

    return () => {
      // Cleanup: dispose subscription stub
      if (subscriptionRef.current) {
        subscriptionRef.current[Symbol.dispose]()
        subscriptionRef.current = null
      }
      subscriberImpl.disable();
    }
  }, [overseer])

  // Set up committed-doc observer to send local changes to server in mainline mode.
  useEffect(() => {
    const ydoc = ydocRef.current

    const updateHandler = async (update: Uint8Array, origin: any) => {
      // Don't send updates that came from the server back to the server
      if (origin === 'server' || branchMode) {
        return
      }

      onCodeChange?.()

      // Send update to server
      await sendUpdateToServer(update, null)
    }

    ydoc.on('updateV2', updateHandler)

    return () => {
      ydoc.off('updateV2', updateHandler)
    }
  }, [branchMode, overseer, onCodeChange])

  // Handle file selection
  const handleFileSelect = (filename: string) => {
    if (activeFile !== filename) {
      hasUserSwitchedFilesThisTurnRef.current = true
    }
    setActiveFile(filename)
  }

  // Handle file creation
  const handleFileCreate = (filename: string) => {
    const filesMap = branchMode ? editableFilesMapRef.current : filesMapRef.current
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
    const filesMap = branchMode ? editableFilesMapRef.current : filesMapRef.current
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
    const filesMap = branchMode ? editableFilesMapRef.current : filesMapRef.current
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

  // Get the Y.Text for the active file (original version)
  const activeFileYText = activeFile ? filesMapRef.current.get(activeFile) || null : null
  const isEditingLocked = branchMode && streamingProposedChanges !== undefined

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

    return filesMapRef.current.get(filename) ?? null
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

  const fileChangeStatuses = useMemo(() => {
    return isDiffMode && previewFilesMap
      ? computeFileChangeStatuses(filesMapRef.current, previewFilesMap, displayedFiles, changedFiles)
      : undefined
  }, [changedFiles, displayedFiles, isDiffMode, previewFilesMap])
  const activeFileDownloadable = activeFile ? displayedFiles.includes(activeFile) : false
  const activeFileModeLabel = isEditingLocked
    ? 'Reviewing changes in'
    : isDiffMode
      ? 'Editing changes in'
      : 'Editing'

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
            files={displayedFiles}
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
            {isReady && !loading && displayedFiles.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center bg-kumo-base px-6 text-center">
                <div className="max-w-[360px]">
                  <p className="m-0 text-[15px] leading-[22px] font-semibold tracking-[-0.3px] text-kumo-default">
                    No files yet
                  </p>
                  <p className="mt-1.5 mb-0 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
                    Keep building with the agent in chat and files will appear here as it works, or create one yourself.
                  </p>
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
              <CodeEditor
                filename={activeFile}
                ytext={isDiffMode ? activeFileModifiedYText : activeFileYText}
                isReady={isReady}
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
