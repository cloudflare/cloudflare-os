import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { Check } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { useGatekeeperApps } from '../useGatekeeperApps'
import { libraryTabOfApp } from '../features/library/libraryApps'
import { useTheme } from '../ThemeContext'
import type { ThemeMode } from '../theme'
import { initials as nameInitials } from './PersonAvatar'
import { roundButtonClass } from './RoundButton'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

const THEME_LABELS: Record<ThemeMode, string> = { system: 'System', light: 'Light', dark: 'Dark' }

/**
 * The avatar at the foot of the sidebar (Figma "Round Btn" holding a 26px photo) and its menu. The
 * design's sidebar keeps only chats, so the menu also reaches the places that used to have their
 * own sidebar entries: AI models, gatekeeper apps and Blueprints. (Unread chats need no page: each
 * sidebar row marks its own.)
 */
export default function UserMenu() {
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
  const navigate = useNavigate()
  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)
  const gatekeeperApps = useGatekeeperApps()
  const { themeMode, setThemeMode } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button className={roundButtonClass('icon', 'p-1 max-md:!size-11')} title="Account" aria-label="Open account menu">
            <span className="flex size-[26px] max-md:size-9 items-center justify-center overflow-hidden rounded-full bg-kumo-recessed">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="size-full object-cover" />
              ) : (
                <span className="text-[10px] font-semibold text-kumo-default">
                  {currentUser?.name ? nameInitials(currentUser.name) : 'U'}
                </span>
              )}
            </span>
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} side="top" align="start">
        {currentUser && (
          <div className="px-2.5 pb-1.5 pt-1 text-[13px] font-medium leading-4 text-kumo-default">{currentUser.name}</div>
        )}
        <DropdownMenu.Item onClick={() => navigate({ to: '/profile' })} className={MENU_ITEM}>Profile</DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => navigate({ to: '/gatekeepers' })} className={MENU_ITEM}>Gatekeepers</DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => navigate({ to: '/providers' })} className={MENU_ITEM}>AI models</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={() => navigate({ to: '/blueprints' })} className={MENU_ITEM}>Blueprints</DropdownMenu.Item>
        {gatekeeperApps.filter(app => !libraryTabOfApp(app.id)).map(app => (
          <DropdownMenu.Item key={app.id} className={MENU_ITEM}
            onClick={() => navigate({ to: '/gatekeepers/$appId', params: { appId: app.id } })}>
            {app.title}
          </DropdownMenu.Item>
        ))}
        {isAdmin && (
          <DropdownMenu.Item onClick={() => navigate({ to: '/admin' })} className={MENU_ITEM}>Admin</DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger className={MENU_ITEM}>Theme: {THEME_LABELS[themeMode]}</DropdownMenu.SubTrigger>
          {/* Its own positioner needs the menu tier too, or it opens beneath the menu it came from. */}
          <DropdownMenu.SubContent className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
            {(Object.keys(THEME_LABELS) as ThemeMode[]).map(mode => (
              <DropdownMenu.Item key={mode} className={`${MENU_ITEM} flex items-center justify-between gap-4`} onClick={() => setThemeMode(mode)}>
                {THEME_LABELS[mode]}
                {mode === themeMode && <Check size={13} className="text-kumo-subtle" aria-label="Current" />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="danger" onClick={logout} className={MENU_ITEM_DANGER}>Sign out</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
