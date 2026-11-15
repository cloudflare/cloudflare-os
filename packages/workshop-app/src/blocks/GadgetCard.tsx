import type { ReactElement, Ref } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { CARD, CardHead, SHEET } from './FanCard'
import { WaitingLabel } from './LibraryRow'

export type GadgetCardProps = {
  title: string
  /** What it is, drawn by its format's icon. */
  icon: ReactElement
  /** Its screen, once drawn. */
  picture?: string
  /** Where it is, under its name: its workspace, or who shared it. */
  detail?: string
  /** How many changes it has waiting on the viewer to approve, said in place of `detail`. */
  waiting?: number
  href?: string
  onOpen: () => void
  /** Where it falls in the row, for coming in a beat after the one before. */
  index?: number
  /** Watched for coming near the screen, when its picture is fetched. */
  ref?: Ref<HTMLDivElement>
}

/**
 * One of the user's gadgets, as Home offers it to open again, drawn as Home's blueprints are: its
 * name, and under it where it is, or how many of its changes wait on the viewer to approve, then
 * its screen, a sheet standing up out of the card's foot that rises a little when pointed at.
 */
export const GadgetCard = ({ title, icon, picture, detail, waiting, href, onOpen, index = 0, ref }: GadgetCardProps) => (
  <div ref={ref} className="min-w-0">
    <LinkButton
      href={href}
      onClick={onOpen}
      title={[title, waiting ? `${waiting} to approve` : detail].filter(Boolean).join(', ')}
      style={{ animationDelay: `${index * 60}ms` }}
      className={CARD}
    >
      <CardHead icon={icon} title={title} detail={waiting ? <WaitingLabel count={waiting} className="gap-1" /> : detail} />
      <span className={cn(SHEET, 'absolute inset-x-3 top-[3.625rem] -bottom-3 transition-[translate,box-shadow] duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-[0_2px_4px_rgb(0_0_0/0.08),0_12px_24px_-8px_rgb(0_0_0/0.18)] motion-reduce:transition-none')}>
        {picture ? (
          <img src={picture} alt="" className="size-full object-cover object-top" />
        ) : (
          <span aria-hidden="true" className="grid size-full place-items-center text-kumo-subtle [&>svg]:size-6">{icon}</span>
        )}
      </span>
    </LinkButton>
  </div>
)
