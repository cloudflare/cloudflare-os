import { useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'
import { EditableTitle } from '@/components/EditableTitle'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { CardAction } from './CardAction'
import { LibraryMoreMenu, type LibraryMoreActions } from './LibraryMoreMenu'
import { LIST_ACTION, StarButton } from './StarButton'
import { TemplatePreview } from './TemplatePreview'
import { WaitingBadge } from './WaitingBadge'

export type LibraryCardProps = {
  title: string
  /** What it is, in a word, for a reader: "Document". Its icon says it to the eye. */
  kind: string
  /** What it is drawn as, when its blueprint says; otherwise an app. */
  icon?: FormatIconName
  /**
   * The workspace it is in, as it is drawn and called where workspaces are listed, and the way to
   * it: its page (`href`), so that it can be opened in another tab, and going there (`onSelect`).
   */
  workspace: WorkspaceLook & { title: string; label: string; href?: string; onSelect: () => void }
  /** Whose it is: somebody else, who shared it, or the user (`you`). */
  owner?: { name: string; avatarUrl?: string; you?: boolean }
  /** When it was, as the list it is in puts it. */
  time?: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
  /** What else can be done to it from its more menu, for whoever may (`LibraryMoreMenu`). */
  more?: LibraryMoreActions
  /** How many things it asks that wait on the user, which it says at the end of its last line. */
  waiting?: number
}

const CARD = 'flex flex-1 flex-col rounded-3xl p-1.5 text-left text-base group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5 group-has-data-popup-open:bg-kumo-contrast/5'

// A picture says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

/**
 * One output on the Library page, as a card, as a template is in a store's most used
 * (`TemplateCard`): a picture of what it is (`TemplatePreview`), with the icon of the workspace it
 * is in in its corner, which goes there, and its type's beside that, then its title, and at its
 * end whose it is, as their picture, and when it was. Each of those says what it is when pointed
 * at. Pointed at, more and its star show in its corner; a starred one keeps its star. Renamed from
 * more, its title is typed where it is, and the card opens nothing until that is done. On a narrow
 * screen, where two cards share a line, more is left out, which the output's own page has.
 */
export const LibraryCard = ({ title, kind, icon, workspace, owner, time, starred, onStarredChange, href, onSelect, more, waiting = 0 }: LibraryCardProps) => {
  const whose = owner && (owner.you ? 'Yours' : `Shared by ${owner.name}`)
  const [renaming, setRenaming] = useState(false)
  const { onRename } = more ?? {}
  const editing = renaming && onRename !== undefined
  const content = (name: ReactNode) => (
    <>
      <span className="relative block">
        {/* As round as the card is, less the room around it. */}
        <TemplatePreview icon={icon} className="rounded-[1.125rem]" />
        {/* After the workspace's, which is over it, outside the link. */}
        <Tooltip delay={TOOLTIP_DELAY} content={kind}>
          <span role="img" aria-label={kind} className="absolute bottom-2 left-[2.625rem] grid size-7 place-items-center rounded-lg bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
            <FormatIcon name={icon} className="size-4" />
          </span>
        </Tooltip>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 pt-3 pb-2.5 leading-snug">
        {name}
        {/* At the card's end, so that they line up along a line of cards that say more or less. */}
        <span className="mt-auto flex min-h-6 min-w-0 items-center gap-2 pt-2 text-sm text-kumo-subtle">
          {owner && (
            <Tooltip delay={TOOLTIP_DELAY} content={whose}>
              <span role="img" aria-label={whose} className="flex shrink-0 rounded-full">
                <Avatar name={owner.name} src={owner.avatarUrl} className="size-6 bg-kumo-base text-[0.625rem]" />
              </span>
            </Tooltip>
          )}
          {time && <span className="truncate">{time}</span>}
          {waiting > 0 && <WaitingBadge count={waiting} className="ms-auto" />}
        </span>
      </span>
    </>
  )
  return (
    <div className="group relative flex flex-col rounded-3xl bg-kumo-tint">
      {editing ? (
        <div className={CARD}>
          {content(
            // Where the title was, as wide as the card: the field's own room is taken from its sides.
            <EditableTitle value={title} onRename={onRename} onEnd={() => setRenaming(false)} autoFocus aria-label="Title" className="-mx-2.5 -my-1 block w-[calc(100%+1.25rem)] max-w-none font-medium text-kumo-default" />,
          )}
        </div>
      ) : (
        <LinkButton
          href={href}
          onClick={onSelect}
          // The whole card opens the output, apart from the buttons over it.
          className={cn(CARD, 'cursor-pointer')}
        >
          {content(<span className="line-clamp-2 font-medium wrap-anywhere text-kumo-default">{title}</span>)}
        </LinkButton>
      )}
      {/*
        Over the picture's corner, as large as the picture is, and outside the card's link, as a
        link in a link cannot be: the workspace it is in, which goes there. Only it takes the
        pointer; past it, the card's link has it.
      */}
      <span className="pointer-events-none absolute inset-x-1.5 top-1.5 aspect-16/10">
        <Tooltip delay={TOOLTIP_DELAY} content={workspace.title}>
          <LinkButton
            href={workspace.href}
            onClick={workspace.onSelect}
            aria-label={`Open ${workspace.title}`}
            // Darkened when pointed at, icon and all, as the icon leaves little of the tile to shade.
            className="pointer-events-auto absolute bottom-2 left-2 grid size-7 cursor-pointer place-items-center rounded-lg bg-kumo-base ring-1 ring-kumo-line transition-[filter] duration-75 hover:brightness-90 focus-visible:brightness-90"
          >
            <WorkspaceIcon label={workspace.label} shape={workspace.shape} color={workspace.color} small />
          </LinkButton>
        </Tooltip>
      </span>
      {/* Each on a surface of its own, as they are over a picture. */}
      <span className="absolute top-3 right-3 flex gap-1">
        {!editing && (
          <span className="contents max-md:hidden">
            <CardAction>
              <LibraryMoreMenu
                title={title}
                href={href}
                onOpen={onSelect}
                {...more}
                onRename={onRename && (() => setRenaming(true))}
                triggerClassName={cn(LIST_ACTION, 'bg-kumo-base ring-1 ring-kumo-line not-data-disabled:hover:bg-kumo-tint')}
              />
            </CardAction>
          </span>
        )}
        <CardAction shown={starred}>
          <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="bg-kumo-base ring-1 ring-kumo-line not-data-disabled:hover:bg-kumo-tint" />
        </CardAction>
      </span>
    </div>
  )
}
