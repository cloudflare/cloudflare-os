import { createContext, useContext, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Tag } from '@/components/Tag'

export type SettingRowProps = {
  title: string
  /** What it does, or why it is as it is. */
  description?: ReactNode
  /**
   * It is not there yet, which is said beside its title. What it is set by is shown, to say what
   * it will be like, and cannot be used.
   */
  soon?: boolean
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

/** Whether what is drawn is in a group none of which is there yet (`SettingsGroup`'s `soon`), so that it cannot be used. */
export const SoonContext = createContext(false)

/** How what is not there yet is drawn: fainter, as anything that cannot be used is. Give what it is set by `inert` too. */
export const SOON = 'opacity-50'

/** Said of what is not there yet, beside its name, quietly: it is a note, not a state to act on. */
export const SoonBadge = () => <Tag>Coming soon</Tag>

/**
 * One setting, on one line of a `SettingsGroup`, in two columns: what it is, and what it is set
 * by, in a column of one width down the group, so that what is said wraps at the same place on
 * every row: a field filling it, and a menu, a switch or a button as wide as it is, at its end.
 * Where there is not room for both columns (the row is the container that is asked), what it is
 * set by is as wide as it is, and goes under what is said when it has to. What is not there yet,
 * the row or the group it is in, is all drawn fainter, with what it is set by out of use.
 */
export const SettingRow = ({ title, description, soon = false, stacked = false, children }: SettingRowProps) => {
  const off = useContext(SoonContext) || soon
  return (
    <div className="@container border-t border-kumo-line py-4 first:border-t-0">
      {/* What it is set by is level with the row's top, however much is said beside it. */}
      <div className={cn('flex gap-x-6 gap-y-3', stacked ? 'flex-col' : 'flex-wrap items-start')}>
        {/* No narrower than reads well, which is what sends the rest to a line of its own. */}
        <div className={cn('flex flex-col gap-1 leading-snug', !stacked && 'min-w-[min(100%,14rem)] flex-1')}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-kumo-default">
            {/* Fainter with the rest of the row, but for the note that says why. */}
            <span className={off ? SOON : undefined}>{title}</span>
            {soon && <SoonBadge />}
          </p>
          {description && <p className={cn('text-sm text-kumo-subtle', off && SOON)}>{description}</p>}
        </div>
        {children !== undefined && (
          <div inert={off} className={cn('flex max-w-full min-w-0 items-center gap-2', stacked ? 'w-full' : '@lg:w-72 @lg:shrink-0 @lg:justify-end', off && SOON)}>{children}</div>
        )}
      </div>
    </div>
  )
}
