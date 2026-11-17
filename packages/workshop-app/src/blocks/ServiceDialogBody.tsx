import type { ReactNode } from 'react'
import { Switch } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'
import { UserIcon } from '@phosphor-icons/react'
import { ClampedText } from '@/components/ClampedText'
import { Tooltip } from '@/components/Tooltip'

/** A kind of thing a service gives access to, such as its mail or its calendar, as a dialog lists it. */
export type ServiceAccess = {
  id: string
  title: string
  description?: string
  /** Its switch, where it is given on its own. */
  toggle?: {
    /** What the switch is called. */
    label: string
    checked: boolean
    disabled?: boolean
    /** Why it cannot be changed, said when it is pointed at or reached by keyboard. */
    note?: string
    onChange: (checked: boolean) => void
  }
}

const AccessSwitch = ({ toggle }: { toggle: NonNullable<ServiceAccess['toggle']> }) => {
  const { label, checked, disabled, note, onChange } = toggle
  const control = (
    // As tall as the title's line, so that the switch is on its middle. With a note it is what is
    // pointed at and focused, as a switch that cannot be changed is neither.
    <span tabIndex={note ? 0 : undefined} className="flex h-[1lh] shrink-0 items-center rounded-full leading-snug">
      <Switch size="sm" aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} className={note && 'pointer-events-none'} />
    </span>
  )
  return note ? <Tooltip content={note} delay={200}>{control}</Tooltip> : control
}

export type ServiceDialogBodyProps = {
  /** What is said before anything else, such as that something is wrong. */
  children?: ReactNode
  /** What the service is for, in a few sentences. */
  description?: string
  /** Whose account has what is in the list, as the service knows them, and what can be done with it from there. */
  account?: { label: string; action?: ReactNode }
  /** What the list is, which is not shown; read out. */
  label: string
  /** The kinds of thing the service gives access to. */
  access: ServiceAccess[]
}

/**
 * The middle of a dialog about a service: what it is for, and what it gives access to, with a
 * switch for each kind given on its own.
 */
export const ServiceDialogBody = ({ children, description, account, label, access }: ServiceDialogBodyProps) => (
  <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-1">
    {children}
    {/* About three lines of it, at the dialog's full width. */}
    {description && <ClampedText limit={180} className="leading-normal text-kumo-default">{description}</ClampedText>}
    {account && (
      // Shaped as the list is, and close over it, which is what the account has: an outline
      // rather than a surface, as it is one thing said, not a list.
      <div className={cn('flex shrink-0 items-center gap-3 rounded-(--surface-radius) py-4 ps-5 leading-snug ring-1 ring-kumo-line ring-inset', account.action ? 'pe-3' : 'pe-5', access.length > 0 && '-mb-4')}>
        <UserIcon aria-hidden="true" className="size-5 shrink-0 text-kumo-subtle" />
        <p className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-kumo-subtle">Connected with</span>
          <span className="truncate font-medium text-kumo-default">{account.label}</span>
        </p>
        {account.action}
      </div>
    )}
    {access.length > 0 && (
      // One surface for them all, with a line between one and the next that stops short of its
      // sides. No taller than a few of them, the last cut short: the rest are scrolled to, by a
      // scrollbar that is always there to say so.
      <ul aria-label={label} className="scrollbar-shown flex max-h-60 flex-col overflow-y-auto overscroll-contain rounded-(--surface-radius) bg-kumo-tint px-5 py-1">
        {access.map(({ id, title, description: detail, toggle }) => (
          // The switch stays at the top, on the title's line, as what is said grows down.
          <li key={id} className="flex shrink-0 items-start gap-4 border-t border-kumo-line py-4 first:border-t-0">
            <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
              <span className="font-medium text-kumo-default">{title}</span>
              {/* About two lines of it. */}
              {detail && <ClampedText limit={100} className="text-sm text-kumo-subtle">{detail}</ClampedText>}
            </div>
            {toggle && <AccessSwitch toggle={toggle} />}
          </li>
        ))}
      </ul>
    )}
  </div>
)
