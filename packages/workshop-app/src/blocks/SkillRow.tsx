import { Badge } from '@cloudflare/kumo'
import { LinkButton } from '@/components/LinkButton'

export type SkillRowProps = {
  name: string
  /** A line under the name: whose it is, where not the user's own, and what it is for. */
  detail?: string
  /** What it is filed under, if anything. */
  tag?: string
  /** When it was, as the list it is in puts it. */
  time?: string
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One skill in a list of them, which opens it: its name over what it is for, then its tag, and at
 * the far end when it was. It has no icon: they would all be the same one, which says nothing of
 * any.
 */
export const SkillRow = ({ name, detail, tag, time, href, onSelect }: SkillRowProps) => (
  <LinkButton
    href={href}
    onClick={onSelect}
    // In from the surface's edge as far as a settings row is, which it is listed among.
    className="flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left text-base hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5"
  >
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{name}</span>
      {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
    </span>
    {/* Kumo rings a badge in a link that is pointed at, which here is the whole row: the tag is not what is pointed at. */}
    {tag && <Badge variant="outline" className="max-w-[30%] shrink-0 truncate font-normal text-kumo-subtle [a:hover_&]:ring-0">{tag}</Badge>}
    {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
  </LinkButton>
)
