import { Fragment, useRef } from 'react'
import { ArrowLeftIcon, SignOutIcon, type Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { RailDivider } from './Sidebar'
import { useScrollFadeFallback } from './useScrollFadeFallback'
import { useWorkspaceUnderlay } from './useWorkspaceUnderlay'

/** One part of the settings, as the ways to it name it. */
export type SettingsNavItem = {
  id: string
  label: string
  icon: Icon
  /** What is in it, in a few words, where there is room to say. */
  summary?: string
  /** Its address, so that it can be opened in another tab, where it is listed as a link. */
  href?: string
}

/** Parts that belong together, under what they have in common, where that is said: the user's own have no heading. */
export type SettingsNavGroup = { label?: string; items: SettingsNavItem[] }

export type SettingsSidebarProps = {
  groups: SettingsNavGroup[]
  /** The id of the part that is showing. */
  current?: string
  onSelect: (id: string) => void
  /** Leaves the settings, by the way back over the parts. */
  onClose: () => void
  /** Drawn as a rail one button wide: the same buttons in a column, each part its icon. */
  collapsed?: boolean
  /** Signs out of this browser, asked first, from the foot of the sidebar. */
  onSignOut?: () => void
}

const underlay = 'pointer-events-none absolute inset-x-0 top-0 -z-10 h-0 rounded-2xl bg-kumo-fill'

/**
 * One group of the parts, under what they have in common: each a line with its icon and its name,
 * with one highlight shared between the one showing and the one pointed at, as the workspaces
 * have (`useWorkspaceUnderlay`). A group has a highlight of its own, which does not cross to the
 * next over what is said between them.
 */
const PartGroup = ({ group, current, onSelect }: { group: SettingsNavGroup; current?: string; onSelect: (id: string) => void }) => {
  const { listRef, underlayRef, hoverUnderlayRef } = useWorkspaceUnderlay('[data-nav-row]')
  return (
    <div role={group.label ? 'group' : undefined} aria-label={group.label} className="flex shrink-0 flex-col">
      {group.label && <p aria-hidden="true" className="px-3 pb-1.5 text-xs font-medium text-kumo-subtle">{group.label}</p>}
      <div ref={listRef} className="relative isolate flex flex-col">
        <div ref={underlayRef} aria-hidden="true" className={underlay} />
        <div ref={hoverUnderlayRef} aria-hidden="true" className={underlay} />
        {group.items.map(({ id, label, icon: Glyph, href }) => (
          <LinkButton
            key={id}
            href={href}
            data-nav-row=""
            aria-current={id === current ? 'page' : undefined}
            onClick={() => onSelect(id)}
            className={cn(
              // A rectangular hit area keeps hover stable at the rounded corners as the underlay grows.
              "relative after:absolute after:inset-0 after:content-['']",
              'flex w-full cursor-pointer items-center gap-2.5 rounded-2xl px-3 py-2 text-left text-(length:--control-text) font-medium text-kumo-default',
              'not-data-underlay:hover:bg-kumo-fill not-data-underlay:aria-[current=page]:bg-kumo-fill',
            )}
          >
            <Glyph aria-hidden="true" className="size-[1.125em] shrink-0 text-kumo-subtle" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </LinkButton>
        ))}
      </div>
    </div>
  )
}

/**
 * The sidebar while the settings show, in the app's own sidebar's place: the way back out where
 * the logo is, and the settings' parts under it, each group under its name. Nothing of the app's
 * own sidebar stays, the user's menu included: the way out is the one at the top.
 */
export const SettingsSidebar = ({ groups, current, onSelect, onClose, collapsed = false, onSignOut }: SettingsSidebarProps) => {
  const scrollRef = useRef<HTMLElement>(null)
  useScrollFadeFallback(scrollRef)
  const back = <Button icon={ArrowLeftIcon} aria-label="Close settings" title="Close settings" onClick={onClose} />

  if (collapsed) {
    return (
      // As wide as `AppShell`'s rail: a button, with room around it.
      <div className="flex min-h-0 flex-1 flex-col items-center px-2 py-2.5">
        <header className="flex flex-col items-center">
          {back}
          <RailDivider />
        </header>
        {/* Scrolled with no scrollbar, with room at its sides for the buttons' rings. */}
        <nav ref={scrollRef} aria-label="Settings" className="chat-fade sidebar-fade -mx-1 flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-1 py-1 -my-1 [scrollbar-width:none]">
          {groups.map((group, index) => (
            <Fragment key={group.label ?? index}>
              {index > 0 && <RailDivider />}
              <div role={group.label ? 'group' : undefined} aria-label={group.label} className="flex shrink-0 flex-col gap-1.5">
                {group.items.map(({ id, label, icon }) => (
                  <Tooltip key={id} content={label} side="right">
                    <Button
                      icon={icon}
                      aria-label={label}
                      aria-current={id === current ? 'page' : undefined}
                      onClick={() => onSelect(id)}
                      className="aria-[current=page]:bg-kumo-tint"
                    />
                  </Tooltip>
                ))}
              </div>
            </Fragment>
          ))}
        </nav>
        {onSignOut && (
          <footer className="flex shrink-0 pt-2">
            <ConfirmMenu icon={SignOutIcon} aria-label="Sign out" triggerVariant="ghost" side="top" align="start" title="Sign out?" description="You’ll need to sign in again to use the Workshop in this browser." confirmLabel="Sign out" onConfirm={onSignOut} />
          </footer>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-1.5 py-2.5">
      <header className="flex items-center gap-2.5">
        {back}
        <h2 className="min-w-0 truncate text-(length:--control-text) font-medium text-kumo-default">Settings</h2>
      </header>
      <nav ref={scrollRef} aria-label="Settings" className="chat-fade sidebar-fade -mx-1 -mb-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-1 [scrollbar-width:none]">
        {groups.map((group, index) => <PartGroup key={group.label ?? index} group={group} current={current} onSelect={onSelect} />)}
      </nav>
      {onSignOut && (
        <footer className="flex shrink-0">
          <ConfirmMenu
            label="Sign out"
            icon={SignOutIcon}
            triggerVariant="ghost"
            triggerClassName="w-full justify-start"
            side="top"
            align="start"
            title="Sign out?"
            description="You’ll need to sign in again to use the Workshop in this browser."
            confirmLabel="Sign out"
            onConfirm={onSignOut}
          />
        </footer>
      )}
    </div>
  )
}
