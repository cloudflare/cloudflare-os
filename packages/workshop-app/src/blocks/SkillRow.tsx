import { Badge } from '@cloudflare/kumo'

export type SkillRowProps = {
  name: string
  /** A line under the name: whose it is, where not the user's own, and what it is for. */
  detail?: string
  /** What it is filed under, if anything. */
  tag?: string
  /** When it was, as the list it is in puts it. */
  time?: string
}

/**
 * One skill in a list of them: its name over what it is for, then its tag, and at the far end when
 * it was. It has no icon: they would all be the same one, which says nothing of any. It only says:
 * a skill is not opened from here.
 */
export const SkillRow = ({ name, detail, tag, time }: SkillRowProps) => (
  // In from the surface's edge as far as a settings row is, which it is listed among.
  <div className="flex items-center gap-3 px-3.5 py-3 text-base">
    <span className="min-w-0 flex-1 leading-snug">
      <span className="block truncate font-medium text-kumo-default">{name}</span>
      {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
    </span>
    {tag && <Badge variant="outline" className="max-w-[30%] shrink-0 truncate font-normal text-kumo-subtle">{tag}</Badge>}
    {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
  </div>
)
