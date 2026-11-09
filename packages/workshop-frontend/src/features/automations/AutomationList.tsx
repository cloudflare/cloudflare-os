import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import type { RpcStub } from 'capnweb'
import type { BoundHookInfo, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { AutomationIcon } from '../../components/icons/designIcons'
import { hookToggleFailureToast } from '../../components/HookToggle'
import { useActionEntries } from '../../useActions'
import { reportIssue } from '../../errorReporting'
import { logRpcFailure } from '../../rpcErrors'
import { AutomationCard, isScheduleUrl } from './AutomationCard'

/**
 * Whose automations: a chat's, or an app's, which run its code. A chat's are those that wake it,
 * and those that run the apps it built (`gadgetIds`): someone who asked a chat for an automation
 * finds it there, whether or not the chat wrote an app to carry it out. An automation that wakes a
 * chat names an app only for bookkeeping, so it is that chat's alone.
 */
export type AutomationScope =
  | { chatId: number, gadgetIds?: readonly WorkpieceId[] }
  | { gadgetId: WorkpieceId }
  | 'workspace'

const inScope = (scope: AutomationScope) => (hook: BoundHookInfo) =>
  scope === 'workspace' ? true
    : 'chatId' in scope ? hook.chatId === scope.chatId
      || (hook.chatId === undefined && (scope.gadgetIds ?? []).includes(hook.gadgetId))
    : hook.chatId === undefined && hook.gadgetId === scope.gadgetId

/**
 * The automations of a chat or an app, with each one's switch and delete. Kept fresh by the action log, where every hook bound, toggled or deleted lands, so one
 * turned on in a chat shows here without a reload.
 */
export function useAutomations(overseer: RpcStub<Overseer>, scope: AutomationScope) {
  const [hooks, setHooks] = useState<BoundHookInfo[] | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set())
  const [deleting, setDeleting] = useState<BoundHookInfo | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const toasts = useKumoToastManager()
  // Primitive deps, so a caller's fresh scope object doesn't reload the list on every render.
  const scopeKey = scope === 'workspace' ? scope
    : 'chatId' in scope ? `chat:${scope.chatId}:${(scope.gadgetIds ?? []).join(',')}`
    : `app:${scope.gadgetId}`
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const load = useCallback(async () => {
    try {
      const all = await overseer.listHooks()
      setHooks(all.filter(inScope(scopeRef.current)))
    } catch (err) {
      if (logRpcFailure('Failed to load automations:', err)) return
      reportIssue('automations.load', err)
      setHooks(prev => prev ?? [])
    }
  }, [overseer, scopeKey])

  useEffect(() => { void load() }, [load])
  useActionEntries(overseer, record => { if (record.type === 'bindHook') void load() })

  const toggle = async (hook: BoundHookInfo, enabled: boolean) => {
    setHooks(prev => prev?.map(h => h.id === hook.id ? { ...h, enabled } : h) ?? prev)
    setBusy(prev => new Set(prev).add(hook.id))
    try {
      if (enabled) await overseer.enableHook(hook.id)
      else await overseer.disableHook(hook.id)
    } catch (err) {
      console.error('Failed to toggle automation:', err)
      toasts.add(hookToggleFailureToast(enabled, err))
      setHooks(prev => prev?.map(h => h.id === hook.id ? { ...h, enabled: !enabled } : h) ?? prev)
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(hook.id); return next })
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteBusy(true)
    try {
      await overseer.deleteHook(deleting.id)
      setHooks(prev => prev?.filter(h => h.id !== deleting.id) ?? prev)
      setDeleting(null)
    } catch (err) {
      console.error('Failed to delete automation:', err)
      toasts.add({ title: "Couldn't delete the automation", variant: 'error' })
    } finally {
      setDeleteBusy(false)
    }
  }

  const dialog = (
    <DeleteAutomationDialog
      title={deleting?.description.title}
      open={deleting !== null}
      isDeleting={deleteBusy}
      onOpenChange={open => { if (!open) setDeleting(null) }}
      onConfirm={() => void confirmDelete()}
    />
  )
  return { hooks, busy, toggle, requestDelete: setDeleting, dialog }
}

/** Asks before deleting an automation, which can't be brought back. */
export function DeleteAutomationDialog({ title, ...props }: {
  title: string | undefined
  open: boolean
  isDeleting: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <DeleteConfirmationDialog
      {...props}
      title="Delete automation?"
      description={<><span className="font-medium text-kumo-default">{title}</span> stops for good. To stop it for a while, pause it instead.</>}
    />
  )
}

// As the composer's attachment tray moves: a card scales in or out about its centre and the
// others slide into the space it leaves.
const CARD_TRANSITION = { duration: 0.18, ease: [0.25, 0.1, 0.25, 1] } as const
const CARD_HIDDEN = { opacity: 0, scale: 0.96 }
const CARD_SHOWN = { opacity: 1, scale: 1 }

/**
 * A tab of automations: each as a card, or, when there are none, how to make one, which is to ask
 * for it in a chat.
 */
export function AutomationList({ overseer, scope, empty, originOf }: {
  overseer: RpcStub<Overseer>
  scope: AutomationScope
  /** Where each one belongs, for a list of the whole workspace's. */
  originOf?: (hook: BoundHookInfo) => ReactNode
  /** What to say when there are none. Without it, an empty list shows nothing at all. */
  empty?: ReactNode
}) {
  const { hooks, busy, toggle, requestDelete, dialog } = useAutomations(overseer, scope)
  if (empty === undefined && !hooks?.length) return null
  if (hooks === null) {
    return (
      <div className="flex justify-center py-16">
        <div className="size-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
      </div>
    )
  }
  return (
    <>
      {hooks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-kumo-tint text-kumo-default" aria-hidden="true">
            <AutomationIcon size={16} />
          </span>
          <p className="text-[14px] font-medium leading-5 text-kumo-default">No automations yet</p>
          <p className="max-w-[360px] text-[13px] leading-[18px] text-kumo-subtle">{empty}</p>
        </div>
      ) : (
        <MotionConfig reducedMotion="user" transition={CARD_TRANSITION}>
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {hooks.map(hook => (
                <motion.div key={hook.id} layout="position" initial={CARD_HIDDEN} animate={CARD_SHOWN} exit={CARD_HIDDEN}>
                  <AutomationCard
                    className="!max-w-none"
                    title={hook.description.title}
                    description={hook.description.description}
                    schedule={isScheduleUrl(hook.resourceUrl)}
                    source={hook.resourceTitle}
                    origin={originOf?.(hook)}
                    enabled={hook.enabled}
                    busy={busy.has(hook.id)}
                    onToggle={enabled => void toggle(hook, enabled)}
                    onDelete={() => requestDelete(hook)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </MotionConfig>
      )}
      {dialog}
    </>
  )
}
