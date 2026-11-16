import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { RowAction } from './RowAction'
import { StarButton } from './StarButton'

export type LibraryRowProps = {
  title: string
  /** A line under the title: what it is, which workspace it is in, and whose that is. */
  detail?: string
  /** What it is drawn as, when its blueprint says; otherwise an app. */
  icon?: FormatIconName
  /** When it was, as the list it is in puts it. */
  time?: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One output on the Library page: what it is, its title over where it is from, and at the far end
 * when it was. Pointed at, its star slides out at the end; a starred one keeps its star out.
 */
export const LibraryRow = ({ title, detail, icon, time, starred, onStarredChange, href, onSelect }: LibraryRowProps) => (
  <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole row opens the output, apart from the button over it.
      className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-subtle">
        <FormatIcon name={icon} className="size-5" />
      </span>
      <span className="min-w-0 flex-1 leading-snug">
        <span className="block truncate font-medium text-kumo-default">{title}</span>
        {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
      </span>
      {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
    </LinkButton>
    <RowAction shown={starred}>
      <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="relative" />
    </RowAction>
  </div>
)
