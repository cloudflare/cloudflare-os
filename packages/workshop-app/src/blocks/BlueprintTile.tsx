import { useState, type ReactElement } from 'react'
import { DotsThreeIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { ContextMenu } from '@/components/ContextMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'
import { libraryMenu, type LibraryAction } from './LibraryRow'

export type BlueprintPictureProps = {
  /** Its picture, as published; absent, or failing to load, its glyph stands in. */
  picture?: string
  /** What a gadget made from it is, as a glyph: a document, an app. */
  icon: ReactElement
  /** What it makes, in a word, under the glyph while there is no picture: "Document". */
  label?: string
  /** `lg` heads its own page, where the glyph has room to be larger. */
  size?: 'md' | 'lg'
  className?: string
}

/**
 * A blueprint's picture, as wide as a screen is (16:10), on the page's tint: the picture it was
 * published with, faded in once it has loaded, or the glyph of what it makes, centred over what it
 * is called, while it has none.
 */
export const BlueprintPicture = ({ picture, icon, label, size = 'md', className }: BlueprintPictureProps) => {
  // The picture that loaded, and the one that failed, so a new one is shown afresh.
  const [loaded, setLoaded] = useState<string>()
  const [failed, setFailed] = useState<string>()
  const shown = picture && failed !== picture ? picture : undefined
  return (
    <span className={cn('relative block aspect-[16/10] overflow-hidden bg-kumo-contrast/3', className)}>
      {(!shown || loaded !== shown) && (
        <span aria-hidden="true" className={cn('absolute inset-0 flex flex-col items-center justify-center gap-2 text-kumo-subtle/70', size === 'lg' ? '[&>svg]:size-10' : '[&>svg]:size-7')}>
          {icon}
          {label && <span className={cn('font-medium', size === 'lg' ? 'text-sm' : 'text-xs')}>{label}</span>}
        </span>
      )}
      {shown && (
        <img
          src={shown}
          alt=""
          onLoad={() => setLoaded(shown)}
          onError={() => setFailed(shown)}
          className={cn('absolute inset-0 size-full object-cover object-top transition-opacity duration-300 ease-out motion-reduce:transition-none', loaded === shown ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </span>
  )
}

export type BlueprintTileProps = {
  title: string
  /** Under its name: who made it, and what it needs. */
  detail: string
  picture?: string
  icon: ReactElement
  /** What it makes, in a word, under its glyph while it has no picture. */
  label?: string
  /** A mark in its corner, such as that it is saved. */
  badge?: string
  /** Its More menu, which right-clicking it opens as well. */
  actions: LibraryAction[]
  href?: string
  onSelect: () => void
}

// Over a picture as much as over the tile's own surface, so on a disc of its own.
const MORE = 'size-7 rounded-full bg-kumo-base/85 text-kumo-default shadow-[0_1px_2px_rgb(0_0_0/0.08)] backdrop-blur-sm [&_svg]:size-3.5 not-data-disabled:hover:bg-kumo-base'
const HIDDEN = 'pointer-events-none scale-75 opacity-0 transition-[opacity,scale] duration-100 ease-[cubic-bezier(0.2,0,0.15,1)] group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:scale-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:scale-100 group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:scale-100 pointer-coarse:opacity-100 motion-reduce:transition-none'

/**
 * A blueprint in the Library's Blueprints tab: its picture, its name, and under it who made it and
 * what it needs. Pointed at, the picture leans in and More pops out in its corner; pressed, it
 * gives a little. Right-click it for the same menu as More.
 */
export const BlueprintTile = ({ title, detail, picture, icon, label, badge, actions, href, onSelect }: BlueprintTileProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div className="group relative flex flex-col gap-2.5 transition-[scale] duration-150 ease-out has-[.tile:active]:scale-[0.98] motion-reduce:transition-none">
      <LinkButton href={href} onClick={onSelect} title={title} className="tile flex flex-col gap-2.5 rounded-2xl text-left outline-none">
        <span className="block overflow-hidden rounded-2xl ring-1 ring-kumo-contrast/6 group-has-focus-visible:ring-2 group-has-focus-visible:ring-kumo-ring">
          <BlueprintPicture picture={picture} icon={icon} label={label} className="transition-[scale] duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none" />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 px-1">
          <span className="truncate text-base/5 font-medium text-kumo-default">{title}</span>
          <span className="truncate text-sm/5 text-kumo-subtle">{detail}</span>
        </span>
      </LinkButton>
      {badge && (
        <span className="pointer-events-none absolute start-2 top-2 rounded-full bg-kumo-base/85 px-2 py-0.5 text-xs/4 font-medium text-kumo-default shadow-[0_1px_2px_rgb(0_0_0/0.08)] backdrop-blur-sm">{badge}</span>
      )}
      {actions.length > 0 && (
        <span className={cn('absolute end-2 top-2 flex', HIDDEN)}>
          <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={MORE} align="end">
            {libraryMenu(actions)}
          </DropdownMenu>
        </span>
      )}
    </div>
  </ContextMenu>
)
