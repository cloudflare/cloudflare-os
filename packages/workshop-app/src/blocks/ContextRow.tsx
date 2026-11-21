import type { ReactNode } from 'react'
import { LinkButton } from '@gadgets/ui'

export type ContextRowProps = {
  /** What kind of thing it is: a format's glyph, a service's logo. */
  icon: ReactNode
  title: string
  /** More of what it is, after its title: "HTML". */
  detail?: string
  /** Opens it, where it can be opened: the row is then a link, or a button with no address. */
  onSelect?: () => void
  /** Where it opens, so that it can be opened in another tab. */
  href?: string
}

// Quiet text beside the page; floating, on a surface of its own, it is read as ordinary text (`ContextPanel`).
const ROW = 'flex min-w-0 items-center gap-3 px-2 py-2 text-base leading-5 text-kumo-subtle in-data-floating:text-kumo-default'

/** One thing a chat has, on a small line: what it is, its name, and what is said of it. */
export const ContextRow = ({ icon, title, detail, onSelect, href }: ContextRowProps) => {
  const content = (
    <>
      <span className="flex shrink-0 [&>svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {detail && <span className="max-w-[40%] shrink-0 truncate in-data-floating:text-kumo-subtle">{detail}</span>}
    </>
  )
  return onSelect
    ? <LinkButton href={href} onClick={onSelect} className={`${ROW} w-full cursor-pointer rounded-xl text-left outline-none hover:text-kumo-default focus-visible:text-kumo-default in-data-floating:hover:bg-kumo-contrast/5 focus-visible:ring-2 focus-visible:ring-kumo-ring`}>{content}</LinkButton>
    : <div className={ROW}>{content}</div>
}
