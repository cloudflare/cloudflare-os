import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type SettingRowProps = {
  /** What it is called: text, or a link where the row's name goes somewhere. */
  title: ReactNode
  /** What it is of, drawn before what is said of it, such as a service's logo. */
  icon?: ReactNode
  /** What it does, or why it is as it is. */
  description?: ReactNode
  /**
   * What it is set by goes under what is said of it, at the row's full width, rather than at its
   * end: for something wide, such as a list or a few lines of text.
   */
  stacked?: boolean
  /**
   * What it is set by: a switch, a menu, a field, a button. Named for what the row is of. A field
   * should fill the room it is given (a width of `@lg:w-full`); the rest are as wide as they are.
   */
  children?: ReactNode
}

/**
 * One setting, on one line of a `SettingsGroup`, in two columns: what it is, and what it is set
 * by, in a column of one width down the group, so that what is said wraps at the same place on
 * every row: a field filling it, and a menu, a switch or a button as wide as it is, at its end.
 * Where there is not room for both columns (the row is the container that is asked), what it is
 * set by is as wide as it is, and goes under what is said when it has to.
 */
export const SettingRow = ({ title, icon, description, stacked = false, children }: SettingRowProps) => (
  <div className="@container border-t border-kumo-line py-4 first:border-t-0">
    {/* What it is set by is level with the row's top, however much is said beside it. */}
    <div className={cn('flex gap-x-6 gap-y-3', stacked ? 'flex-col' : 'flex-wrap items-start')}>
      {/* No narrower than reads well, which is what sends the rest to a line of its own. */}
      <div className={cn('flex items-start gap-3', !stacked && 'min-w-[min(100%,14rem)] flex-1')}>
        {icon !== undefined && <span className="flex shrink-0">{icon}</span>}
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <p className="font-medium text-kumo-default">{title}</p>
          {description && <p className="text-sm text-kumo-subtle">{description}</p>}
        </div>
      </div>
      {children !== undefined && (
        <div className={cn('flex max-w-full min-w-0 items-center gap-2', stacked ? 'w-full' : '@lg:w-72 @lg:shrink-0 @lg:justify-end')}>{children}</div>
      )}
    </div>
  </div>
)
