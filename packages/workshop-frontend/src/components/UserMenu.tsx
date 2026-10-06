import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from './menuStyles'
import { useT, useI18n } from '../i18n'
import type { Locale } from '../i18n'

export default function UserMenu() {
  const t = useT()
  const { locale, setLocale } = useI18n()
  const { authenticatedApi, logout, currentUser, isAdmin } = useAuthenticatedApi()
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
            title={t("nav.openProfileMenu")}
            aria-label={t("nav.openProfileMenu")}
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
          {t('nav.profile')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className={MENU_ITEM}
        >
          {t('nav.providers')}
        </DropdownMenu.Item>
        {isAdmin && (
          <DropdownMenu.Item
            onClick={() => navigate({ to: '/admin' })}
            className={MENU_ITEM}
          >
            {t('nav.admin')}
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <div className="px-2 py-1.5" role="group" aria-label={t('nav.language')}>
          <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
            {t('nav.language')}
          </div>
          <div className="flex gap-1">
            {([
              { id: 'en' as Locale, label: t('nav.languageEn') },
              { id: 'ko' as Locale, label: t('nav.languageKo') },
            ]).map((opt) => {
              const active = locale === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setLocale(opt.id)}
                  aria-pressed={active}
                  className={[
                    'inline-flex h-7 flex-1 cursor-pointer items-center justify-center rounded-md border px-2 text-[12px] font-medium tracking-[-0.15px] transition-colors',
                    active
                      ? 'border-kumo-brand bg-kumo-brand text-white'
                      : 'border-kumo-line bg-kumo-base text-kumo-default hover:bg-kumo-tint',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className={MENU_ITEM_DANGER}
        >
          {t('auth.signOut')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
