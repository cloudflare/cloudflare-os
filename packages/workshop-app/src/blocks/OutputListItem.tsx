import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'

export type OutputListItemProps = {
  title: string
  /** A line under the title, e.g. what it is and which workspace it is in. */
  subtitle?: string
  /** What it is drawn as, when its blueprint says; otherwise an app. */
  icon?: FormatIconName
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/** One output in a list of them, such as the library. */
export const OutputListItem = ({ title, subtitle, icon, href, onSelect }: OutputListItemProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-base hover:bg-kumo-fill"
  >
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-subtle">
      <FormatIcon name={icon} className="size-5" />
    </span>
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{title}</span>
      {subtitle && <span className="block truncate text-kumo-subtle">{subtitle}</span>}
    </span>
  </LinkButton>
)
