import type { ReactNode, Ref } from 'react'
import { EyeIcon, LightningIcon, ArrowClockwiseIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { ServiceLogo } from '@/components/ServiceLogo'
import { GadgetFrame } from './GadgetFrame'

/** The owner's view, as it loads into a page for a frame. */
export type ShareViewPreview =
  | { status: 'loading' }
  /** `load` is different each time it is loaded, for a frame made again with it. */
  | { status: 'ready'; page: string; load: number }
  /** The gadget has no screen, so there is nothing to show. */
  | { status: 'none' }
  | { status: 'failed'; message: string }
  | { status: 'denied' }

/** A connection the gadget reads from, which someone using it live confirms their access to. */
export type ShareAudienceResource = {
  key: string
  title: string
  /** The service it is reached through, as its logo names it. */
  service: { name: string; logoUrl?: string; color?: string }
}

export type ShareAudiencePageProps = {
  /** What the gadget is called, as the preview's frame is named. */
  title: string
  /** The owner's view, running; absent where the deployment gives no snapshots. */
  preview?: ShareViewPreview
  frameRef?: Ref<HTMLIFrameElement>
  /** Loads the view again, after it failed. */
  onReload?: () => void
  /** When the snapshot was taken, said as "5 min ago"; absent until one has been. */
  when?: string
  /** The last update failed, so viewers still see the one from `when`. */
  updateFailed?: boolean
  resources: ShareAudienceResource[]
}

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

// The view is laid out larger than the stage and drawn smaller (Max’s 0.6): a page made for a window
// reads as itself, rather than squeezed into the dialog's width.
const SCALE = 0.6

const Tier = ({ icon: Icon, title, children }: { icon: typeof EyeIcon; title: string; children: ReactNode }) => (
  <div className="flex gap-3 py-3">
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-subtle ring-1 ring-kumo-line ring-inset">
      <Icon className="size-4" />
    </span>
    <div className="min-w-0 flex-1">
      <p className="text-base/5 font-medium text-kumo-default">{title}</p>
      {children}
    </div>
  </div>
)

const StageNotice = ({ children }: { children: ReactNode }) => (
  <div className="grid size-full place-items-center px-6 text-center text-sm/5 text-kumo-subtle">{children}</div>
)

/**
 * What the people a gadget is shared with see, on a page of the share dialog of its own: the
 * snapshot "Can view" opens, running as they get it (the owner's view, taken again as this opens),
 * drawn smaller so that a page made for a window reads as itself, and usable, as theirs is,
 * since anything done in it is gone when it is next taken. Under it, each way of holding the
 * gadget: a snapshot that reaches nothing, or the gadget live, with the owner's data, once the
 * person confirms with their own account on each service that they can see what it reads.
 */
export const ShareAudiencePage = ({ title, preview, frameRef, onReload, when, updateFailed, resources }: ShareAudiencePageProps) => {
  const services = [...new Set(resources.map(({ service }) => service.name))]
  const accounts = `${LIST.format(services)} ${services.length === 1 ? 'account' : 'accounts'}`
  return (
    <div className="appears flex flex-col">
      {preview && (
        <figure className="flex flex-col gap-2">
          <div className="relative aspect-[16/10] overflow-hidden rounded-2xl bg-kumo-tint ring-1 ring-kumo-line">
            {preview.status === 'ready' ? (
              <div
                className="absolute start-0 top-0 flex origin-top-left flex-col bg-kumo-base"
                style={{ width: `${100 / SCALE}%`, height: `${100 / SCALE}%`, transform: `scale(${SCALE})` }}
              >
                <GadgetFrame key={preview.load} ref={frameRef} page={preview.page} title={`${title}, as people see it`} />
              </div>
            ) : preview.status === 'failed' ? (
              <StageNotice>
                <span className="flex flex-col items-center gap-2">
                  Couldn’t show the snapshot. {preview.message}
                  {onReload && <Button icon={ArrowClockwiseIcon} onClick={onReload}>Try again</Button>}
                </span>
              </StageNotice>
            ) : preview.status === 'loading' ? (
              <StageNotice><span role="status" className="appears-late">Taking a snapshot…</span></StageNotice>
            ) : (
              <StageNotice>It has no screen, so there’s nothing to show.</StageNotice>
            )}
          </div>
          <figcaption className="px-1 text-sm/5 text-kumo-subtle">
            {updateFailed && when
              ? <span className="text-kumo-danger">The last update didn’t go through, so viewers see the one from {when}.</span>
              : <>What people who can view see{when ? `, as of ${when}` : ''}. Try it: anything you change here is undone when it’s next taken.</>}
          </figcaption>
        </figure>
      )}
      <div className="divide-y divide-dashed divide-kumo-line">
        {preview && (
          <Tier icon={EyeIcon} title="Can view">
            <p className="mt-0.5 text-sm/5 text-kumo-subtle">
              A copy of your data, taken again each time you open the gadget. It reaches nothing of yours, so nothing is asked of them.
            </p>
          </Tier>
        )}
        <Tier icon={LightningIcon} title="Can use">
          <p className="mt-0.5 text-sm/5 text-kumo-subtle">
            {resources.length === 0
              ? 'The gadget live, with your data, as you use it. It reads from nothing that needs an account of theirs.'
              : `The gadget live, with your data, once they confirm with their own ${accounts} that they can see what it reads:`}
          </p>
          {resources.length > 0 && <ul className="mt-2 flex max-h-36 flex-col gap-2 overflow-y-auto">
            {resources.map((resource) => (
              <li key={resource.key} className="flex min-w-0 items-center gap-2.5">
                <ServiceLogo name={resource.service.name} src={resource.service.logoUrl} color={resource.service.color} />
                <span className="min-w-0 flex-1 truncate text-base/5 text-kumo-default">{resource.title}</span>
              </li>
            ))}
          </ul>}
        </Tier>
      </div>
    </div>
  )
}
