import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type SettingsGroupProps = {
  /** What the rows are about: "Chat", "Danger". Not shown; read out. */
  label: string
  children: ReactNode
}

/**
 * Settings that belong together, on a surface of their own as a list's group is (`ListGroup`),
 * with a hairline between each row and the next.
 */
export const SettingsGroup = ({ label, children }: SettingsGroupProps) => (
  <section aria-label={label} className="flex flex-col rounded-3xl bg-kumo-tint px-4 [&>*+*]:border-t [&>*+*]:border-kumo-line">
    {children}
  </section>
)

export type SettingsRowProps = {
  title: string
  /** What it does, and what it leaves alone. */
  description?: ReactNode
  /** What changes it: a switch, a select, a button. */
  control?: ReactNode
  /** Something that cannot be undone, which its title says in the colour of danger. */
  danger?: boolean
  /** Ties the control's accessible description to the row's. */
  id?: string
}

/** One setting: what it is and does on the left, what changes it on the right. */
export const SettingsRow = ({ title, description, control, danger, id }: SettingsRowProps) => (
  <div className="flex items-center gap-4 py-4">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <h3 id={id && `${id}-title`} className={cn('text-base/5 font-medium', danger ? 'text-kumo-danger' : 'text-kumo-default')}>{title}</h3>
      {description && <p id={id && `${id}-description`} className="max-w-md text-sm/5 text-kumo-subtle">{description}</p>}
    </div>
    {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
  </div>
)
