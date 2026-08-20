import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import { DotsThree, DownloadSimple, Pencil, Plus, Trash, X } from '@phosphor-icons/react'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'

interface FileSidebarProps {
  files: string[]
  activeFile: string | null
  streamingActiveFile?: string | null
  dirtyFiles: Set<string>
  changedFiles?: Set<string>  // Files with proposed changes (for diff mode)
  fileChangeStatuses?: Map<string, FileChangeStatus>
  isDiffMode?: boolean         // Whether we're in diff mode
  editLocked?: boolean
  onFileSelect: (filename: string) => void
  onFileCreate: (filename: string) => void
  onFileDelete: (filename: string) => void
  onFileRename: (oldName: string, newName: string) => void
  onFileDownload: (filename: string) => void
  className?: string
  onRequestClose?: () => void
  ref?: Ref<FileSidebarHandle>
}

export type FileChangeStatus = 'added' | 'deleted' | 'modified' | 'unchanged'

export interface FileSidebarHandle {
  openCreateModal: () => void
}

export default function FileSidebar({
  files,
  activeFile,
  streamingActiveFile,
  dirtyFiles,
  changedFiles,
  fileChangeStatuses,
  isDiffMode = false,
  editLocked = false,
  onFileSelect,
  onFileCreate,
  onFileDelete,
  onFileRename,
  onFileDownload,
  className = '',
  onRequestClose,
  ref,
}: FileSidebarProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [newFileName, setNewFileName] = useState('')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const createInputRef = useRef<HTMLInputElement | null>(null)

  useImperativeHandle(ref, () => ({
    openCreateModal: () => setIsCreateModalOpen(true),
  }), [])

  const toasts = useKumoToastManager()

  const handleCreateFile = () => {
    if (!newFileName.trim()) {
      toasts.add({ title: 'Filename cannot be empty', variant: 'error' })
      return
    }

    if (files.includes(newFileName.trim())) {
      toasts.add({ title: 'A file with this name already exists', variant: 'error' })
      return
    }

    onFileCreate(newFileName.trim())
    setNewFileName('')
    setIsCreateModalOpen(false)
  }

  const startRename = (filename: string) => {
    setRenamingFile(filename)
  }

  const cancelRename = () => {
    setRenamingFile(null)
  }

  const commitRename = (filename: string, nextName: string) => {
    const trimmed = nextName.trim()
    if (!trimmed || trimmed === filename) {
      setRenamingFile(null)
      return
    }

    if (files.includes(trimmed)) {
      toasts.add({ title: 'A file with this name already exists', variant: 'error' })
      return
    }

    onFileRename(filename, trimmed)
    setRenamingFile(null)
  }

  const startDelete = (filename: string) => {
    if (files.length <= 1) {
      toasts.add({ title: 'Cannot delete the last remaining file', variant: 'error' })
      return
    }
    setDeletingFile(filename)
    setIsDeleteModalOpen(true)
  }

  const confirmDelete = () => {
    if (deletingFile) {
      onFileDelete(deletingFile)
    }
    setDeletingFile(null)
    setIsDeleteModalOpen(false)
  }

  return (
    <div className={`flex h-full w-[244px] flex-col border-r border-kumo-line bg-kumo-base ${className}`}>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
          Files
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
        {files.map(filename => {
          const isDirty = dirtyFiles.has(filename)
          const changeStatus = fileChangeStatuses?.get(filename)
          const hasChanges = changeStatus
            ? changeStatus !== 'unchanged'
            : changedFiles?.has(filename) || false
          const isUnchanged = isDiffMode && !hasChanges
          const isActive = activeFile === filename
          const isStreamingActive = streamingActiveFile === filename
          const dotClass = getStatusDotClass(changeStatus, isDirty)

          return (
            <FileRow
              key={filename}
              filename={filename}
              isActive={isActive}
              isUnchanged={isUnchanged}
              isStreamingActive={isStreamingActive}
              changeStatus={changeStatus}
              dotClass={dotClass}
              showDot={!!changeStatus || !!isDirty}
              editLocked={editLocked}
              isRenaming={renamingFile === filename}
              onSelect={() => onFileSelect(filename)}
              onRename={() => {
                startRename(filename)
              }}
              onDelete={() => {
                startDelete(filename)
              }}
              onDownload={() => onFileDownload(filename)}
              onRenameSubmit={(nextName) => commitRename(filename, nextName)}
              onRenameCancel={cancelRename}
            />
          )
        })}
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
                Create a new file in this gadget.
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
              ref={createInputRef}
              autoFocus
              placeholder="filename.ts"
              aria-label="Filename"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
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
        open={isDeleteModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setIsDeleteModalOpen(false)
            setDeletingFile(null)
          }
        }}
        title="Delete file?"
        description={<>This removes <span className="font-mono text-kumo-default">{deletingFile}</span> from the gadget. You can&apos;t undo this.</>}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

interface FileRowProps {
  filename: string
  isActive: boolean
  isUnchanged: boolean
  isStreamingActive: boolean
  changeStatus?: FileChangeStatus
  dotClass: string | null
  showDot: boolean
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
  filename,
  isActive,
  isUnchanged,
  isStreamingActive,
  changeStatus,
  dotClass,
  showDot,
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
  const [renameValue, setRenameValue] = useState(filename)
  const isDeleted = changeStatus === 'deleted'

  useEffect(() => {
    if (!isRenaming) return
    setRenameValue(filename)
    const id = window.setTimeout(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      const dotIndex = filename.lastIndexOf('.')
      if (dotIndex > 0) {
        input.setSelectionRange(0, dotIndex)
      } else {
        input.select()
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [isRenaming, filename])

  return (
    <div
      className={[
        'group relative mb-[2px] flex h-10 items-center gap-2 rounded-md px-2 text-[14px] leading-5 transition-[background-color,box-shadow,color,opacity] duration-150 ease-out md:h-7 md:text-[13px] md:leading-[18px]',
        isRenaming
          ? 'bg-kumo-base ring-1 ring-kumo-ring/40'
          : isActive
            ? 'file-row-active cursor-pointer bg-kumo-recessed text-kumo-default font-medium'
            : 'cursor-pointer text-kumo-default hover:bg-kumo-tint',
        isUnchanged && !isRenaming ? 'opacity-50' : '',
      ].join(' ')}
      onClick={isRenaming ? undefined : onSelect}
    >
      <span
        aria-hidden="true"
        className={[
          'h-1.5 w-1.5 shrink-0 rounded-full',
          showDot && dotClass ? dotClass : 'bg-transparent',
        ].join(' ')}
      />

      {isRenaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onRenameSubmit(renameValue)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onRenameCancel()
            }
          }}
          onBlur={() => {
            if (renameValue.trim() === '' || renameValue.trim() === filename) {
              onRenameCancel()
            } else {
              onRenameSubmit(renameValue)
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Rename ${filename}`}
          className="min-w-0 flex-1 bg-transparent text-[16px] leading-5 text-kumo-default outline-none placeholder:text-kumo-inactive md:text-[13px] md:leading-[18px]"
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch bg-transparent p-0 text-left text-[13px] leading-[18px] tracking-[-0.2px] text-inherit outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-1 focus-visible:ring-offset-kumo-base"
          aria-current={isActive ? 'page' : undefined}
          onClick={(event) => {
            event.stopPropagation()
            onSelect()
          }}
        >
          <span className="min-w-0 flex-1 truncate">{filename}</span>
          {isStreamingActive && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-kumo-success"
              aria-label={`${filename} is being edited`}
              title="Agent is editing this file"
            />
          )}
        </button>
      )}

      {!isRenaming && !isDeleted && (
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={(
              <WorkshopIconButton
                aria-label={`Actions for ${filename}`}
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
                <DropdownMenu.Item
                  icon={<Pencil size={12} className="mr-2" />}
                  onClick={onRename}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                >
                  Rename
                </DropdownMenu.Item>
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

function getStatusDotClass(status: FileChangeStatus | undefined, isDirty: boolean): string | null {
  if (isDirty) return 'bg-kumo-danger'
  if (status === 'added') return 'bg-kumo-success'
  if (status === 'deleted') return 'bg-kumo-danger'
  if (status === 'modified') return 'bg-kumo-warning'
  if (status === 'unchanged') return null
  return null
}
