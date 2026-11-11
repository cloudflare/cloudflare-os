import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react'
import { Collapsible } from '@cloudflare/kumo/primitives/collapsible'
import { cn } from '@cloudflare/kumo/utils'
import { XIcon } from '@phosphor-icons/react'
import '@/components/Arrival.css'
import { Button } from '@/components/Button'
import { MessageActions, MESSAGE_ACTION_STYLE } from './MessageActions'
import './MessageBubble.css'

/** Which neighbours a message forms a run with: the message before it, the one after, or both. */
export type MessageJoins = { above?: boolean; below?: boolean }

export type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'error'
  children: ReactNode
  /**
   * The neighbours from the same sender, for where bubbles are not siblings in the page and so
   * cannot find each other (a message list wraps every row). Sibling bubbles need not be told.
   */
  joins?: MessageJoins
  /**
   * What there is to know about the message (see `MessageInfo`), in an outlined panel below it while open.
   * Controlled, so it can outlive the message being unmounted (a virtual list does that).
   */
  details?: MessageDetails
}

export type MessageDetails = {
  open: boolean
  onToggle: () => void
  content: ReactNode
  /** Metadata without a trace only needs as much width as its contents. */
  fitContent?: boolean
}

const BUBBLE = {
  user: 'bg-kumo-contrast text-kumo-inverse whitespace-pre-wrap',
  assistant: 'bg-kumo-fill text-kumo-default',
  error: 'bg-kumo-danger-tint text-kumo-danger',
} as const

// Consecutive messages from one sender read as a run: the row moves closer to the one above (the
// feed's `gap-2` is 8px, so -mt-1.5 leaves 2px) and the corners where two bubbles meet shrink, on the
// side the bubbles are aligned to. Per role and in full, because CSS cannot match "same role" between
// siblings generically and Tailwind only picks up class names it can read as literal strings.
// `JOINED` is the same for a bubble that was told its neighbours instead of finding them.
const RUN = {
  user: {
    row: '[[data-role=user]+&]:-mt-1.5',
    bubble:
      '[[data-role=user]+[data-role=user]>&]:rounded-tr-md ' +
      '[[data-role=user]:has(+[data-role=user])>&]:rounded-br-md',
    details: '[[data-role=user]:has(+[data-role=user])_&]:rounded-br-md',
  },
  assistant: {
    row: '[[data-role=assistant]+&]:-mt-1.5',
    bubble:
      '[[data-role=assistant]+[data-role=assistant]>&]:rounded-tl-md ' +
      '[[data-role=assistant]:has(+[data-role=assistant])>&]:rounded-bl-md',
    details: '[[data-role=assistant]:has(+[data-role=assistant])_&]:rounded-bl-md',
  },
  error: {
    row: '[[data-role=error]+&]:-mt-1.5',
    bubble:
      '[[data-role=error]+[data-role=error]>&]:rounded-tl-md ' +
      '[[data-role=error]:has(+[data-role=error])>&]:rounded-bl-md',
    details: '[[data-role=error]:has(+[data-role=error])_&]:rounded-bl-md',
  },
} as const

const JOINED = {
  user: { above: 'rounded-tr-md', below: 'rounded-br-md' },
  assistant: { above: 'rounded-tl-md', below: 'rounded-bl-md' },
  error: { above: 'rounded-tl-md', below: 'rounded-bl-md' },
} as const

// Beside a bubble (the message, or its details), on the side the row has room, level with its
// middle. They are there all along, so showing them moves nothing, and show while the bubble or the
// place they are in is pointed at, or one of them was reached by keyboard; the rest of the row does
// not bring them up, and nor does having clicked one. They touch the bubble (the gap is their own
// padding), so the pointer crosses to them without leaving both.
const BESIDE = 'absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity motion-reduce:transition-none has-[:focus-visible]:opacity-100'
const ACTIONS = `${BESIDE} group-hover/message:opacity-100`
const CLOSE = `${BESIDE} group-hover/details:opacity-100`

/**
 * One chat message: the user's on the right in a dark bubble, the assistant's and errors on the left.
 * What can be done with a message shows beside it while it is pointed at (see `MessageActions`);
 * its details, when asked for, unfold in an outlined panel beneath it.
 * Neighbouring messages from the same sender tuck together (see `RUN`). One that has just arrived
 * grows in (see Arrival.css), settling into the run it joins (see MessageBubble.css).
 */
export const MessageBubble = ({ role, children, joins, details }: MessageBubbleProps) => {
  const detailsId = useId()
  const actions = <MessageActions details={details && { ...details, controls: detailsId }} />

  // The shell owns the text, its actions and its details. A click elsewhere puts the details away,
  // including the blank stretch of the message's row.
  //
  // On the click, not the press: closing moves what is below, and a button that moved between the
  // press and the release would not be clicked at all. That is what asking for another message's
  // details is, and this way the one closes and the other opens together.
  const bubble = useRef<HTMLDivElement>(null)
  const open = details?.open ?? false
  const clickElsewhere = useEffectEvent(({ target }: MouseEvent) => {
    if (target instanceof Node && bubble.current?.contains(target)) return
    details?.onToggle()
  })
  useEffect(() => {
    if (!open) return
    document.addEventListener('click', clickElsewhere)
    return () => document.removeEventListener('click', clickElsewhere)
  }, [open])

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={() => details?.onToggle()}
      data-role={role}
      className={cn('flex items-start [container-type:inline-size]', role === 'user' ? 'justify-end' : 'justify-start', RUN[role].row, joins?.above && '-mt-1.5')}
    >
      <div
        ref={bubble}
        className={cn(
          'arrives message-bubble max-w-[min(70%,65ch)] rounded-[21px] text-base/5 break-words',
          // It grows in downwards, as the conversation does, from its sender's side.
          role === 'user' ? 'origin-top-right' : 'origin-top-left',
          'transition-[border-radius] duration-300 ease-out motion-reduce:transition-none',
          RUN[role].bubble,
          joins?.above && JOINED[role].above,
          joins?.below && JOINED[role].below,
        )}
      >
        <div className={cn(
          'group/message relative rounded-[inherit] px-5 py-[11px] transition-[border-radius] duration-300 ease-out motion-reduce:transition-none',
          BUBBLE[role],
          open && JOINED[role].below,
        )}>
          {children}
          {role === 'user' && <div className={cn(ACTIONS, 'right-full pe-2')}>{actions}</div>}
          {role === 'assistant' && <div className={cn(ACTIONS, 'left-full ps-2')}>{actions}</div>}
        </div>
        {/* The wrapper keeps details out of the message's intrinsic width. Metadata can be narrower
            or wider than a short bubble, but is capped to the row's width; traces match the bubble. */}
        {details && (
          <div className={cn('flex flex-col [contain:inline-size]', role === 'user' ? 'items-end' : 'items-start')}>
            <div className={cn('group/details relative', details.fitContent ? 'w-max max-w-[calc(100cqw_-_2.25rem)]' : 'w-full')}>
              <Collapsible.Panel
                id={detailsId}
                data-message-details=""
                inert={!open}
                className="message-details text-kumo-default whitespace-normal"
              >
                <div className="pt-0.5">
                  <div className={cn(
                    'message-details-surface rounded-[21px] bg-kumo-base px-5 py-3 ring-1 ring-inset ring-kumo-line',
                    role === 'user' ? 'origin-top-right' : 'origin-top-left',
                    JOINED[role].above,
                    RUN[role].details,
                    joins?.below && JOINED[role].below,
                  )}>
                    {details.content}
                  </div>
                </div>
              </Collapsible.Panel>
              {open && (
                <div className={cn(CLOSE, role === 'user' ? 'right-full pe-2' : 'left-full ps-2')}>
                  {/* A cross this size reads thinner than the outlined icons beside a message, so it
                      is drawn smaller and heavier to weigh the same. */}
                  <Button
                    variant="ghost"
                    icon={<XIcon weight="bold" />}
                    aria-label="Close details"
                    title="Close details"
                    className={`${MESSAGE_ACTION_STYLE} [&>svg]:size-3`}
                    onClick={details.onToggle}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Collapsible.Root>
  )
}
