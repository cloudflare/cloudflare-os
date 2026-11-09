import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ChevronRightIcon } from '../../../components/icons/designIcons'

/**
 * Something in the chat that needs the person: a connection, an approval, a web page to open.
 * Drawn like the design's app card (Figma "Round Btn"): white, a hairline, 20px corners, a grey
 * circle for what it is about, then what is asked and why, and the answers at the end. On a
 * narrow screen the answers wrap onto their own line.
 */
export function RequestCard({ icon, title, meta, children, actions, footer }: {
  icon: ReactNode
  title: ReactNode
  /** What it applies to, after the title: a repository, a site, an account. */
  meta?: ReactNode
  /** What the agent wants to do and why. */
  children?: ReactNode
  actions?: ReactNode
  /** Anything below the request, across the card's width. */
  footer?: ReactNode
}) {
  return (
    <div className={`w-full max-w-[680px] rounded-[20px] bg-kumo-base p-3 shadow-[0_2px_6px_rgba(0,0,0,0.03)] ring-1 ring-kumo-line`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
        <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint text-kumo-default" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0 flex-1 basis-[220px] py-px">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-[14px] font-medium leading-[17px] text-kumo-default">{title}</span>
            {meta && <span className="min-w-0 truncate text-[13px] leading-[17px] text-kumo-subtle">{meta}</span>}
          </div>
          {children && <div className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">{children}</div>}
        </div>
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5 self-center">{actions}</div>
        )}
      </div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  )
}

const BUTTON_BASE = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium leading-4 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40'

const BUTTON_TONES = {
  /** The answer the agent is asking for. */
  primary: 'bg-kumo-contrast text-kumo-inverse enabled:hover:opacity-85',
  /** The other answer. */
  secondary: 'bg-kumo-base text-kumo-default ring-1 ring-kumo-line enabled:hover:bg-kumo-elevated',
  /** A lesser choice beside them. */
  quiet: 'px-2.5 text-kumo-subtle enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default',
}

/** A request card answer's classes, for a control that draws its own button (a popover trigger). */
export const requestButtonClass = (tone: keyof typeof BUTTON_TONES) => `${BUTTON_BASE} ${BUTTON_TONES[tone]}`

/** An answer on a request card, as a pill (Figma "Request access"). */
export function RequestButton({ tone, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone: keyof typeof BUTTON_TONES
}) {
  return <button type="button" {...props} className={`${BUTTON_BASE} ${BUTTON_TONES[tone]} ${className}`} />
}

/**
 * What became of a request once it was answered, or of something the agent did that is worth a
 * line: an icon and a sentence in the transcript's quiet voice. With `onToggle` it opens to show
 * `detail`.
 */
export function ChatReceipt({ icon, children, detail, expanded = false, onToggle, title }: {
  icon: ReactNode
  children: ReactNode
  detail?: ReactNode
  expanded?: boolean
  onToggle?: () => void
  /** A tooltip for the line, such as when it happened. */
  title?: string
}) {
  const line = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle" aria-hidden="true">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
      {onToggle && (
        <ChevronRightIcon
          size={14}
          className={`shrink-0 opacity-50 transition-transform duration-200 ease-out ${expanded ? 'rotate-90' : ''}`}
        />
      )}
    </>
  )
  const lineClass = 'flex max-w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left text-[14px] leading-5 text-kumo-subtle'
  return (
    <div className="max-w-[680px]">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={title}
          className={`${lineClass} cursor-pointer transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none`}
        >
          {line}
        </button>
      ) : (
        <div className={lineClass} title={title}>{line}</div>
      )}
      {expanded && detail && (
        <div className="ml-[38px] mt-1 rounded-2xl bg-kumo-tint p-3 text-[13px] leading-[19px] text-kumo-subtle">{detail}</div>
      )}
    </div>
  )
}
