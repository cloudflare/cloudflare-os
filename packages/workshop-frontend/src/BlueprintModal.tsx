import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Badge, Dialog, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowsClockwise, Check, Copy, DownloadSimple, ImageSquare, Pencil, Plus, Trash, Warning, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { BlueprintGadgetSummary, GadgetClient, WorkspaceMetadata, Overseer, BlueprintBindingAnnotation, BlueprintScreenshotUpload } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton, WorkshopInput, WorkshopInputArea } from './components/WorkshopControls'
import { copyToClipboard } from './clipboard'
import { saveBlueprintArchive } from './fileTransfers'
import { useRpcStub } from './RpcContext'
import {
  BindingCardData,
  BlueprintBindingCard,
  loadBindingCardData,
} from './components/BlueprintBindingCard'

const BLUEPRINT_SCREENSHOT_WIDTH = 1280
const BLUEPRINT_SCREENSHOT_HEIGHT = 720
const MAX_BLUEPRINT_SCREENSHOT_BYTES = 700 * 1024

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to encode image.'))
    }, type, quality)
  })
}

async function compressBlueprintScreenshot(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = BLUEPRINT_SCREENSHOT_WIDTH
  canvas.height = BLUEPRINT_SCREENSHOT_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to get 2D canvas context')

  try {
    const targetRatio = BLUEPRINT_SCREENSHOT_WIDTH / BLUEPRINT_SCREENSHOT_HEIGHT
    const sourceRatio = bitmap.width / bitmap.height
    let sx = 0
    let sy = 0
    let sw = bitmap.width
    let sh = bitmap.height

    if (sourceRatio > targetRatio) {
      sw = bitmap.height * targetRatio
      sx = (bitmap.width - sw) / 2
    } else if (sourceRatio < targetRatio) {
      sh = bitmap.width / targetRatio
      sy = (bitmap.height - sh) / 2
    }

    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, BLUEPRINT_SCREENSHOT_WIDTH, BLUEPRINT_SCREENSHOT_HEIGHT)

    for (let quality = 0.86; quality >= 0.5; quality -= 0.12) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
      if (blob.size <= MAX_BLUEPRINT_SCREENSHOT_BYTES) return blob
    }

    return canvasToBlob(canvas, 'image/jpeg', 0.42)
  } finally {
    bitmap.close()
  }
}

type Props = {
  onClose: () => void
  overseer: RpcStub<Overseer>
  // The gadget this modal exports blueprints from (the gadget currently selected in the editor).
  gadget: RpcStub<GadgetClient>
  metadata: WorkspaceMetadata
  // "Update from blueprint", offered unless the gadget was built from scratch.
  blueprintUpdate?: { available: boolean; disabled: boolean; onStart: () => void }
}

export default function BlueprintModal({ onClose, overseer, gadget, metadata, blueprintUpdate }: Props) {
  const toasts = useKumoToastManager()
  const publicApi = useRpcStub()
  const offersUpdate = blueprintUpdate !== undefined

  const [blueprints, setBlueprints] = useState<BlueprintGadgetSummary[]>([])
  const [loading, setLoading] = useState(false)
  // Null until the first load picks the view the modal opens on.
  const [formMode, setFormMode] = useState<'list' | 'create' | 'edit' | null>(null)
  const [newTitle, setNewTitle] = useState(metadata.title)
  const [newDescription, setNewDescription] = useState('')
  const [newScreenshotBlob, setNewScreenshotBlob] = useState<Blob | null>(null)
  const [newScreenshotUrl, setNewScreenshotUrl] = useState<string | null>(null)
  const [clearScreenshot, setClearScreenshot] = useState(false)
  const [processingScreenshot, setProcessingScreenshot] = useState(false)
  const screenshotInputRef = useRef<HTMLInputElement>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [editingBlueprint, setEditingBlueprint] = useState<BlueprintGadgetSummary | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [bindings, setBindings] = useState<BindingCardData[]>([])
  const [bindingsLoading, setBindingsLoading] = useState(false)
  const [bindingsError, setBindingsError] = useState<string | null>(null)

  const loadBlueprints = useCallback(async (): Promise<BlueprintGadgetSummary[] | null> => {
    setLoading(true)
    try {
      const list = await overseer.listBlueprints()
      setBlueprints(list)
      return list
    } catch (err) {
      console.error('Failed to load blueprints:', err)
      toasts.add({ title: 'Failed to load blueprints', variant: 'error' })
      return null
    } finally {
      setLoading(false)
    }
  }, [overseer])

  const loadBindings = useCallback(async () => {
    setBindingsLoading(true)
    setBindingsError(null)
    try {
      // No chat scope: a blueprint exports only the gadget's permanent bindings, never a chat's
      // still-provisional additions.
      const list = await gadget.listBindings()
      const loaded = await Promise.all(list.map((b) => loadBindingCardData(gadget, b)))
      setBindings(loaded.filter((b): b is BindingCardData => b !== null))
    } catch (err) {
      console.error('Failed to load bindings:', err)
      setBindingsError('Could not load connections.')
    } finally {
      setBindingsLoading(false)
    }
  }, [gadget])

  useEffect(() => {
    let current = true
    loadBlueprints().then((list) => {
      // With nothing to list, the modal opens straight on the create form.
      if (current) setFormMode(mode => mode ?? (list?.length === 0 && !offersUpdate ? 'create' : 'list'))
    })
    return () => { current = false }
  }, [loadBlueprints, offersUpdate])

  useEffect(() => {
    if (formMode === 'create' || formMode === 'edit') {
      loadBindings()
    } else {
      setBindings([])
      setBindingsError(null)
      setCreateError(null)
    }
  }, [formMode, loadBindings])

  useEffect(() => {
    return () => {
      if (newScreenshotUrl) URL.revokeObjectURL(newScreenshotUrl)
    }
  }, [newScreenshotUrl])

  const handleScreenshotSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!file.type.startsWith('image/')) {
      toasts.add({ title: 'Please select an image file.', variant: 'error' })
      return
    }

    setProcessingScreenshot(true)
    try {
      const blob = await compressBlueprintScreenshot(file)
      setNewScreenshotBlob(blob)
      setNewScreenshotUrl(prev => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      setClearScreenshot(false)
    } catch (err) {
      console.error('Failed to process blueprint screenshot:', err)
      toasts.add({ title: 'Failed to process screenshot', variant: 'error' })
    } finally {
      setProcessingScreenshot(false)
    }
  }

  const updateBindingAnnotation = (bindingName: string, annotation: BlueprintBindingAnnotation) => {
    setBindings((prev) =>
      prev.map((b) => (b.bindingName === bindingName ? { ...b, annotation } : b)),
    )
  }

  const createBlueprint = async () => {
    if (bindingsLoading) return
    setCreating(true)
    setCreateError(null)
    try {
      await Promise.all(
        bindings.map((b) => gadget.setBlueprintAnnotation(b.bindingName, b.annotation)),
      )

      const screenshot: BlueprintScreenshotUpload | undefined = newScreenshotBlob
        ? {
          mimeType: 'image/jpeg',
          content: new Uint8Array(await newScreenshotBlob.arrayBuffer()),
        }
        : undefined

      await gadget.createBlueprint(
        newTitle.trim() || undefined,
        newDescription.trim() || undefined,
        screenshot,
      )
      toasts.add({ title: 'Blueprint created.', variant: 'success' })
      setFormMode('list')
      setNewTitle(metadata.title)
      setNewDescription('')
      setNewScreenshotBlob(null)
      setNewScreenshotUrl(null)
      setClearScreenshot(false)
      await loadBlueprints()
    } catch (err: any) {
      setCreateError(err.message || 'Could not create blueprint.')
    } finally {
      setCreating(false)
    }
  }

  const saveBlueprintEdits = async () => {
    if (!editingBlueprint || bindingsLoading) return
    setCreating(true)
    setCreateError(null)
    try {
      await Promise.all(
        bindings.map((b) => gadget.setBlueprintAnnotation(b.bindingName, b.annotation)),
      )

      const screenshot: BlueprintScreenshotUpload | null | undefined = clearScreenshot
        ? null
        : newScreenshotBlob
          ? {
            mimeType: 'image/jpeg',
            content: new Uint8Array(await newScreenshotBlob.arrayBuffer()),
          }
          : undefined

      await overseer.updateBlueprint(editingBlueprint.id, {
        title: newTitle.trim() || editingBlueprint.title,
        description: newDescription.trim(),
        updateBindings: true,
        screenshot,
      })
      toasts.add({ title: 'Blueprint updated.', variant: 'success' })
      setFormMode('list')
      setEditingBlueprint(null)
      setNewScreenshotBlob(null)
      setNewScreenshotUrl(null)
      setClearScreenshot(false)
      await loadBlueprints()
    } catch (err: any) {
      setCreateError(err.message || 'Could not update blueprint.')
    } finally {
      setCreating(false)
    }
  }

  const deleteBlueprint = async (id: string) => {
    setDeletingId(id)
    try {
      await overseer.deleteBlueprint(id)
      toasts.add({ title: 'Blueprint deleted.', variant: 'success' })
      setConfirmingDeleteId(null)
      await loadBlueprints()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to delete blueprint.', variant: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  const savedScreenshotUrl = formMode === 'edit' && editingBlueprint?.screenshotUrl && !clearScreenshot
    ? editingBlueprint.screenshotUrl
    : null
  const screenshotPreviewUrl = newScreenshotUrl ?? savedScreenshotUrl
  // A create form opened straight away has no list worth going back to.
  const hasList = blueprints.length > 0 || offersUpdate

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0" size="lg">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                {formMode === 'create' ? 'Create blueprint' : formMode === 'edit' ? 'Edit blueprint' : 'Blueprints'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {formMode === 'create'
                  ? 'Publish this gadget as a reusable template.'
                  : formMode === 'edit'
                    ? 'Update the details, screenshot, and connection guidance for this blueprint.'
                    : 'Manage blueprint updates and publishing.'}
              </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              render={(props) => (
                <WorkshopIconButton
                  {...props}
                  aria-label="Close"
                >
                  <X size={18} />
                </WorkshopIconButton>
              )}
            />
          </div>

          {formMode === null ? (
            <div className="flex justify-center px-4 py-10 sm:px-6"><Loader size="base" /></div>
          ) : formMode !== 'list' ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="chat-panel min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
                  <div className="space-y-3">
                    <WorkshopInput
                      placeholder="Title"
                      aria-label="Blueprint title"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      className="w-full"
                    />
                    <WorkshopInputArea
                      placeholder="Description (optional)"
                      aria-label="Blueprint description"
                      value={newDescription}
                      onChange={(e) => setNewDescription(e.target.value)}
                      rows={3}
                      className="w-full"
                    />
                    <input
                      ref={screenshotInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleScreenshotSelected}
                    />
                    <div className="rounded-xl border border-kumo-line bg-kumo-base p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            Screenshot
                          </p>
                          <p className="m-0 mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                            Optional image shown on Explore and the blueprint detail page.
                            {formMode === 'edit' && !newScreenshotUrl && editingBlueprint?.screenshotUrl && !clearScreenshot ? ' The current screenshot will stay unless you upload a new one.' : ''}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {(newScreenshotUrl || (formMode === 'edit' && editingBlueprint?.screenshotUrl && !clearScreenshot)) && (
                            <WorkshopButton
                              className="!h-8"
                              onClick={() => {
                                setNewScreenshotBlob(null)
                                setNewScreenshotUrl(prev => {
                                  if (prev) URL.revokeObjectURL(prev)
                                  return null
                                })
                                setClearScreenshot(true)
                              }}
                              disabled={processingScreenshot || creating}
                            >
                              Clear
                            </WorkshopButton>
                          )}
                          <WorkshopButton
                            className="!h-8"
                            onClick={() => screenshotInputRef.current?.click()}
                            disabled={processingScreenshot || creating}
                          >
                            <ImageSquare size={13} weight="bold" />
                            {processingScreenshot ? 'Processing...' : newScreenshotUrl || (formMode === 'edit' && editingBlueprint?.screenshotUrl && !clearScreenshot) ? 'Change' : 'Upload'}
                          </WorkshopButton>
                        </div>
                      </div>
                      {screenshotPreviewUrl && (
                        <div className="mt-3 overflow-hidden rounded-lg border border-kumo-line bg-kumo-tint">
                          <img
                            src={screenshotPreviewUrl}
                            alt="Blueprint screenshot preview"
                            className="max-h-[320px] w-full object-contain"
                          />
                        </div>
                      )}
                      {clearScreenshot && !newScreenshotUrl && (
                        <div className="mt-3 rounded-lg border border-dashed border-kumo-line bg-kumo-tint px-3 py-2 text-[12px] leading-4 text-kumo-subtle">
                          Screenshot will be removed when you save.
                        </div>
                      )}
                    </div>
                  </div>

                  {bindingsLoading ? (
                    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] text-kumo-subtle">
                      Loading connections...
                    </div>
                  ) : bindingsError ? (
                    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-[13px] text-kumo-subtle">
                      {bindingsError}
                    </div>
                  ) : bindings.length > 0 ? (
                    <section>
                      <h3 className="m-0 mb-1 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                        Connections
                      </h3>
                      <p className="m-0 mb-3 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                        Name each connection and add guidance for people using this blueprint.
                      </p>
                      <div className="space-y-2">
                        {bindings.map((b) => (
                          <BlueprintBindingCard
                            key={b.bindingName}
                            data={b}
                            onChange={(annotation) => updateBindingAnnotation(b.bindingName, annotation)}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>

                <div className="shrink-0 border-t border-kumo-line px-4 py-4 sm:px-6">
                  {createError && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-l-2 border-l-kumo-brand border-y-kumo-line border-r-kumo-line bg-kumo-base px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-default">
                      <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" />
                      <span>{createError}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <WorkshopButton
                      className="!h-9 min-w-[64px]"
                      onClick={hasList
                        ? () => {
                          setFormMode('list')
                          setEditingBlueprint(null)
                        }
                        : onClose}
                      disabled={creating}
                    >
                      {hasList ? 'Back' : 'Cancel'}
                    </WorkshopButton>
                    <WorkshopButton
                      tone="primary"
                      className="min-w-[64px]"
                      onClick={formMode === 'create' ? createBlueprint : saveBlueprintEdits}
                      disabled={creating || bindingsLoading || processingScreenshot}
                    >
                      {creating
                        ? formMode === 'create' ? 'Creating...' : 'Saving...'
                        : processingScreenshot ? 'Processing...'
                          : bindingsLoading ? 'Loading...'
                            : formMode === 'create' ? 'Create' : 'Save'}
                    </WorkshopButton>
                  </div>
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-6">
              {blueprintUpdate && (
                <ActionCard
                  title="Update from blueprint"
                  description="Merge a blueprint's latest version into this gadget."
                  trailing={
                    <>
                      {blueprintUpdate.available && (
                        <span className="text-[11px] leading-4 font-medium text-kumo-brand">Update available</span>
                      )}
                      <ArrowsClockwise size={16} className="text-kumo-subtle" />
                    </>
                  }
                  onClick={blueprintUpdate.onStart}
                  disabled={blueprintUpdate.disabled}
                />
              )}
              <ActionCard
                title="Create blueprint"
                description="Publish this gadget as a reusable template."
                trailing={<Plus size={16} className="text-kumo-subtle" />}
                onClick={() => {
                  setNewTitle(metadata.title)
                  setNewDescription('')
                  setNewScreenshotBlob(null)
                  setNewScreenshotUrl(null)
                  setClearScreenshot(false)
                  setEditingBlueprint(null)
                  setFormMode('create')
                }}
              />

            <section>
              <h3 className="mb-2 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                Existing published blueprints
              </h3>

              {loading ? (
                <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] text-kumo-subtle">
                  Loading blueprints...
                </div>
              ) : blueprints.length === 0 ? (
                <div className="rounded-xl border border-dashed border-kumo-line bg-kumo-base px-4 py-6 text-center">
                  <p className="text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                    No blueprints yet.
                  </p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                  {blueprints.map((bp, index) => (
                    <BlueprintRow
                      key={bp.id}
                      bp={bp}
                      isFirst={index === 0}
                      onStartEdit={() => {
                        setNewTitle(bp.title)
                        setNewDescription(bp.description)
                        setNewScreenshotBlob(null)
                        setNewScreenshotUrl(null)
                        setClearScreenshot(false)
                        setEditingBlueprint(bp)
                        setFormMode('edit')
                      }}
                      onUpdateCode={async () => {
                        try {
                          await overseer.updateBlueprint(bp.id, { updateCode: true })
                          toasts.add({ title: 'Blueprint updated to current code.', variant: 'success' })
                          loadBlueprints()
                        } catch (err: any) {
                          toasts.add({ title: err.message || 'Failed to update blueprint.', variant: 'error' })
                        }
                      }}
                      onRetryPublish={async () => {
                        try {
                          await overseer.retryBlueprintPublish(bp.id)
                          toasts.add({ title: 'Blueprint published successfully.', variant: 'success' })
                          loadBlueprints()
                        } catch (err: any) {
                          toasts.add({ title: err.message || 'Retry failed.', variant: 'error' })
                        }
                      }}
                      onCopyLink={async () => {
                        const url = `${window.location.origin}/blueprint/${bp.id}`
                        return copyToClipboard(url)
                      }}
                      onDownload={async () => {
                        try {
                          await saveBlueprintArchive(() => publicApi.downloadBlueprint(bp.id), bp.title, bp.version)
                        } catch (err) {
                          const message = err instanceof Error ? err.message : ''
                          toasts.add({ title: message || 'Failed to download blueprint.', variant: 'error' })
                        }
                      }}
                      isConfirmingDelete={confirmingDeleteId === bp.id}
                      isDeleting={deletingId === bp.id}
                      onStartDelete={() => setConfirmingDeleteId(bp.id)}
                      onConfirmDelete={() => deleteBlueprint(bp.id)}
                      onCancelDelete={() => setConfirmingDeleteId(null)}
                    />
                  ))}
                </div>
              )}
            </section>
              </div>
            )}
      </Dialog>
    </Dialog.Root>
  )
}

const ActionCard = ({
  title,
  description,
  trailing,
  onClick,
  disabled,
}: {
  title: string
  description: string
  trailing: ReactNode
  onClick: () => void
  disabled?: boolean
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="flex w-full items-center justify-between gap-3 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-left transition-colors hover:bg-kumo-elevated disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-kumo-base"
  >
    <span>
      <span className="block text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
        {title}
      </span>
      <span className="mt-0.5 block text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
        {description}
      </span>
    </span>
    <span className="flex shrink-0 items-center gap-3">{trailing}</span>
  </button>
)

function BlueprintRow({
  bp,
  isFirst,
  onStartEdit,
  onUpdateCode,
  onRetryPublish,
  onCopyLink,
  onDownload,
  isConfirmingDelete,
  isDeleting,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  bp: BlueprintGadgetSummary
  isFirst: boolean
  onStartEdit: () => void
  onUpdateCode: () => void
  onRetryPublish: () => void
  onCopyLink: () => Promise<boolean>
  onDownload: () => Promise<void>
  isConfirmingDelete: boolean
  isDeleting: boolean
  onStartDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [downloading, setDownloading] = useState(false)
  useEffect(() => {
    if (copyState === 'idle') return
    const t = setTimeout(() => setCopyState('idle'), 1500)
    return () => clearTimeout(t)
  }, [copyState])

  const ROW_MIN_H = 'min-h-[116px]'
  if (isConfirmingDelete) {
    return (
      <div
        className={`flex items-center px-4 py-4 ${ROW_MIN_H} ${isFirst ? '' : 'border-t border-kumo-line'} bg-kumo-danger-tint/40`}
      >
        <div className="flex w-full flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-[14px] leading-5 font-semibold tracking-[-0.3px] text-kumo-danger">
              Delete "{bp.title}"?
            </p>
            <p className="m-0 mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              People who started a gadget from this blueprint won't be affected, but the link will stop working.
            </p>
          </div>
          <button
            type="button"
            onClick={onConfirmDelete}
            disabled={isDeleting}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-kumo-danger px-2.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            disabled={isDeleting}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-transparent px-2.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group/row relative px-4 py-4 ${ROW_MIN_H} ${isFirst ? '' : 'border-t border-kumo-line'}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <p className="m-0 min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold tracking-[-0.3px] text-kumo-default">
          {bp.title}
        </p>

        {bp.unpublishedChanges && <Badge variant="warning">Unpublished changes</Badge>}

        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-semibold tracking-[-0.1px] ${
            bp.dirty
              ? 'border-kumo-brand/25 bg-kumo-brand/10 text-kumo-brand'
              : 'border-kumo-line bg-kumo-tint text-kumo-subtle'
          }`}
          title={bp.dirty ? 'Last publish failed' : undefined}
        >
          {bp.dirty && (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-kumo-brand"
              aria-hidden="true"
            />
          )}
          v{bp.version} · {new Date(bp.codeVersionDate).toLocaleDateString()}
        </span>
      </div>

      <div className="mt-1.5 min-h-[18px]">
        {bp.description ? (
          <p className="m-0 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle whitespace-pre-wrap">
            {bp.description}
          </p>
        ) : (
          <p className="m-0 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-inactive">
            No description
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="-ml-[7px] flex flex-wrap items-center gap-1">
          <GhostButton onClick={onUpdateCode} icon={<ArrowsClockwise size={13} />}>
            Update code
          </GhostButton>
          {bp.dirty && (
            <GhostButton onClick={onRetryPublish} icon={<ArrowsClockwise size={13} />}>
              Retry publish
            </GhostButton>
          )}
          <GhostButton
            onClick={async () => {
              setCopyState(await onCopyLink() ? 'copied' : 'failed')
            }}
            icon={
              copyState === 'copied' ? (
                <Check size={13} className="text-kumo-success" />
              ) : (
                <Copy size={13} />
              )
            }
          >
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy link'}
          </GhostButton>
          <GhostButton
            onClick={async () => {
              setDownloading(true)
              try {
                await onDownload()
              } finally {
                setDownloading(false)
              }
            }}
            icon={<DownloadSimple size={13} />}
            disabled={downloading}
          >
            {downloading ? 'Downloading...' : 'Download archive'}
          </GhostButton>
        </div>
        <div className="-mr-1.5 ml-auto flex items-center gap-0.5 opacity-60 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onStartEdit}
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-transparent text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
            aria-label="Edit blueprint"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={onStartDelete}
            className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-transparent text-kumo-subtle transition-colors hover:bg-kumo-danger-tint hover:text-kumo-danger"
            aria-label="Delete blueprint"
          >
            <Trash size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

function GhostButton({
  onClick,
  icon,
  disabled,
  children,
}: {
  onClick: () => void | Promise<void>
  icon: React.ReactNode
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-2 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  )
}
