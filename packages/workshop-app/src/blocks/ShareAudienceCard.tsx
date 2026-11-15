import { useId } from 'react'
import { AppWindowIcon, CaretRightIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

export type ShareAudienceCardProps = {
  /** The gadget as the server last drew it; a blank stands in until then. */
  picture?: string
  /** Where the deployment lets people be given only a snapshot ("Can view"). */
  viewsAvailable: boolean
  /** How many hold it as "Can view". */
  viewers: number
  /** When its snapshot was taken, said as "5 min ago"; absent until one has been. */
  when?: string
  /** The last update to the snapshot failed, after `when`: viewers still see that one. */
  updateFailed?: boolean
  /** The services whose accounts someone using it live confirms they can see its data with. */
  services: string[]
  /** Opens what they see (`ShareAudiencePage`). */
  onOpen: () => void
}

const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`

const LIST = new Intl.ListFormat('en', { type: 'conjunction' })

/**
 * What the people a gadget is shared with will see of it, in a line under who has it, for one that
 * reads from connections: its picture, then who sees a snapshot and from when, or that it opens
 * live. It opens the page that shows them (`ShareAudiencePage`), the way the prototype's card does.
 */
export const ShareAudienceCard = ({ picture, viewsAvailable, viewers, when, updateFailed, services, onOpen }: ShareAudienceCardProps) => {
  const id = useId()
  const failed = updateFailed && viewers > 0
  const [title, detail] = viewsAvailable && viewers > 0
    ? ['Viewers see a snapshot', `${people(viewers)} · ${failed ? 'Couldn’t update' : when ? `from ${when}` : 'taken when you next open it'}`]
    : viewsAvailable
      ? ['What people see', 'A snapshot, or the gadget live']
      : ['People use it live', `Once they confirm their ${LIST.format(services)} ${services.length === 1 ? 'account' : 'accounts'}`]

  return (
    <button
      type="button"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-detail`}
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-2xl bg-kumo-base p-2 pe-3 text-left ring-1 ring-kumo-line outline-none hover:bg-kumo-tint/60 focus-visible:ring-2 focus-visible:ring-kumo-ring"
    >
      <span className="relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-kumo-tint ring-1 ring-kumo-line ring-inset">
        {picture
          ? <img src={picture} alt="" className="size-full object-cover object-top" />
          : <AppWindowIcon aria-hidden="true" className="size-4 text-kumo-subtle" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={`${id}-title`} className="truncate text-base/5 text-kumo-default">{title}</span>
        <span id={`${id}-detail`} className={cn('flex items-center gap-1 truncate text-sm', failed ? 'text-kumo-danger' : 'text-kumo-subtle')}>
          {failed && <WarningCircleIcon aria-hidden="true" weight="fill" className="size-3.5 shrink-0" />}
          {detail}
        </span>
      </span>
      <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
    </button>
  )
}
