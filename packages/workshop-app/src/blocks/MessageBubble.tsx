import { useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { ArrowUp01Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import '@/components/Arrival.css'
import { Button } from '@gadgets/ui'
import { MessageScrollContext } from './messageScroll'
import { MessageActions, MESSAGE_ACTION_STYLE, type MessageActionsProps } from './MessageActions'
import './MessageBubble.css'
import { useDetailsStage } from './useDetailsStage'

/** Which neighbours a message forms a run with: the message before it, the one after, or both. */
export type MessageJoins = { above?: boolean; below?: boolean }

export type MessageBubbleProps = {
  role: 'user' | 'assistant' | 'error'
  children: ReactNode
  /**
   * It holds files rather than words: inset only enough to keep them off its edge, so that a
   * `rounded-2xl` tile's corners follow the bubble's.
   */
  media?: boolean
  /**
   * It holds a live view the agent drew (`InlineView`): an outlined surface of the page's own
   * colour, which the view's colours are chosen against, as wide as there is room for beside its
   * actions, rather than a bubble of the sender's.
   */
  view?: boolean
  /**
   * The neighbours from the same sender, for where bubbles are not siblings in the page and so
   * cannot find each other (a message list wraps every row). Sibling bubbles need not be told.
   */
  joins?: MessageJoins
  /** Start a reply to the message. */
  onReply?: () => void
  /** What copying the message puts on the clipboard. */
  copyText?: string
  /** In developer mode, what else more can copy (see `MessageActions`). */
  developerCopies?: MessageActionsProps['developerCopies']
  /** Marks the chat unread from this message on, from more. Left out where it is not the viewer's to mark. */
  onMarkUnread?: () => void
  /**
   * What there is to know about the message (see `messageInfo`), in an outlined panel below it while open:
   * a click on the message shows it and puts it away, as in other messaging apps.
   * Controlled, so it can outlive the message being unmounted (a virtual list does that).
   */
  details?: MessageDetails
  /**
   * The way to show and put away how the message came about, which is a button among its actions. Hand it
   * to the bubble that has them, and `trace` to the one it is shown above, which may be another.
   */
  thinking?: { open: boolean; onToggle: () => void }
  /**
   * How the message came about, above it as wide as the conversation while `open` (see `messageInfo`'s `thinkingOf`).
   * `shownAlready` where it was on screen as the message arrived, as the thinking indicator's steps: it is
   * there, rather than arriving, and only the message arrives under it.
   */
  trace?: { open: boolean; content: ReactNode; shownAlready?: boolean }
}

export type MessageDetails = {
  open: boolean
  onToggle: () => void
  /** The panel's first line, which it is folded to before it leaves. */
  summary: ReactNode
  /** The rest of it, beneath that line. */
  more?: ReactNode
}

/**
 * What led to a reply, above it, the way the thinking indicator shows its steps: rows with no fill
 * or outline, as wide as the conversation. Opens and closes with the message's details (their stage),
 * and keeps the reader's place as it does: what it grows above is pushed down, and the view goes with it,
 * so that the message stays where it was looked at (see `MessageScrollContext`).
 */
const MessageTrace = ({ ref, id, stage, shownAlready, children }: { ref: RefObject<HTMLDivElement | null>; id: string; stage: string; shownAlready?: boolean; children: ReactNode }) => {
  const scroll = useContext(MessageScrollContext)
  useLayoutEffect(() => {
    const element = ref.current!
    let height = element.getBoundingClientRect().height
    const watch = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().height
      const change = next - height
      height = next
      if (change) scroll?.keepPlace(change, element)
    })
    watch.observe(element)
    return () => watch.disconnect()
  }, [ref, scroll])
  return (
    <div ref={ref} id={id} data-stage={stage} inert={stage === 'row' || stage === 'leaving'} className="message-trace w-full text-kumo-default">
      {/* The padding is inside what is clipped: on the clipped box itself it would be there when the rest is shut,
          and go when the trace is taken away. */}
      <div>
        {/* The message list opens the row it arrives in from the steps' height, as they are there already
            (`MessageList`). */}
        <div className="pt-1.5 pb-1"><div data-shown-already={shownAlready || undefined}>{children}</div></div>
      </div>
    </div>
  )
}

// The viewer's own messages are the page's opposite in light. In dark that would be a run of near
// white blocks, so there they are a shade lighter than the assistant's instead.
const BUBBLE = {
  user: 'bg-kumo-contrast text-kumo-inverse dark:bg-kumo-contrast/14 dark:text-kumo-default whitespace-pre-wrap',
  assistant: 'bg-kumo-fill text-kumo-default',
  error: 'bg-kumo-danger-tint text-kumo-danger',
} as const

// A view's surface, which it insets itself.
const VIEW = 'bg-kumo-base text-kumo-default ring-1 ring-inset ring-kumo-line'

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

// Beside the message, on the side the row has room, level with its middle. They are there all
// along, so showing them moves nothing, and show while the message or the place they are in is
// pointed at, or one of them was reached by keyboard; the rest of the row does not bring them up,
// and nor does having clicked one. They touch the bubble (the gap is their own padding), so the
// pointer crosses to them without leaving both. A screen that is touched has nothing to point
// with: there the message is tapped to show them, and until then they cannot be tapped either,
// which would be done unseen by a tap beside the message.
const ACTIONS =
  'absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity motion-reduce:transition-none ' +
  'group-hover/message:opacity-100 has-[:focus-visible]:opacity-100 has-data-popup-open:pointer-events-auto has-data-popup-open:opacity-100 ' +
  'pointer-coarse:pointer-events-none group-data-[actions=shown]/message:pointer-events-auto group-data-[actions=shown]/message:opacity-100'

// What a tap or a click on a message is for already, rather than for showing its actions or its details.
const OWN_TAP = 'a, button, input, textarea, select, summary, label, iframe, video, audio, [role="button"], [data-message-actions]'

/**
 * One chat message: the user's on the right in a bubble of their own colour, the assistant's and errors on the left.
 * What can be done with a message shows beside it while it is pointed at (see `MessageActions`);
 * its details, when asked for, unfold in an outlined panel beneath it.
 * Neighbouring messages from the same sender tuck together (see `RUN`). One that has just arrived
 * grows in (see Arrival.css), settling into the run it joins (see MessageBubble.css).
 */
export const MessageBubble = ({ role, children, media, view, joins, onReply, copyText, developerCopies, onMarkUnread, details, thinking, trace: thought }: MessageBubbleProps) => {
  const detailsId = useId()
  const traceId = useId()
  const open = details?.open ?? false
  // A bubble with nothing to offer, such as one of a message's files above its words, has no actions.
  const actions = (onReply || copyText !== undefined || developerCopies || onMarkUnread || details || thinking) &&
    <MessageActions onReply={onReply} copyText={copyText} developerCopies={developerCopies} onMarkUnread={onMarkUnread} details={details && { open, onToggle: details.onToggle, controls: detailsId }} thinking={thinking && { ...thinking, controls: traceId }} />

  // Shown by a tap, rather than by a pointer that is there, until the message is tapped again or
  // anything else is.
  const bubble = useRef<HTMLDivElement>(null)
  const touched = useRef(false)
  const [tapped, setTapped] = useState(false)
  const tapElsewhere = useEffectEvent(({ target }: MouseEvent) => {
    if (!(target instanceof Node) || !bubble.current?.contains(target)) setTapped(false)
  })
  useEffect(() => {
    if (!tapped) return
    document.addEventListener('click', tapElsewhere)
    return () => document.removeEventListener('click', tapElsewhere)
  }, [tapped])
  // A click on the message shows its details, and puts them away: not one that was for something in it,
  // such as a link or a button, nor one that ends choosing some of its text. A tap on a screen that is
  // touched shows the actions too.
  const tap = ({ target }: ReactMouseEvent) => {
    if (!(target instanceof Element) || target.closest(OWN_TAP)) return
    if (document.getSelection()?.isCollapsed === false) return
    if (actions && touched.current) setTapped((shown) => !shown)
    details?.onToggle()
  }

  // A click anywhere outside the details puts them away, except on the message, which shows and puts
  // them away itself, and on what is above it, which is another thing's, and in a menu, whose item may
  // be to show them. A click on another message puts these away as that one's are shown.
  //
  // On the click, not the press: closing moves what is below, and a button that moved between the
  // press and the release would not be clicked at all. That is what asking for another message's
  // details is, and this way the one closes and the other opens together.
  const panel = useRef<HTMLDivElement>(null)
  const trace = useRef<HTMLDivElement>(null)
  const stage = useDetailsStage(open, details?.more != null)
  // What is above the message is there as long as it is asked for, and goes as the details do.
  const traceStage = useDetailsStage(thought?.open ?? false, false)
  const traced = !!thought && traceStage !== 'gone'
  const traceFolded = traceStage === 'row' || traceStage === 'leaving'
  // The message's own bubble meets the panel as it would the next message, while it is there.
  const joinsDetails = stage !== 'gone' && stage !== 'leaving'
  const folded = stage === 'row' || stage === 'leaving'
  const clickElsewhere = useEffectEvent(({ target }: MouseEvent) => {
    if (!(target instanceof Element) || panel.current?.contains(target) || bubble.current?.contains(target) || trace.current?.contains(target)) return
    if (target.closest('[role="menu"]')) return
    details?.onToggle()
  })
  useEffect(() => {
    if (!open) return
    document.addEventListener('click', clickElsewhere)
    return () => document.removeEventListener('click', clickElsewhere)
  }, [open])

  return (
    <div
      data-role={role}
      data-traced-already={(traced && thought.shownAlready) || undefined}
      className={cn('flex items-start [container-type:inline-size]', traced && 'flex-col', role === 'user' ? 'justify-end' : 'justify-start', RUN[role].row, joins?.above && '-mt-1.5')}
    >
      {traced && (
        <MessageTrace ref={trace} id={traceId} stage={traceStage} shownAlready={thought.shownAlready}>{thought.content}</MessageTrace>
      )}
      <div
        className={cn(
          'arrives message-bubble rounded-[21px] text-base/5 break-words',
          view ? 'w-[min(100%_-_5.5rem,44rem)]' : 'max-w-[min(70%,65ch)]',
          // It grows in downwards, as the conversation does, from its sender's side.
          role === 'user' ? 'origin-top-right' : 'origin-top-left',
          'transition-[border-radius] duration-300 ease-out motion-reduce:transition-none',
          RUN[role].bubble,
          // Not tucked into the message above while what led to it is between them (and only as it goes, so
          // that the corner has come back by the time it is gone).
          joins?.above && !(traced && !traceFolded) && JOINED[role].above,
          joins?.below && JOINED[role].below,
        )}
      >
        {/* Tapped from a touch screen only: pointed at, or reached by keyboard, the actions show already. */}
        <div
          ref={bubble}
          data-actions={tapped ? 'shown' : undefined}
          onPointerDown={({ pointerType }) => {
            touched.current = pointerType !== 'mouse'
          }}
          onClick={tap}
          className={cn(
            'message-bubble-text group/message relative rounded-[inherit] transition-[border-radius] duration-300 ease-out motion-reduce:transition-none',
            // 21px corners less a 5px inset leave a tile's 16px.
            view ? VIEW : media ? 'p-[5px]' : 'px-5 py-[11px]',
            !view && BUBBLE[role],
            joinsDetails && JOINED[role].below,
          )}
        >
          {children}
          {actions && role === 'user' && <div data-message-actions="" className={cn(ACTIONS, 'right-full pe-2')}>{actions}</div>}
          {actions && role === 'assistant' && <div data-message-actions="" className={cn(ACTIONS, 'left-full ps-2')}>{actions}</div>}
        </div>
        {/* The details are a bubble of their own in width too: as wide as what is in them, up to
            the limit a message has, whatever the message's own width. The wrapper keeps them out
            of the message's intrinsic width, and they may reach past it. What is folded away
            still counts towards the width, so folding only makes the panel shorter. */}
        {details && stage !== 'gone' && (
          <div className={cn('flex flex-col [contain:inline-size]', role === 'user' ? 'items-end' : 'items-start')}>
            <div className="w-max max-w-[min(70cqw,65ch)]">
              {/* How it comes, folds and goes is in MessageBubble.css, by its stage. */}
              <div
                ref={panel}
                id={detailsId}
                data-message-details=""
                data-stage={stage}
                inert={!open}
                className="message-details text-kumo-default whitespace-normal"
              >
                {/* The gap to the message is part of what closes, so the panel closes to nothing. */}
                <div>
                  <div className="h-0.5" />
                  <div className={cn(
                    'message-details-surface rounded-[21px] bg-kumo-base px-5 py-3 ring-1 ring-inset ring-kumo-line',
                    role === 'user' ? 'origin-top-right' : 'origin-top-left',
                    JOINED[role].above,
                    RUN[role].details,
                    joins?.below && JOINED[role].below,
                  )}>
                    {/* The chevron takes its room from beside the first line only: the rest
                        has the full width. */}
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">{details.summary}</div>
                      <Button
                        variant="ghost"
                        icon={<ArrowUp01Icon weight="bold" />}
                        aria-label="Hide details"
                        title="Hide details"
                        // Into the panel's corner, level with the line, and the size and weight
                        // of the chevrons on what opens elsewhere (see `Disclosure`). Like
                        // theirs, it turns over as the panel folds.
                        className={cn(
                          MESSAGE_ACTION_STYLE,
                          '-my-1 -me-3 [&>svg]:size-3 [&>svg]:transition-transform [&>svg]:duration-[240ms] motion-reduce:[&>svg]:transition-none',
                          folded && '[&>svg]:-rotate-180',
                        )}
                        onClick={details.onToggle}
                      />
                    </div>
                    {details.more != null && (
                      <div className="message-details-more" inert={folded}>
                        <div>{details.more}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
