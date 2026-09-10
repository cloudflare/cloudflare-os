import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'

export default function UserMenu() {
  const { authenticatedApi, logout, currentUser, isAdmin, switchIdentity } = useAuthenticatedApi()
  const [identities, setIdentities] = useState<AiChatAuthorInfo[]>([])
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  useEffect(() => {
    let cancelled = false
    setIdentities([])
    authenticatedApi.listAccountIdentities().then(profiles => {
      if (!cancelled) setIdentities(profiles)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])
  const navigate = useNavigate()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className="flex h-11 w-11 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-kumo-tint transition-colors hover:bg-kumo-fill md:h-7 md:w-7"
            title="Open profile menu"
            aria-label="Open profile menu"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className={MENU_ITEM}
        >
          Profile
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          Providers
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            Admin
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        {switchIdentity && identities.filter(profile => profile.id !== currentUser?.id).map(profile => (
          <DropdownMenu.Item key={profile.id} className={MENU_ITEM} disabled={switching}
            onClick={() => {
              setSwitching(true)
              setSwitchError(null)
              void switchIdentity(profile.id).then(() => navigate({ to: '/' })).catch(error => {
                setSwitchError(error instanceof Error ? error.message : 'Could not switch account')
                setSwitching(false)
              })
            }}>
            Switch to {profile.id}
          </DropdownMenu.Item>
        ))}
        {switchError && <p role="alert" className="px-3 text-sm text-kumo-danger">{switchError}</p>}
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
