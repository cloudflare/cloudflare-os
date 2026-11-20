import { useId, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

export type SettingsCardProps = {
  /**
   * It holds a field for several lines and nothing else, which fills it but for a little room all
   * round. Give the field `rounded-2xl`: the surface's corners less that room, so that the two
   * curve together, and what is typed starts where a row's title would.
   */
  field?: boolean
  children: ReactNode
}

/**
 * How a `ghost` button on a `SettingsCard` answers to being pointed at: the surface is the colour a
 * ghost button turns (`kumo-tint`), which would not show on it. An icon alone takes `LIST_ACTION`
 * instead, which has the same.
 */
export const ON_SETTINGS_CARD = 'not-data-disabled:hover:bg-kumo-contrast/5'

/**
 * A surface that settings are listed on, a `SettingRow` to a line, with a line between one and
 * the next that stops short of its sides. A `SettingsGroup` has one by itself; give it several
 * (`plain`) where its settings fall into more than one lot.
 */
export const SettingsCard = ({ field = false, children }: SettingsCardProps) => (
  <div className={cn('flex flex-col rounded-3xl bg-kumo-tint text-base', field ? 'p-2' : 'px-5 py-1')}>{children}</div>
)

export type SettingsGroupProps = {
  /** What its settings have in common: "Defaults". */
  title: string
  /**
   * What the title alone does not say, in a line under it. Most groups have none: what a setting
   * does is said on its row. It is for a group whose rows are not settings, such as a list.
   */
  description?: string
  /** What can be done to the group as a whole, across from its title, such as adding to it. */
  action?: ReactNode
  /**
   * What it holds is on surfaces of its own rather than on the group's one: several
   * `SettingsCard`s, one under the other, where its settings fall into more than one lot.
   */
  plain?: boolean
  /** The settings (`SettingRow` and what is made of it), or whatever else the group holds. */
  children: ReactNode
}

/**
 * Settings that belong together, under what they have in common: a title, in from the edge as
 * far as what is on the surface under it is, then the surface, or the few it has.
 */
export const SettingsGroup = ({ title, description, action, plain = false, children }: SettingsGroupProps) => {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      {/* What is done to it ends where what is on the surface does, and takes none of the title's height: the title is where one alone would be. */}
      <div className="flex items-start justify-between gap-3 px-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-lg font-medium text-kumo-default">{title}</h2>
          {description && <p className="text-sm text-kumo-subtle">{description}</p>}
        </div>
        {action && <div className="-my-1.5 flex shrink-0">{action}</div>}
      </div>
      {plain ? <div className="flex flex-col gap-3">{children}</div> : <SettingsCard>{children}</SettingsCard>}
    </section>
  )
}
