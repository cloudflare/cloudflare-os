import { BuildingsIcon } from '@phosphor-icons/react'
import { Avatar, LinkButton, Tag, Tooltip } from '@gadgets/ui'

/** Whose a skill is: somebody's, who may be the viewer, or the organization's, for everyone. */
export type SkillOwner = { kind: 'person'; name: string; you?: boolean } | { kind: 'organization' }

export type SkillRowProps = {
  name: string
  /** A line under the name: what it is for. */
  detail?: string
  /** Whose it is, shown as their picture, or as the organization's mark. */
  owner?: SkillOwner
  /** What it is filed under, if anything. */
  tag?: string
  /** When it was, as the list it is in puts it. */
  time?: string
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

// A picture says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

/** Whose the skill is, as a workspace's members are shown where it is listed: a picture that says whose when pointed at. */
const OwnerPicture = ({ owner }: { owner: SkillOwner }) => {
  const whose = owner.kind === 'organization' ? 'Organization' : owner.you ? 'You' : `Shared by ${owner.name}`
  return (
    <Tooltip delay={TOOLTIP_DELAY} content={whose}>
      <span role="img" aria-label={whose} className="flex shrink-0 rounded-full">
        {owner.kind === 'organization' ? (
          <span className="flex size-7 items-center justify-center rounded-full bg-kumo-base text-kumo-subtle">
            <BuildingsIcon size={14} />
          </span>
        ) : (
          <Avatar name={owner.name} className="bg-kumo-base" />
        )}
      </span>
    </Tooltip>
  )
}

/**
 * One skill in a list of them, which opens it: its name over what it is for, then its tag, whose
 * it is, and at the far end when it was. It has no icon: they would all be the same one, which
 * says nothing of any.
 */
export const SkillRow = ({ name, detail, owner, tag, time, href, onSelect }: SkillRowProps) => (
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
    {tag && <Tag className="max-w-[30%] shrink-0 truncate">{tag}</Tag>}
    {owner && <OwnerPicture owner={owner} />}
    {time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
  </LinkButton>
)
