import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CameraIcon, EyeIcon, LightningIcon, WarningIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, GadgetClient, GatekeeperVendorInfo, ObserverBindingNeed, Overseer, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import GadgetUI from '../../GadgetUI'
import ResourceList from './ResourceList'
import { viewMoment, viewTimestamp } from './viewTime'

// The width the preview lays the gadget out at, scaled to the dialog's: a desktop window, so the
// owner sees the layout people on one get rather than the phone layout the dialog's width would.
const VIEW_WIDTH = 1280
// How much of the top of the view the preview shows, as a share of its width.
const PREVIEW_ASPECT = 0.42

/**
 * The view itself, as people get it: the gadget's UI run against the view's copy, inert and at
 * the dialog's width. Never an illustration. It shows the top of the page, where a dashboard's
 * headline numbers sit. Opening it takes the view when there is none, so it shows before the
 * gadget is first shared.
 */
const ViewPreview = ({ overseer, gadgetId, takenAt }: {
  overseer: RpcStub<Overseer>
  gadgetId: WorkpieceId
  /** Reopens when the view is replaced. */
  takenAt: Date | undefined
}) => {
  // Wrapped: a stub in state would be taken for an updater (see the repository's RPC rules).
  const [view, setView] = useState<{ client: RpcStub<GadgetClient> } | null>(null)
  const [width, setWidth] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let gone = false
    let client: RpcStub<GadgetClient> | null = null
    const gadget = overseer.getGadget(gadgetId)
    gadget.openView().then(opened => {
      if (gone) opened[Symbol.dispose]()
      else setView({ client: client = opened })
    }, () => {})
    return () => {
      gone = true
      setView(null)
      client?.[Symbol.dispose]()
      gadget[Symbol.dispose]()
    }
  }, [overseer, gadgetId, takenAt])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const scale = width / VIEW_WIDTH
  return (
    <div
      ref={ref}
      aria-hidden
      className="relative w-full overflow-hidden bg-kumo-tint"
      style={{ aspectRatio: `1 / ${PREVIEW_ASPECT}` }}
    >
      {view && width > 0 && (
        <div
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{ width: VIEW_WIDTH, height: VIEW_WIDTH * PREVIEW_ASPECT, transform: `scale(${scale})` }}
        >
          <GadgetUI gadget={view.client} height="100%" isVisible={true} />
        </div>
      )}
    </div>
  )
}

type Props = {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  gadgetId: WorkpieceId
  commitId?: string
  viewTakenAt?: Date
  viewUpdateFailedAt?: Date
  /** What the gadget reads, or null while it loads or if it couldn't be listed. */
  requirements: ObserverBindingNeed[] | null
  /** The requirements couldn't be listed. */
  requirementsFailed: boolean
}

/**
 * One kind of person and what they get, as a row in the share dialog's people list: a round icon
 * where a person's avatar would be, with anything they need beneath the text.
 */
const Tier = ({ icon, title, description, children }: {
  icon: ReactNode
  title: string
  description: string
  children?: ReactNode
}) => (
  <li className="flex gap-3 py-2.5 pl-1.5">
    <span aria-hidden className="grid size-[26px] shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-default">
      {icon}
    </span>
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="text-sm leading-[22px] tracking-[-0.25px] text-kumo-default">{title}</span>
      <span className="text-xs leading-[18px] text-kumo-subtle">{description}</span>
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  </li>
)

/**
 * The body of the share dialog's "What people see": the snapshot itself, then the two kinds of
 * people and what each gets, the second with the resources that admit them. Everyone sees the
 * snapshot; people with access to those resources use the gadget live, still on the owner's
 * connections. The owner never manages the snapshot; it is retaken as the gadget is opened.
 */
export const WhatPeopleSee = ({
  overseer, authenticatedApi, gadgetId, commitId, viewTakenAt, viewUpdateFailedAt,
  requirements, requirementsFailed,
}: Props) => {
  // Whether the gadget has a screen to take a view of; null while that is checked.
  const [hasScreen, setHasScreen] = useState<boolean | null>(null)
  const [vendors, setVendors] = useState<Map<string, GatekeeperVendorInfo>>(new Map())

  useEffect(() => {
    let cancelled = false
    Promise.all([authenticatedApi.listGatekeeperVendors(), authenticatedApi.listAddableGatekeepers()])
      .then(([connected, addable]) => {
        if (!cancelled) setVendors(new Map([...connected, ...addable].map(v => [v.id, v])))
      }, () => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    if (commitId === undefined) {
      setHasScreen(false)
      return
    }
    let cancelled = false
    overseer.listTree(commitId).then(tree => {
      const names = new Set(tree.map(node => node.name))
      if (!cancelled) setHasScreen(names.has('client.js') && names.has('server.js'))
    }, () => { if (!cancelled) setHasScreen(true) })
    return () => { cancelled = true }
  }, [overseer, commitId])

  // Whether anyone has something to verify (or it couldn't be listed, which the list says).
  const verifies = requirementsFailed || (requirements?.length ?? 0) > 0
  const failedSinceView = viewUpdateFailedAt !== undefined &&
    (viewTakenAt === undefined || viewUpdateFailedAt > viewTakenAt)
  const when = viewTakenAt ? viewMoment(viewTakenAt, new Date(), ' at ') : ''

  return (
    <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-none px-4 pb-6 sm:px-6">
      {hasScreen !== false && (
        <figure className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
          {/* Opening it takes the view if there is none yet, so it is real before any share. */}
          <ViewPreview overseer={overseer} gadgetId={gadgetId} takenAt={viewTakenAt} />
          {(viewTakenAt || failedSinceView) && (
            <figcaption className="flex flex-col gap-0.5 border-t border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
              {viewTakenAt && <span title={viewTimestamp(viewTakenAt)}>Snapshot · Updated {when}</span>}
              {failedSinceView && (
                <span className="flex items-center gap-1">
                  <WarningIcon aria-hidden size={12} className="shrink-0" />
                  {viewTakenAt
                    ? `Couldn’t update it. People see the one from ${when}.`
                    : 'Couldn’t take it.'}
                </span>
              )}
            </figcaption>
          )}
        </figure>
      )}

      <ul aria-label="What people get" className="mt-3">
        {hasScreen === false ? (
          <Tier
            icon={<CameraIcon size={13} />}
            title="No snapshot"
            description="This gadget has no screen, so only people with access to these can open it."
          />
        ) : (
          <Tier
            icon={<EyeIcon size={13} />}
            title="Everyone you share with"
            description="Sees an up-to-date snapshot of it, with your data."
          />
        )}
        {verifies && (
          <>
            {hasScreen !== false && (
              <li aria-hidden className="my-1 border-b border-dashed border-kumo-line" />
            )}
            <Tier
              icon={<LightningIcon size={13} />}
              title="People with access to these"
              description={hasScreen === false
                ? 'Can open it and use it with you.'
                : 'Can use it live, alongside you.'}
            >
              {requirementsFailed || !requirements ? (
                <p role="status" className="py-2 text-xs text-kumo-subtle">
                  Couldn’t list what it uses.
                </p>
              ) : (
                <ResourceList
                  label="What they need access to"
                  fold
                  items={requirements.map(need => {
                    const vendor = vendors.get(need.vendorId)
                    return {
                      key: need.gatekeeperId,
                      title: need.resourceTitle,
                      vendorName: vendor?.description.displayName || need.vendorId,
                      logoUrl: vendor?.description.logo?.url,
                      logoBackground: vendor?.description.color,
                      url: need.resourceUrl || undefined,
                    }
                  })}
                />
              )}
              <p className="mt-1 text-xs leading-[18px] text-kumo-subtle">
                They sign in only to confirm access. It still runs on your connections.
              </p>
            </Tier>
          </>
        )}
      </ul>
    </div>
  )
}
