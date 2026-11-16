import { CaretRightIcon } from '@phosphor-icons/react'
import { ServiceLogo } from '@/components/ServiceLogo'

export type WorkspaceConnectionRowProps = {
  title: string
  /** What kind of resource it is and what uses it: "Google Doc · Used by Tip Jar and 2 chats". */
  detail: string
  /** Its kind's icon, or else its service's logo. */
  logo: { name: string; src?: string; color?: string }
  /** What goes ahead through it without asking, in a few words: "Document edits allowed". */
  automatic?: string
  onOpen: () => void
}

/**
 * One of a workspace's connections, on two lines: its icon and title, then what it is and what uses
 * it; at its end, what goes ahead through it without asking, where something does. The whole row
 * opens it, as its caret says.
 */
export const WorkspaceConnectionRow = ({ title, detail, logo, automatic, onOpen }: WorkspaceConnectionRowProps) => (
  <button
    type="button"
    onClick={onOpen}
    className="flex w-full items-center gap-3 rounded-2xl py-2.5 pr-3 pl-3 text-left text-base outline-none hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5 focus-visible:ring-2 focus-visible:ring-kumo-ring"
  >
    <ServiceLogo name={logo.name} src={logo.src} color={logo.color} />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate font-medium text-kumo-default">{title}</span>
      <span className="truncate text-sm text-kumo-subtle">
        {detail}
        {/* At its end where there is room; under its title where there is not. */}
        {automatic && <span className="sm:hidden"> · {automatic}</span>}
      </span>
    </span>
    {automatic && <span className="hidden shrink-0 text-sm text-kumo-subtle sm:inline">{automatic}</span>}
    <CaretRightIcon aria-hidden="true" className="size-4 shrink-0 text-kumo-subtle" />
  </button>
)
