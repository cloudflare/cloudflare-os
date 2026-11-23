import { ArrowRight01Icon, PlusSignIcon } from '@/components/icons'

export type ConnectionMarkProps = {
  /** An account that is connected, which opens, rather than a service that could be, which is added. */
  connected?: boolean
}

/**
 * What is at the end of a listed service: a plus on one that could be connected, a chevron on an
 * account that is. It is no button of its own: all of the card or the row it is on (its `group`)
 * is, so it is quiet until that is pointed at.
 */
export const ConnectionMark = ({ connected = false }: ConnectionMarkProps) => (
  <span
    aria-hidden="true"
    className="grid size-(--control-size) shrink-0 place-items-center text-(length:--control-text) text-kumo-subtle group-hover:text-kumo-default group-focus-visible:text-kumo-default [&>svg]:size-[1.125em]"
  >
    {connected ? <ArrowRight01Icon /> : <PlusSignIcon />}
  </span>
)
