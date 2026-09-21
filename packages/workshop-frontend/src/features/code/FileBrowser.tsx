import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Collapsible, Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import {
  CaretDown, CaretRight, Cube, DotsThree, DownloadSimple, File, FolderSimple, LinkSimple, Pencil,
  Plus, TerminalWindow, Trash, X, type Icon,
} from '@phosphor-icons/react'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from '../../components/WorkshopControls'
import { isImeComposing } from '../../keyboardEvent'
import {
  ancestorDirs, resolveRenamePath, type BrowserNode, type BrowserTree, type ChangedFile,
  type FileChangeStatus, type LeafKind,
} from './workpieceTree'

// The code view's file browser: a Changes list (the files that differ from the review base, flat,
// with status dots) above the Files tree (the workpiece's whole displayed tree; see
// buildBrowserTree). Kumo has no tree primitive, so directories are Collapsibles and rows are
// buttons, indented by depth.
//
// Only `file` and `executable` leaves open: a symlink or submodule has no text and is listed for
// completeness, with its kind. Rename is also withheld from executables: a rename is a remove plus
// a set, and the tree writer takes a new path's mode from the *destination's* base entry, so a
// renamed script would silently lose its executable bit at the next accept or commit -- a
// CodeChange has no way to say "same mode at a new path".

/** Trees with more leaves than this open collapsed to their first level. */
const LARGE_TREE_LEAVES = 200

const INDENT_PX = 12
const ROW_BASE_PADDING_PX = 8

// Which listing a row belongs to (see the rename state).
type RowSection = 'changes' | 'tree'

interface FileBrowserProps {
  tree: BrowserTree
  // The files that differ from the review base, in path order. The Changes section shows only
  // while this is non-empty and `isDiffMode`.
  changes: readonly ChangedFile[]
  // Statuses for the tree rows' dots; a path with no entry (or 'unchanged') shows none.
  statuses?: ReadonlyMap<string, FileChangeStatus>
  activeFile: string | null
  streamingActiveFile?: string | null
  isDiffMode: boolean
  editLocked: boolean
  // What the workpiece is called in dialog copy: "gadget" or "worktree".
  workpieceNoun: string
  // The directories the user has explicitly opened or closed, by path, as last reported through
  // `onExpandedChange`. The browser owns this state from mount on; the pair lets the parent carry
  // it across the remount that a workpiece switch and switch-back is (see WorkpieceCodeInterface).
  initialExpanded?: ExpandedDirs
  onExpandedChange?: (expanded: ExpandedDirs) => void
  onFileSelect: (path: string) => void
  // `path` is relative to the tree root; the dialog accepts `dir/name.ext`.
  onFileCreate: (path: string) => void
  onFileDelete: (path: string) => void
  onFileRename: (oldPath: string, newPath: string) => void
  onFileDownload: (path: string) => void
  className?: string
  onRequestClose?: () => void
  ref?: Ref<FileBrowserHandle>
}

export interface FileBrowserHandle {
  openCreateModal: () => void
}

/**
 * Explicit per-directory expansion toggles: directory path -> open. A directory with no entry
 * follows the tree's size-dependent default (see LARGE_TREE_LEAVES).
 */
export type ExpandedDirs = ReadonlyMap<string, boolean>

/** Whether a leaf of this kind has text to show. */
export function isOpenableKind(kind: LeafKind | undefined): boolean {
  return kind === 'file' || kind === 'executable'
}

const SECTION_HEADER_CLASS =
  'text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive'

export default function FileBrowser({
  tree,
  changes,
  statuses,
  activeFile,
  streamingActiveFile,
  isDiffMode,
  editLocked,
  workpieceNoun,
  initialExpanded,
  onExpandedChange,
  onFileSelect,
  onFileCreate,
  onFileDelete,
  onFileRename,
  onFileDownload,
  className = '',
  onRequestClose,
  ref,
}: FileBrowserProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [newFileName, setNewFileName] = useState('')
  // A changed file is listed twice -- under Changes and in the tree -- so the row in rename mode
  // is identified by section as well as path: two inputs for one path would each take focus,
  // and the blur of the first would cancel the rename before it began.
  const [renaming, setRenaming] = useState<{ path: string; section: RowSection } | null>(null)

  useImperativeHandle(ref, () => ({
    openCreateModal: () => setIsCreateModalOpen(true),
  }), [])

  const toasts = useKumoToastManager()

  // Per-directory expansion: explicit toggles over a size-dependent default (small trees open,
  // large ones collapsed to their first level). The active file's ancestors are opened whenever
  // the selection moves, so a file the agent starts editing -- or one picked from the Changes
  // list -- is always in view; the user can still collapse them afterwards.
  const defaultExpanded = tree.leaves.size <= LARGE_TREE_LEAVES
  const [expanded, setExpanded] = useState<ExpandedDirs>(() => initialExpanded ?? new Map())
  const [revealedFile, setRevealedFile] = useState<string | null>(null)
  if (activeFile !== revealedFile) {
    setRevealedFile(activeFile)
    if (activeFile !== null) {
      const dirs = ancestorDirs(activeFile).filter(dir => !(expanded.get(dir) ?? defaultExpanded))
      if (dirs.length > 0) {
        const next = new Map(expanded)
        for (const dir of dirs) next.set(dir, true)
        setExpanded(next)
      }
    }
  }
  const isExpanded = (dir: string) => expanded.get(dir) ?? defaultExpanded
  const setDirExpanded = (dir: string, open: boolean) => {
    setExpanded(current => {
      const next = new Map(current)
      next.set(dir, open)
      return next
    })
  }
  // Reported from an effect rather than from the setters, because the reveal above updates the
  // state during render, where a parent callback may not run.
  const onExpandedChangeRef = useRef(onExpandedChange)
  onExpandedChangeRef.current = onExpandedChange
  useEffect(() => {
    onExpandedChangeRef.current?.(expanded)
  }, [expanded])

  const handleCreateFile = () => {
    const path = newFileName.trim()
    if (!path) {
      toasts.add({ title: 'Filename cannot be empty', variant: 'error' })
      return
    }
    if (tree.leaves.has(path)) {
      toasts.add({ title: 'A file with this name already exists', variant: 'error' })
      return
    }
    onFileCreate(path)
    setNewFileName('')
    setIsCreateModalOpen(false)
  }

  // The rename input edits the leaf's name within its directory; a name containing '/' moves the
  // file relative to that directory (see resolveRenamePath for `..` and root-relative forms).
  const commitRename = (path: string, nextName: string) => {
    const trimmed = nextName.trim()
    if (!trimmed) {
      setRenaming(null)
      return
    }
    const nextPath = resolveRenamePath(path, trimmed)
    if (nextPath === null) {
      toasts.add({ title: 'Invalid file path', variant: 'error' })
      return
    }
    if (nextPath === path) {
      setRenaming(null)
      return
    }
    if (tree.leaves.has(nextPath)) {
      toasts.add({ title: 'A file with this name already exists', variant: 'error' })
      return
    }
    onFileRename(path, nextPath)
    setRenaming(null)
  }

  const startDelete = (path: string) => {
    if (tree.leaves.size <= 1) {
      toasts.add({ title: 'Cannot delete the last remaining file', variant: 'error' })
      return
    }
    setDeletingFile(path)
  }

  const confirmDelete = () => {
    if (deletingFile !== null) onFileDelete(deletingFile)
    setDeletingFile(null)
  }

  const leafRowProps = (path: string, kind: LeafKind, section: RowSection) => ({
    isActive: activeFile === path,
    isStreamingActive: streamingActiveFile === path,
    status: statuses?.get(path),
    editLocked,
    kind,
    isRenaming: renaming !== null && renaming.path === path && renaming.section === section,
    onSelect: () => onFileSelect(path),
    onRename: () => setRenaming({ path, section }),
    onDelete: () => startDelete(path),
    onDownload: () => onFileDownload(path),
    onRenameSubmit: (nextName: string) => commitRename(path, nextName),
    onRenameCancel: () => setRenaming(null),
  })

  const renderNodes = (nodes: readonly BrowserNode[], depth: number) => nodes.map(node => {
    if (node.kind === 'dir') {
      const open = isExpanded(node.path)
      return (
        <Collapsible.Root
          key={node.path}
          open={open}
          onOpenChange={next => setDirExpanded(node.path, next)}
        >
          <Collapsible.Trigger
            className="group mb-[2px] flex h-10 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-[14px] leading-5 text-kumo-default outline-none transition-colors duration-150 ease-out hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-1 focus-visible:ring-offset-kumo-base md:h-7 md:text-[13px] md:leading-[18px]"
            style={{ paddingLeft: ROW_BASE_PADDING_PX + depth * INDENT_PX }}
          >
            <span className="flex w-3.5 shrink-0 items-center justify-center text-kumo-inactive">
              {open ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
            </span>
            <FolderSimple size={14} className="shrink-0 text-kumo-inactive" />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            {renderNodes(node.children, depth + 1)}
          </Collapsible.Panel>
        </Collapsible.Root>
      )
    }
    return (
      <FileRow
        key={node.path}
        label={node.name}
        path={node.path}
        indent={ROW_BASE_PADDING_PX + depth * INDENT_PX + 20}
        {...leafRowProps(node.path, node.kind, 'tree')}
      />
    )
  })

  const showChanges = isDiffMode && changes.length > 0

  return (
    <div className={`flex h-full w-[260px] flex-col border-r border-kumo-line bg-kumo-base ${className}`}>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
        <span className={SECTION_HEADER_CLASS}>
          {showChanges ? `Changes (${changes.length})` : 'Files'}
        </span>
        <div className="flex items-center gap-1">
          <WorkshopIconButton
            onClick={() => setIsCreateModalOpen(true)}
            disabled={editLocked}
            aria-label="New file"
            title="New file"
            className="!h-8 !w-8 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default md:!h-6 md:!w-6"
          >
            <Plus size={14} weight="bold" />
          </WorkshopIconButton>
          {onRequestClose && (
            <WorkshopIconButton
              onClick={onRequestClose}
              aria-label="Close files"
              className="!h-8 !w-8 md:!hidden"
            >
              <X size={16} />
            </WorkshopIconButton>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-2 pb-3">
        {showChanges && (
          <>
            <div className="mb-2">
              {changes.map(change => {
                const slash = change.path.lastIndexOf('/')
                const kind = tree.leaves.get(change.path) ?? 'file'
                return (
                  <FileRow
                    key={change.path}
                    label={change.path.slice(slash + 1)}
                    dirPrefix={slash >= 0 ? change.path.slice(0, slash + 1) : undefined}
                    path={change.path}
                    indent={ROW_BASE_PADDING_PX}
                    {...leafRowProps(change.path, kind, 'changes')}
                    status={change.status}
                  />
                )
              })}
            </div>
            <div className="mb-1 flex h-6 items-center px-1">
              <span className={SECTION_HEADER_CLASS}>Files</span>
            </div>
          </>
        )}
        <div>
          {renderNodes(tree.roots, 0)}
        </div>
      </div>

      <Dialog.Root
        open={isCreateModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setIsCreateModalOpen(false)
            setNewFileName('')
          }
        }}
      >
        <Dialog
          className="responsive-dialog !z-[1000] !w-[min(420px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[18%] !-translate-y-0"
          size="sm"
        >
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                New file
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                Create a new file in this {workpieceNoun}. Include a directory to place it there.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <WorkshopIconButton
                  {...props}
                  className="!h-7 !w-7"
                  aria-label="Close"
                >
                  <X size={16} />
                </WorkshopIconButton>
              )}
            />
          </div>

          <div className="px-5 py-4">
            <WorkshopInput
              autoFocus
              placeholder="src/filename.ts"
              aria-label="Filename"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleCreateFile()
                }
              }}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full font-mono"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
            <Dialog.Close
              render={(props) => (
                <WorkshopButton
                  {...props}
                  className="!h-9"
                >
                  Cancel
                </WorkshopButton>
              )}
            />
            <WorkshopButton
              tone="primary"
              onClick={handleCreateFile}
              disabled={!newFileName.trim()}
            >
              Create file
            </WorkshopButton>
          </div>
        </Dialog>
      </Dialog.Root>

      <DeleteConfirmationDialog
        open={deletingFile !== null}
        onOpenChange={(o) => {
          if (!o) setDeletingFile(null)
        }}
        title="Delete file?"
        description={<>This removes <span className="font-mono text-kumo-default">{deletingFile}</span> from the {workpieceNoun}. You can&apos;t undo this.</>}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

const LEAF_ICONS: Record<LeafKind, Icon> = {
  file: File,
  executable: TerminalWindow,
  symlink: LinkSimple,
  submodule: Cube,
}

const LEAF_KIND_LABELS: Record<LeafKind, string | undefined> = {
  file: undefined,
  executable: 'Executable',
  symlink: 'Symbolic link (not viewable)',
  submodule: 'Submodule (not viewable)',
}

interface FileRowProps {
  // The leaf's name; `dirPrefix` (Changes rows only) is its directory, shown dimmed before it.
  label: string
  dirPrefix?: string
  path: string
  indent: number
  kind: LeafKind
  isActive: boolean
  isStreamingActive: boolean
  status?: ChangedFile['status'] | 'unchanged'
  editLocked: boolean
  isRenaming: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
  onDownload: () => void
  onRenameSubmit: (nextName: string) => void
  onRenameCancel: () => void
}

function FileRow({
  label,
  dirPrefix,
  path,
  indent,
  kind,
  isActive,
  isStreamingActive,
  status,
  editLocked,
  isRenaming,
  onSelect,
  onRename,
  onDelete,
  onDownload,
  onRenameSubmit,
  onRenameCancel,
}: FileRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [renameValue, setRenameValue] = useState(label)
  const openable = isOpenableKind(kind)
  const isDeleted = status === 'deleted'
  // A removal whose review-base read is unsettled (see ChangedFile): selectable, nothing else.
  const isPending = status === 'pending'
  const dotClass = getStatusDotClass(status)
  const KindIcon = LEAF_ICONS[kind]
  const kindLabel = isPending ? 'Loading this change\u2026' : LEAF_KIND_LABELS[kind]

  useEffect(() => {
    if (!isRenaming) return
    setRenameValue(label)
    const id = window.setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      const dotIndex = label.lastIndexOf('.')
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex)
      } else {
        input.select()
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [isRenaming, label])

  return (
    <div
      className={[
        'group relative mb-[2px] flex h-10 items-center gap-1.5 rounded-md pr-1 text-[14px] leading-5 transition-[background-color,box-shadow,color,opacity] duration-150 ease-out md:h-7 md:text-[13px] md:leading-[18px]',
        isRenaming
          ? 'bg-kumo-base ring-1 ring-kumo-ring/40'
          : isActive
            ? 'file-row-active cursor-pointer bg-kumo-recessed text-kumo-default font-medium'
            : openable
              ? 'cursor-pointer text-kumo-default hover:bg-kumo-tint'
              : 'text-kumo-subtle',
      ].join(' ')}
      style={{ paddingLeft: indent }}
      title={kindLabel}
      onClick={isRenaming || !openable ? undefined : onSelect}
    >
      <KindIcon size={14} className="shrink-0 text-kumo-inactive" />

      {isRenaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              onRenameSubmit(renameValue)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onRenameCancel()
            }
          }}
          onBlur={() => {
            if (renameValue.trim() === '' || renameValue.trim() === label) {
              onRenameCancel()
            } else {
              onRenameSubmit(renameValue)
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Rename ${path}`}
          className="min-w-0 flex-1 bg-transparent text-[16px] leading-5 text-kumo-default outline-none placeholder:text-kumo-inactive md:text-[13px] md:leading-[18px]"
        />
      ) : openable ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch bg-transparent p-0 text-left text-[13px] leading-[18px] tracking-[-0.2px] text-inherit outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-1 focus-visible:ring-offset-kumo-base"
          aria-current={isActive ? 'page' : undefined}
          onClick={(event) => {
            event.stopPropagation()
            onSelect()
          }}
        >
          <span className={`min-w-0 flex-1 truncate ${isDeleted ? 'line-through' : ''}`}>
            {dirPrefix !== undefined && (
              <span className="text-kumo-inactive">{dirPrefix}</span>
            )}
            {label}
          </span>
          {isStreamingActive && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-kumo-success"
              aria-label={`${path} is being edited`}
              title="Agent is editing this file"
            />
          )}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] tracking-[-0.2px]">
          {dirPrefix !== undefined && (
            <span className="text-kumo-inactive">{dirPrefix}</span>
          )}
          {label}
        </span>
      )}

      <span
        aria-hidden="true"
        className={[
          'h-1.5 w-1.5 shrink-0 rounded-full',
          dotClass ?? 'bg-transparent',
        ].join(' ')}
      />

      {!isRenaming && !isDeleted && !isPending && openable && (
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={(
              <WorkshopIconButton
                aria-label={`Actions for ${path}`}
                onClick={(event) => event.stopPropagation()}
                className="!h-8 !w-8 text-kumo-inactive opacity-100 hover:bg-kumo-tint hover:text-kumo-default focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 md:!h-5 md:!w-5 md:opacity-0"
              >
                <DotsThree size={14} weight="bold" />
              </WorkshopIconButton>
            )}
          />
          <DropdownMenu.Content
            onClick={(event) => event.stopPropagation()}
            className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1"
          >
            <DropdownMenu.Item
              icon={<DownloadSimple size={12} className="mr-2" />}
              onClick={onDownload}
              className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
            >
              Download
            </DropdownMenu.Item>
            {!editLocked && (
              <>
                {kind === 'file' && (
                  <DropdownMenu.Item
                    icon={<Pencil size={12} className="mr-2" />}
                    onClick={onRename}
                    className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                  >
                    Rename
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  icon={<Trash size={12} className="mr-2" />}
                  variant="danger"
                  onClick={onDelete}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] transition-colors data-highlighted:bg-kumo-danger-tint"
                >
                  Delete
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
    </div>
  )
}

function getStatusDotClass(status: FileRowProps['status']): string | null {
  if (status === 'added') return 'bg-kumo-success'
  if (status === 'deleted') return 'bg-kumo-danger'
  if (status === 'modified') return 'bg-kumo-warning'
  return null
}
