import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Dialog, DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  Blueprint,
  Clock,
  Lightning,
  Pencil,
  PlugsConnected,
  Warning,
  X,
} from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, GadgetClient, GadgetBindingInfo, BoundHookInfo, AuthenticatedApi, WorkpieceId, GATEKEEPER_ERROR_CODES, getGatekeeperErrorCode } from '@gadgets/workshop-shared/api'
import GatekeeperModal from './GatekeeperModal'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { HookToggle, hookToggleFailureToast } from './components/HookToggle'
import { useVendorBranding } from './useVendorBranding'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import { MoreIcon, PlusIcon, TrashIcon } from './components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './components/menuStyles'
import { roundButtonClass } from './components/RoundButton'
import { isScheduleUrl } from './features/automations/AutomationCard'
import { DeleteAutomationDialog } from './features/automations/AutomationList'
import {
  BindingCardData,
  BlueprintBindingCard,
  loadBindingCardData,
} from './components/BlueprintBindingCard'
import { reportIssue } from './errorReporting'
import { classifyRpcError, logRpcFailure, rpcFailureDescription } from './rpcErrors'
import { isImeComposing } from './keyboardEvent'

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

/**
 * Auto-approval rules live in Activity because they apply across the workspace, while this view is
 * scoped to one gadget.
 */
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
  // A connection created here whose bind the restart interrupted. Creating a vendor connection
  // restarts the workspace while any "build" collaborator is live, the creator's own session
  // included, and the doomed session refuses to bind it, so it is bound once the session is replaced.
  const pendingBind = useRef<{ gatekeeperId: WorkpieceId; chatId?: number }>(undefined)

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
      // A dropped or replaced session (moving to another workspace's chat disposes this one) is
      // cured without a retry here: its replacement brings a new gadget stub, which loads afresh
      // (see the effect below). Anything else is loud, since this panel has no retry path and a
      // quiet failure would read as "no connected resources".
      if (logRpcFailure('Failed to load gatekeepers:', err)) return
      reportIssue('connections.load', err)
      toasts.add({ title: 'Failed to load connections', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const bindConnection = async (gatekeeperId: WorkpieceId, bindChatId: number | undefined) => {
    await gadget.bindWithSuggestedName(gatekeeperId, bindChatId)
    toasts.add({
      title: bindChatId === undefined
        ? 'Connection created successfully'
        : "Connection created — accept the chat's changes to keep it",
      variant: 'success',
    })
    await loadGatekeepers()
    onConnectionsChange?.()
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
      toasts.add(hookToggleFailureToast(enabled, err))
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

  // Keyed on `gadget` alone: a new stub means a new session (a chat switch keeps the stub), so the
  // pending bind runs once, in the replacement session, into the chat it was added from.
  useEffect(() => {
    const pending = pendingBind.current
    if (!pending) return
    pendingBind.current = undefined
    bindConnection(pending.gatekeeperId, pending.chatId).catch((err) => {
      console.error('Failed to bind connection:', err)
      toasts.add({ title: 'Failed to add connection', description: rpcFailureDescription(err), variant: 'error' })
    })
  }, [gadget])

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

  const openConnect = () => setIsNewConnectionModalVisible(true)

  return (
    <div className="h-full overflow-auto bg-kumo-base">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-8 px-4 py-6 sm:px-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[15px] font-medium leading-5 text-kumo-default">Connections</h2>
              <p className="text-[13px] leading-[18px] text-kumo-subtle">What this app can use, and the name its code knows each by.</p>
            </div>
            {!loading && bindings.length > 0 && (
              <button type="button" onClick={openConnect} className={roundButtonClass('pill', 'h-[34px] shrink-0 !gap-1.5 !px-3 !text-[13px]')}>
                <PlusIcon size={13} aria-hidden="true" /> Connect
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex justify-center py-10">
              <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
            </div>
          ) : bindings.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl px-6 py-10 text-center ring-1 ring-kumo-line">
              <span className="flex size-9 items-center justify-center rounded-full bg-kumo-tint text-kumo-default" aria-hidden="true">
                <PlugsConnected size={16} />
              </span>
              <p className="text-[14px] font-medium leading-5 text-kumo-default">Nothing connected yet</p>
              <p className="max-w-[340px] text-[13px] leading-[18px] text-kumo-subtle">
                Connect your email, a spreadsheet or another service, and this app can use it safely.
              </p>
              <button
                type="button"
                onClick={openConnect}
                className="mt-2 inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3.5 text-[13px] font-medium text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
              >
                <PlusIcon size={13} aria-hidden="true" /> Connect
              </button>
            </div>
          ) : (
            <div className="flex flex-col rounded-2xl bg-kumo-base ring-1 ring-kumo-line">
              {bindings.map((gk, index) => {
                const isEditing = editingBinding === gk.name
                // Still provisional to the open chat (see GadgetBindingInfo.chatId). Blueprint
                // annotations are excluded, since a blueprint only ever exports permanent edges.
                const isPending = gk.chatId !== undefined
                return (
                  <div key={gk.name} className={`flex min-h-14 items-center gap-3 px-3 py-2 ${index > 0 ? 'border-t border-kumo-line' : ''}`}>
                    <GatekeeperIcon
                      vendorId={gk.vendorId}
                      fallbackText={gk.resourceTitle || gk.name}
                      className="size-8 rounded-lg"
                      {...(gk.vendorId ? vendorBranding.get(gk.vendorId) : undefined)}
                    />
                    {isEditing ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-2"
                        onSubmit={(e) => { e.preventDefault(); void handleEditSave(gk.name) }}
                      >
                        <WorkshopInput
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (isImeComposing(e)) return
                            if (e.key === 'Escape') handleEditCancel()
                          }}
                          placeholder="Name in code"
                          aria-label="Name in code"
                          autoFocus
                          className="min-w-0 flex-1 font-mono"
                        />
                        <button type="button" onClick={handleEditCancel} className={roundButtonClass('pill', 'h-8 !px-3 !text-[13px]')}>Cancel</button>
                        <button
                          type="submit"
                          disabled={!editValue.trim()}
                          className="inline-flex h-8 cursor-pointer items-center rounded-full bg-kumo-contrast px-3 text-[13px] font-medium text-kumo-inverse hover:opacity-85 disabled:cursor-default disabled:opacity-50"
                        >
                          Save
                        </button>
                      </form>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-[14px] leading-5 text-kumo-default">
                            <span className="min-w-0 truncate">{gk.resourceTitle}</span>
                            {isPending && (
                              <Tooltip content="Added in this chat; kept with the chat's changes" asChild>
                                <span className="shrink-0 rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] font-medium leading-none text-kumo-subtle">Draft</span>
                              </Tooltip>
                            )}
                          </p>
                          <p className="truncate font-mono text-[12px] leading-4 text-kumo-inactive">env.{gk.name}</p>
                        </div>
                        <RowMenu label={gk.resourceTitle} items={[
                          { label: 'Rename in code', icon: <Pencil size={14} />, onClick: () => handleEditStart(gk.name) },
                          ...(!isPending ? [{ label: 'Blueprint settings', icon: <Blueprint size={14} />, onClick: () => setAnnotationTarget(gk) }] : []),
                          { label: 'Remove', icon: <TrashIcon size={14} />, danger: true, onClick: () => setDeleteTarget({ name: gk.name, resourceTitle: gk.resourceTitle }) },
                        ]} />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {!loading && hooks.length > 0 && (
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-[15px] font-medium leading-5 text-kumo-default">Automations</h2>
              <p className="text-[13px] leading-[18px] text-kumo-subtle">What runs this app&rsquo;s code, on a schedule or when something happens.</p>
            </div>
            <div className="flex flex-col gap-2">
              {hooks.map((hook) => {
                const schedule = isScheduleUrl(hook.resourceUrl)
                const Icon = schedule ? Clock : Lightning
                const detail = !schedule && hook.resourceTitle
                  ? [hook.resourceTitle, hook.description.description].filter(Boolean).join(' · ')
                  : hook.description.description
                return (
                  <div key={hook.id} className="flex items-start gap-3 rounded-2xl bg-kumo-base p-3 ring-1 ring-kumo-line">
                    <span
                      className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ${hook.enabled ? 'bg-kumo-tint text-kumo-default' : 'bg-kumo-recessed text-kumo-inactive'}`}
                      aria-hidden="true"
                    >
                      <Icon size={17} />
                    </span>
                    <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center">
                      <p className="flex min-w-0 items-center gap-2 text-[14px] font-medium leading-5 text-kumo-default">
                        <span className="min-w-0 truncate">{hook.description.title}</span>
                        {!hook.enabled && <span className="shrink-0 text-[13px] font-normal text-kumo-subtle">Paused</span>}
                      </p>
                      {detail && <p className="line-clamp-2 text-[13px] leading-[18px] text-kumo-subtle">{detail}</p>}
                    </div>
                    <div className="flex h-9 shrink-0 items-center gap-1">
                      <HookToggle
                        hookTitle={hook.description.title}
                        enabled={hook.enabled}
                        pending={togglingHooks.has(hook.id)}
                        onToggle={(enabled) => handleToggleHook(hook.id, enabled)}
                      />
                      <RowMenu label={hook.description.title} items={[
                        { label: 'Delete', icon: <TrashIcon size={14} />, danger: true, onClick: () => setDeleteHookTarget({ id: hook.id, title: hook.description.title }) },
                      ]} />
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>

      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        title="Remove connection?"
        description={<>This app stops being able to use <span className="font-medium text-kumo-default">{deleteTarget?.resourceTitle}</span>. Its code still names <span className="font-mono">env.{deleteTarget?.name}</span> until it&rsquo;s changed.</>}
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        onConfirm={() => void handleDeleteConfirm()}
      />
      <DeleteAutomationDialog
        title={deleteHookTarget?.title}
        open={deleteHookTarget !== null}
        isDeleting={false}
        onOpenChange={(open) => { if (!open) setDeleteHookTarget(null) }}
        onConfirm={() => void handleDeleteHookConfirm()}
      />

      <GatekeeperModal
        open={isNewConnectionModalVisible}
        onClose={() => setIsNewConnectionModalVisible(false)}
        getOverseer={() => overseer}
        spawnerEnvCandidates={spawnerEnvCandidates}
        onCreated={async (gk, gatekeeperId) => {
          gk[Symbol.dispose]()
          try {
            await bindConnection(gatekeeperId, chatId)
          } catch (err) {
            // Only the refusal and the browser losing its session are cured by the replacement
            // session. A flagged reset can come from downstream (the vendor's describe()) over a
            // healthy session that nothing replaces, so it stays with the modal like any other.
            const pendingRestart = getGatekeeperErrorCode(err) === GATEKEEPER_ERROR_CODES.pendingRestart
            if (!pendingRestart && classifyRpcError(err) !== 'connection') throw err
            console.debug('Binding the new connection once the session is replaced:', err)
            pendingBind.current = { gatekeeperId, chatId }
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

/** A row's More menu: its actions, the destructive one last. */
const RowMenu = ({ label, items }: {
  label: string
  items: { label: string; icon: ReactNode; danger?: boolean; onClick: () => void }[]
}) => (
  <DropdownMenu>
    <DropdownMenu.Trigger render={
      <button
        type="button"
        aria-label={`More for ${label}`}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring data-[popup-open]:bg-kumo-tint"
      >
        <MoreIcon size={16} />
      </button>
    } />
    <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
      {items.map(item => (
        <DropdownMenu.Item
          key={item.label}
          onClick={item.onClick}
          className={item.danger ? `${MENU_ITEM_DANGER} text-kumo-danger` : MENU_ITEM}
        >
          {item.icon}
          {item.label}
        </DropdownMenu.Item>
      ))}
    </DropdownMenu.Content>
  </DropdownMenu>
)

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
        <Dialog className="responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(480px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0" size="lg">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-5">
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

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
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

          <div className="shrink-0 border-t border-kumo-line px-4 py-3 sm:px-5">
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
