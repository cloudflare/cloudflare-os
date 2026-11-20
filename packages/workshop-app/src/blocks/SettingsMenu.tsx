import { CaretRightIcon, SignOutIcon } from '@phosphor-icons/react'
import { Avatar, ConfirmMenu, LinkButton } from '@gadgets/ui'
import type { SettingsNavGroup } from './SettingsSidebar'

export type SettingsMenuProps = {
  /** Whose settings they are, said first. */
  user: { name: string; detail?: string; avatarUrl?: string }
  groups: SettingsNavGroup[]
  onSelect: (id: string) => void
  /** Signs out of this browser, asked first, after the parts. */
  onSignOut?: () => void
}

/**
 * The parts of the settings as a page of their own, where there is room for one thing at a time:
 * whose they are, then each group on a surface of its own, a part to a row with what is in it
 * under its name and a chevron at its end, as it is gone into.
 */
export const SettingsMenu = ({ user, groups, onSelect, onSignOut }: SettingsMenuProps) => (
  <nav aria-label="Settings" className="mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-8">
    <div className="flex flex-col items-center gap-2 py-4 text-center">
      <Avatar name={user.name} src={user.avatarUrl} className="size-16 text-xl" />
      <div className="flex max-w-full flex-col leading-snug">
        <span className="truncate text-xl font-medium text-kumo-default">{user.name}</span>
        {user.detail && <span className="truncate text-base text-kumo-subtle">{user.detail}</span>}
      </div>
    </div>
    {groups.map((group) => (
      <section key={group.label} aria-label={group.label} className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
        {group.items.map(({ id, label, icon: Glyph, summary, href }) => (
          <LinkButton
            key={id}
            href={href}
            onClick={() => onSelect(id)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-2xl p-3 text-left text-base hover:bg-kumo-contrast/5"
          >
            <Glyph aria-hidden="true" className="size-5 shrink-0 text-kumo-default" />
            <span className="flex min-w-0 flex-1 flex-col leading-snug">
              <span className="truncate font-medium text-kumo-default">{label}</span>
              {summary && <span className="truncate text-kumo-subtle">{summary}</span>}
            </span>
            <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />
          </LinkButton>
        ))}
      </section>
    ))}
    {onSignOut && (
      <div className="flex justify-center">
        <ConfirmMenu
          label="Sign out"
          icon={SignOutIcon}
          triggerVariant="ghost"
          side="top"
          title="Sign out?"
          description="You’ll need to sign in again to use the Workshop in this browser."
          confirmLabel="Sign out"
          onConfirm={onSignOut}
        />
      </div>
    )}
  </nav>
)
