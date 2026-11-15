import { useId, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AppWindowIcon, CaretRightIcon, EyeIcon, LightningIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { ServiceLogo } from '@/components/ServiceLogo'

/** A connection the gadget reads from, which someone using it live reaches with an account of their own. */
export type ShareAudienceResource = {
  key: string
  title: string
  /** The service it is reached through, as its logo names it. */
  service: { name: string; logoUrl?: string; color?: string }
}

export type ShareAudienceCardProps = {
  /** The gadget as the server last drew it, which is what a snapshot shows; a blank stands in until then. */
  picture?: string
  /** Where the deployment lets people be given only a snapshot ("Can view"). */
  viewsAvailable: boolean
  /** How many hold it as "Can view". */
  viewers: number
  /** When the owner last opened it, which is the snapshot viewers see. */
  takenAt?: Date
  /** The last update to the snapshot failed, after `takenAt`: viewers still see that one. */
  updateFailed?: boolean
  /** Said of `takenAt`, as "5 min ago". */
  when?: string
  resources: ShareAudienceResource[]
  /** Starts open, as for the gallery. */
  defaultOpen?: boolean
}

const EASE = [0.25, 0.1, 0.25, 1] as const

const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`

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

/**
 * What the people a gadget is shared with will see of it, for one that reads from connections: its
 * picture, and in a line, who sees a snapshot and who uses it live. Opened, the picture large and
 * each way of holding it: "Can view" sees a snapshot of the owner's data as they last left it and
 * reaches nothing; "Can use" opens it live, reaching each connection with an account of their own.
 */
export const ShareAudienceCard = ({ picture, viewsAvailable, viewers, takenAt, updateFailed, when, resources, defaultOpen = false }: ShareAudienceCardProps) => {
  const [open, setOpen] = useState(defaultOpen)
  const reduced = useReducedMotion()
  const id = useId()
  const transition = reduced ? { duration: 0 } : { duration: 0.24, ease: EASE }
  const services = [...new Set(resources.map(({ service }) => service.name))]
  const accounts = `${services.join(', ')} ${services.length === 1 ? 'account' : 'accounts'}`

  const [title, detail] = viewsAvailable && viewers > 0
    ? ['Viewers see a snapshot', `${people(viewers)} · ${updateFailed ? 'Couldn’t update' : takenAt ? `from ${when}` : 'taken when you next open it'}`]
    : viewsAvailable
      ? ['What people see', 'A snapshot, or live with their own accounts']
      : ['People use it live', `With their own ${accounts}`]

  return (
    <section aria-labelledby={`${id}-title`} className="overflow-hidden rounded-2xl bg-kumo-base ring-1 ring-kumo-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={() => setOpen((current) => !current)}
        className="group flex w-full items-center gap-3 p-2 pe-3 text-left outline-none hover:bg-kumo-tint/60 focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-inset"
      >
        <span className="relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-kumo-tint ring-1 ring-kumo-line ring-inset">
          {picture
            ? <img src={picture} alt="" className="size-full object-cover object-top" />
            : <AppWindowIcon aria-hidden="true" className="size-4 text-kumo-subtle" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-title`} className="truncate text-base/5 text-kumo-default">{title}</span>
          <span className={cn('flex items-center gap-1 truncate text-sm', updateFailed && viewers > 0 ? 'text-kumo-danger' : 'text-kumo-subtle')}>
            {updateFailed && viewers > 0 && <WarningCircleIcon aria-hidden="true" weight="fill" className="size-3.5 shrink-0" />}
            {detail}
          </span>
        </span>
        <CaretRightIcon
          aria-hidden="true"
          weight="bold"
          className={cn('size-3.5 shrink-0 text-kumo-subtle transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-90')}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="detail"
            id={`${id}-detail`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <div className="px-3 pb-1">
              {/* Until the server has drawn it, there is nothing to show large. */}
              {picture && (
              <figure className="relative mt-1 aspect-[16/10] overflow-hidden rounded-xl bg-kumo-tint ring-1 ring-kumo-line ring-inset">
                <img src={picture} alt="The gadget, as people you share it with see it" className="size-full object-cover object-top" />
                {viewsAvailable && (
                  <figcaption className="absolute start-2 bottom-2 rounded-full bg-kumo-base/90 px-2.5 py-1 text-xs text-kumo-default ring-1 ring-kumo-line backdrop-blur-sm">
                    {takenAt ? `Snapshot from ${when}` : 'Snapshot taken when you next open it'}
                  </figcaption>
                )}
              </figure>
              )}
              <div className="divide-y divide-dashed divide-kumo-line">
                {viewsAvailable && (
                  <Tier icon={EyeIcon} title="Can view">
                    <p className="mt-0.5 text-sm text-kumo-subtle">
                      Sees a snapshot: your data as you last left it{takenAt ? `, ${when}` : ''}, updated each time you open it. It reaches nothing, so nothing is asked of them.
                    </p>
                    {updateFailed && (
                      <p className="mt-1 text-sm text-kumo-danger">The last update didn’t go through, so they still see the one from {when}.</p>
                    )}
                  </Tier>
                )}
                <Tier icon={LightningIcon} title="Can use">
                  <p className="mt-0.5 text-sm text-kumo-subtle">Opens it live, with their own accounts, connected the first time:</p>
                  <ul className="mt-2 flex max-h-36 flex-col gap-2 overflow-y-auto">
                    {resources.map((resource) => (
                      <li key={resource.key} className="flex min-w-0 items-center gap-2.5">
                        <ServiceLogo name={resource.service.name} src={resource.service.logoUrl} color={resource.service.color} />
                        <span className="min-w-0 flex-1 truncate text-base/5 text-kumo-default">{resource.title}</span>
                        <span className="shrink-0 text-sm text-kumo-subtle">{resource.service.name}</span>
                      </li>
                    ))}
                  </ul>
                </Tier>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
