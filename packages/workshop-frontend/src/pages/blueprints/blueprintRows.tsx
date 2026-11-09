import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { MoreIcon, StarIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import { StarFilledIcon } from '../../features/library/LibraryViews'

/** Whether a blueprint's name or description holds the search's text. */
export const matchesQuery = (query: string, ...fields: (string | undefined)[]) => {
  const needle = query.trim().toLowerCase()
  return !needle || fields.some(field => field?.toLowerCase().includes(needle))
}

const QUIET_ICON = 'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-kumo-default transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring'

/**
 * A blueprint as a Library row (Figma "Frame 681"): glyph, name, what it does, and on the right
 * when, a star and More for one the user keeps. The whole row opens the blueprint; the controls
 * sit above its link.
 */
export const BlueprintRow = ({ id, title, description, glyph, when, star, menu }: {
  id: string
  title: string
  description?: string
  glyph: ReactNode
  when?: string
  star?: { starred: boolean; onToggle: () => void }
  menu?: { label: string; danger?: boolean; onSelect: () => void }[]
}) => {
  const name = title || 'Untitled blueprint'
  return (
    <div className="group/row relative flex h-[49px] items-center gap-3 rounded-[14px] px-3 transition-colors hover:bg-kumo-tint has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-kumo-ring">
      <Link to="/blueprint/$id" params={{ id }} aria-label={name} className="absolute inset-0 rounded-[14px] outline-none" />
      <span className="flex size-[25px] shrink-0 items-center justify-center rounded-[10px] text-kumo-default">{glyph}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-[14px] font-medium leading-[17px] text-kumo-default">{name}</span>
        {description && <span className="hidden truncate text-[13px] text-kumo-subtle sm:inline">{description}</span>}
      </span>
      {when && <span className="shrink-0 text-[13px] leading-[22px] text-kumo-subtle">{when}</span>}
      {star && (
        <button
          type="button"
          onClick={star.onToggle}
          aria-label={star.starred ? `Unstar ${name}` : `Star ${name}`}
          aria-pressed={star.starred}
          className={`relative ${QUIET_ICON} ${star.starred ? 'opacity-50 hover:opacity-100' : 'opacity-0 group-hover/row:opacity-50 hover:!opacity-100 max-md:opacity-50'}`}
        >
          {star.starred ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
        </button>
      )}
      {menu && menu.length > 0 && (
        <DropdownMenu>
          <DropdownMenu.Trigger render={
            <button type="button" aria-label={`More for ${name}`}
              className={`relative ${QUIET_ICON} opacity-0 hover:!opacity-100 group-hover/row:opacity-50 data-[popup-open]:opacity-100 max-md:opacity-50`}>
              <MoreIcon size={16} />
            </button>
          } />
          <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
            {menu.map(entry => (
              <DropdownMenu.Item key={entry.label} variant={entry.danger ? 'danger' : undefined} onClick={entry.onSelect}
                className={entry.danger ? MENU_ITEM_DANGER : MENU_ITEM}>
                {entry.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      )}
    </div>
  )
}

/** One calm line where a list would be, with a quiet way forward if there is one. */
export const BlueprintsEmpty = ({ message, action, secondary }: {
  message: string
  action?: { label: string; onClick: () => void }
  secondary?: { label: string; onClick: () => void }
}) => (
  <div className="flex flex-col items-center gap-3 py-16 text-center">
    <p className="text-[13px] leading-5 text-kumo-subtle">{message}</p>
    {(action || secondary) && (
      <div className="flex items-center gap-2">
        {[action, secondary].filter(a => a !== undefined).map(a => (
          <button key={a.label} type="button" onClick={a.onClick}
            className="inline-flex h-[30px] cursor-pointer items-center rounded-full px-3 text-[13px] font-medium text-kumo-default ring-1 ring-kumo-line transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
            {a.label}
          </button>
        ))}
      </div>
    )}
  </div>
)
