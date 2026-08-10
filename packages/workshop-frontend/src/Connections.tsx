import { useState, useEffect, useMemo } from 'react'
import { Dialog, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  Pencil,
  Trash,
  Blueprint,
  Warning,
  X,
} from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, GadgetClient, GadgetBindingInfo, BoundHookInfo, AuthenticatedApi, WorkpieceId } from '@gadgets/workshop-shared/api'
import GatekeeperModal from './GatekeeperModal'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { HookToggle } from './components/HookToggle'
import { useVendorBranding } from './useVendorBranding'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { EmptyState } from './components/EmptyState'
import {
  BindingCardData,
  BlueprintBindingCard,
  loadBindingCardData,
} from './components/BlueprintBindingCard'
import { reportIssue } from './errorReporting'

interface ConnectionsProps {
  overseer: RpcStub<Overseer>
  gadget: RpcStub<GadgetClient>
  // The chat currently open in the editor, if any. Connecting a resource with a chat open makes
  // the new binding provisional to that chat, exactly like a code edit: it works in the chat's
  // preview immediately, and becomes permanent only when the user accepts the chat's changes.
  chatId?: number
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConnectionsChange?: () => void
  isVisible?: boolean
  onHasGatekeepersChange?: (hasGatekeepers: boolean) => void
}

// Auto-approval rules live in Activity because they apply across the workspace, while this view is
// scoped to one gadget.
export default function Connections({ overseer, gadget, chatId, authenticatedApi, onConnectionsChange, isVisible, onHasGatekeepersChange }: ConnectionsProps) {
  const [bindings, setBindings] = useState<GadgetBindingInfo[]>([])
  // Identity of the gadget this tab is showing, needed to offer it to agent spawners.
  const [gadgetInfo, setGadgetInfo] = useState<{ id: WorkpieceId; title: string } | null>(null)
  const [hooks, setHooks] = useState<BoundHookInfo[]>([])
  const vendorBranding = useVendorBranding(authenticatedApi)
  const [loading, setLoading] = useState(true)
  const [editingBinding, setEditingBinding] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; resourceTitle: string } | null>(null)
  const [deleteHookTarget, setDeleteHookTarget] = useState<{ id: number; title: string } | null>(null)
  const [togglingHooks, setTogglingHooks] = useState<Set<number>>(new Set())
  const [annotationTarget, setAnnotationTarget] = useState<GadgetBindingInfo | null>(null)
  const toasts = useKumoToastManager()

  const loadGatekeepers = async () => {
    try {
      const [id, gadgetTitle, bindingList, hookList] = await Promise.all([
        gadget.getId(),
        gadget.getTitle(),
        // Pass the open chat so bindings this tab added provisionally to it are listed too.
        gadget.listBindings(chatId),
        // Workspace-wide; filtered to this gadget below.
        overseer.listHooks(),
      ])
      setGadgetInfo({ id, title: gadgetTitle })
      setBindings(bindingList)
      // This tab shows one gadget, so drop hooks that wake a different one -- otherwise its
      // toggle/delete controls would operate on another gadget's hooks.
      setHooks(hookList.filter((hook) => hook.gadgetId === id))
      onHasGatekeepersChange?.(bindingList.length > 0)
    } catch (err) {
      // Loud on purpose: this panel has no retry path, so a quieted transient failure would
      // silently render "no connected resources".
      console.error('Failed to load gatekeepers:', err)
      reportIssue('connections.load', err)
      toasts.add({ title: 'Failed to load connections', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleToggleHook = async (id: number, enabled: boolean) => {
    // Optimistically reflect the new state.
    setHooks((prev) => prev.map((h) => (h.id === id ? { ...h, enabled } : h)))
    setTogglingHooks((prev) => new Set(prev).add(id))
    try {
      if (enabled) {
        await overseer.enableHook(id)
      } else {
        await overseer.disableHook(id)
      }
      await loadGatekeepers()
    } catch (err) {
      console.error('Failed to toggle hook:', err)
      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })
      // Revert optimistic update.
      setHooks((prev) => prev.map((h) => (h.id === id ? { ...h, enabled: !enabled } : h)))
    } finally {
      setTogglingHooks((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteHookConfirm = async () => {
    if (!deleteHookTarget) return
    try {
      await overseer.deleteHook(deleteHookTarget.id)
      await loadGatekeepers()
    } catch (err) {
      console.error('Failed to delete hook:', err)
      toasts.add({ title: 'Failed to delete hook', variant: 'error' })
    } finally {
      setDeleteHookTarget(null)
    }
  }

  // Keyed on the `gadget` stub rather than `overseer`, even though the load uses both. The gadget
  // stub is derived from the overseer by an effect in the parent, so on reconnect it arrives one
  // render *after* the replacement overseer: keying on `overseer` fired this load while `gadget`
  // still pointed into the dead session (a guaranteed spurious failure), and then never fired
  // again once the live stub showed up, leaving the panel showing pre-disconnect state. Keying on
  // the derived stub can't observe that intermediate render, and a new overseer always yields a
  // new gadget stub, so reconnects are still covered.
  useEffect(() => {
    loadGatekeepers()
  }, [gadget, chatId])

  // Re-load when the tab becomes visible, so hooks enabled elsewhere (e.g. from the Activity log)
  // show up without a full page reload.
  useEffect(() => {
    if (isVisible) loadGatekeepers()
  }, [isVisible])


  // What an agent spawner created here may offer its agents: this gadget itself (under the same
  // `GADGET` name the gadget's own code uses) plus each of the gadget's bindings. All are enabled
  // by default in the modal, reproducing the pre-multi-gadget behavior where spawned agents
  // inherited everything the gadget held.
  const spawnerEnvCandidates = useMemo(() => {
    if (!gadgetInfo) return []
    return [
      {
        target: gadgetInfo.id,
        targetTitle: `${gadgetInfo.title} (this gadget)`,
        name: 'GADGET',
      },
      ...bindings.map((b) => ({ target: b.target, targetTitle: b.resourceTitle, name: b.name })),
    ]
  }, [gadgetInfo, bindings])

  const handleEditStart = (name: string) => {
    setEditingBinding(name)
    setEditValue(name)
  }

  const handleEditSave = async (name: string) => {
    const newName = editValue.trim()
    if (!newName) {
      toasts.add({ title: 'Binding name cannot be empty', variant: 'error' })
      return
    }
    if (newName === name) {
      setEditingBinding(null)
      return
    }

    try {
      await gadget.renameBinding(name, newName)
      await loadGatekeepers()
      onConnectionsChange?.()
    } catch (err) {
      console.error('Failed to rename binding:', err)
      toasts.add({ title: 'Failed to update binding name', variant: 'error' })
    } finally {
      setEditingBinding(null)
    }
  }

  const handleEditCancel = () => {
    setEditingBinding(null)
    setEditValue('')
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await gadget.unbind(deleteTarget.name)
      await loadGatekeepers()
      onConnectionsChange?.()
    } catch (err) {
      console.error('Failed to remove binding:', err)
      toasts.add({ title: 'Failed to remove connection', variant: 'error' })
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="h-full overflow-auto bg-kumo-base">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-5 sm:px-6">
        <section>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Connections
              </h2>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                External resources this gadget can use.
              </p>
            </div>
            <WorkshopButton
              tone="primary"
              onClick={() => setIsNewConnectionModalVisible(true)}
              className="self-start"
            >
              Connect resource
            </WorkshopButton>
          </div>

          {loading ? (
            <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              Loading connections...
            </div>
          ) : bindings.length === 0 ? (
            <EmptyState
              title="No connected resources"
              description="Connect Google Docs, GitHub, Google Sheets, and other services so this gadget can safely use external data."
              actionLabel="Connect resource"
              onAction={() => setIsNewConnectionModalVisible(true)}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              {bindings.map((gk, index) => {
                const isEditing = editingBinding === gk.name
                const isDeleting = deleteTarget?.name === gk.name
                // Still provisional to the open chat (see GadgetBindingInfo.chatId). Blueprint
                // annotations are excluded, since a blueprint only ever exports permanent edges.
                const isPending = gk.chatId !== undefined

                return (
                  <div
                    key={gk.name}
                    className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${isDeleting ? 'bg-kumo-danger-tint/40' : ''}`}
                  >
                    {isDeleting ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                            Delete {gk.resourceTitle}?
                          </p>
                          <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                            The binding <span className="font-mono">{gk.name}</span> will be removed from this gadget.
                          </p>
                        </div>
                        <WorkshopButton
                          tone="danger"
                          className="min-w-[68px]"
                          onClick={handleDeleteConfirm}
                        >
                          Delete
                        </WorkshopButton>
                        <WorkshopButton
                          onClick={() => setDeleteTarget(null)}
                        >
                          Cancel
                        </WorkshopButton>
                      </div>
                    ) : isEditing ? (
                      <div className="flex items-center gap-2">
                        <WorkshopInput
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleEditSave(gk.name)
                            if (e.key === 'Escape') handleEditCancel()
                          }}
                          placeholder="Binding name"
                          aria-label="Binding name"
                          autoFocus
                          className="min-w-0 flex-1 font-mono"
                        />
                        <WorkshopButton
                          tone="primary"
                          className="!h-8"
                          onClick={() => handleEditSave(gk.name)}
                          disabled={!editValue.trim()}
                        >
                          Save
                        </WorkshopButton>
                        <WorkshopButton
                          onClick={handleEditCancel}
                        >
                          Cancel
                        </WorkshopButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <GatekeeperIcon
                          vendorId={gk.vendorId}
                          fallbackText={gk.resourceTitle || gk.name}
                          {...(gk.vendorId ? vendorBranding.get(gk.vendorId) : undefined)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            <span className="min-w-0 truncate">{gk.resourceTitle}</span>
                            {isPending && (
                              <Tooltip content="Added in this chat; kept when you accept the chat's changes" asChild>
                                <span className="flex-shrink-0 rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] leading-none font-medium text-kumo-subtle">
                                  Draft
                                </span>
                              </Tooltip>
                            )}
                          </p>
                          <p className="mt-0.5 truncate text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                            Referenced in code as: <span className="font-mono text-kumo-subtle">{gk.name}</span>
                          </p>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          <Tooltip content="Edit name used in code" asChild>
                            <WorkshopIconButton
                              onClick={() => handleEditStart(gk.name)}
                              aria-label="Edit name used in code"
                            >
                              <Pencil size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                          {!isPending && (
                            <Tooltip content="Edit blueprint settings" asChild>
                              <WorkshopIconButton
                                onClick={() => setAnnotationTarget(gk)}
                                aria-label="Edit blueprint settings"
                              >
                                <Blueprint size={14} />
                              </WorkshopIconButton>
                            </Tooltip>
                          )}
                          <Tooltip content="Delete connection" asChild>
                            <WorkshopIconButton
                              danger
                              onClick={() => setDeleteTarget({ name: gk.name, resourceTitle: gk.resourceTitle })}
                              aria-label="Delete connection"
                            >
                              <Trash size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {!loading && hooks.length > 0 && (
          <section className="mt-8">
            <div className="mb-3">
              <h2 className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Hooks
              </h2>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                Callbacks that let connected resources wake up this gadget when events happen.
              </p>
            </div>

            <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              {hooks.map((hook, index) => {
                const isDeleting = deleteHookTarget?.id === hook.id
                const vendorId = bindings.find((b) => b.target === hook.gatekeeperId)?.vendorId

                return (
                  <div
                    key={hook.id}
                    className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${isDeleting ? 'bg-kumo-danger-tint/40' : ''}`}
                  >
                    {isDeleting ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                            Delete hook "{hook.description.title}"?
                          </p>
                          <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                            This permanently removes the hook. Future events will stop being delivered.
                          </p>
                        </div>
                        <WorkshopButton
                          tone="danger"
                          className="min-w-[68px]"
                          onClick={handleDeleteHookConfirm}
                        >
                          Delete
                        </WorkshopButton>
                        <WorkshopButton
                          onClick={() => setDeleteHookTarget(null)}
                        >
                          Cancel
                        </WorkshopButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <GatekeeperIcon
                          vendorId={vendorId}
                          fallbackText={hook.resourceTitle}
                          {...(vendorId ? vendorBranding.get(vendorId) : undefined)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {hook.description.title}
                          </p>
                          {hook.description.description && (
                            <p className="mt-0.5 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                              {hook.description.description}
                            </p>
                          )}
                          {hook.resourceTitle && (
                            <p className="mt-0.5 truncate text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                              {hook.resourceTitle}
                            </p>
                          )}
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          <HookToggle
                            enabled={hook.enabled}
                            disabled={togglingHooks.has(hook.id)}
                            onToggle={(enabled) => handleToggleHook(hook.id, enabled)}
                          />
                          <Tooltip content="Delete hook" asChild>
                            <WorkshopIconButton
                              danger
                              onClick={() => setDeleteHookTarget({ id: hook.id, title: hook.description.title })}
                              aria-label="Delete hook"
                            >
                              <Trash size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

      </div>

      <GatekeeperModal
        open={isNewConnectionModalVisible}
        onClose={() => setIsNewConnectionModalVisible(false)}
        getOverseer={() => overseer}
        spawnerEnvCandidates={spawnerEnvCandidates}
        onCreated={async (gk) => {
          try {
            const gatekeeperId = await gk.getId()
            await gadget.bindWithSuggestedName(gatekeeperId, chatId)
            toasts.add({
              title: chatId === undefined
                ? 'Connection created successfully'
                : "Connection created — accept the chat's changes to keep it",
              variant: 'success',
            })
            await loadGatekeepers()
            onConnectionsChange?.()
          } finally {
            gk[Symbol.dispose]()
          }
        }}
      />

      <BlueprintAnnotationModal
        target={annotationTarget}
        gadget={gadget}
        onClose={() => setAnnotationTarget(null)}
        onSaved={() => {
          toasts.add({ title: 'Blueprint settings saved.', variant: 'success' })
          setAnnotationTarget(null)
        }}
      />

    </div>
  )
}

function BlueprintAnnotationModal({
  target,
  gadget,
  onClose,
  onSaved,
}: {
  target: GadgetBindingInfo | null
  gadget: RpcStub<GadgetClient>
  onClose: () => void
  onSaved: () => void
}) {
  const [data, setData] = useState<BindingCardData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) {
      setData(null)
      setLoadError(null)
      setSaveError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const loaded = await loadBindingCardData(gadget, target)
        if (!cancelled) {
          if (loaded) {
            setData(loaded)
          } else {
            setLoadError('Connection not found.')
          }
        }
      } catch (err: any) {
        if (!cancelled) {
          reportIssue('connections.binding-load', err)
          setLoadError(err?.message || 'Could not load binding.')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target, gadget])

  const handleSave = async () => {
    if (!data || !target) return
    setSaving(true)
    setSaveError(null)
    try {
      await gadget.setBlueprintAnnotation(target.name, data.annotation)
      onSaved()
    } catch (err: any) {
      reportIssue('connections.binding-save', err)
      setSaveError(err?.message || 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const open = target !== null

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <Dialog className="!z-[1000] !w-[min(480px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0" size="lg">
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                Blueprint settings
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                How this connection appears in blueprints.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <WorkshopIconButton {...props} aria-label="Close">
                  <X size={16} />
                </WorkshopIconButton>
              )}
            />
          </div>

          <div className="space-y-4 px-4 py-4 sm:px-5">
            {loadError ? (
              <div className="text-[13px] text-kumo-subtle">{loadError}</div>
            ) : !data ? (
              <div className="py-2 text-center text-[13px] text-kumo-subtle">Loading...</div>
            ) : (
              <>
                <BlueprintBindingCard
                  data={data}
                  onChange={(annotation) => setData({ ...data, annotation })}
                  autoFocusDescription
                  flat
                />
              </>
            )}
          </div>

          <div className="border-t border-kumo-line px-4 py-3 sm:px-5">
            {saveError && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-l-2 border-l-kumo-brand border-y-kumo-line border-r-kumo-line bg-kumo-base px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-default">
                <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" />
                <span>{saveError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <WorkshopButton
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </WorkshopButton>
              <WorkshopButton
                tone="primary"
                onClick={handleSave}
                disabled={saving || !data}
              >
                {saving ? 'Saving...' : 'Save'}
              </WorkshopButton>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  )
}
