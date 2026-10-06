import { Link, useRouterState } from '@tanstack/react-router'
import { Desktop, Moon, Plug, Sun } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'
import { useTheme } from '../../ThemeContext'
import type { ThemeMode } from '../../theme'
import { useT } from '../../i18n'

const THEME_SEQUENCE: ThemeMode[] = ['system', 'light', 'dark']

function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_SEQUENCE[(THEME_SEQUENCE.indexOf(mode) + 1) % THEME_SEQUENCE.length]
}

function ThemeModeButton() {
  const t = useT()
  const { themeMode, resolvedThemeMode, setThemeMode } = useTheme()
  const label = themeMode === 'system'
    ? t('theme.labelSystem', { resolved: resolvedThemeMode })
    : t('theme.labelMode', { mode: themeMode })
  const nextMode = nextThemeMode(themeMode)
  const tip = t('theme.switchTo', { label, next: nextMode })

  return (
    <Tooltip
      content={tip}
      render={(
        <button
          type="button"
          aria-label={tip}
          onClick={() => setThemeMode(nextMode)}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-elevated"
        >
          {themeMode === 'system' ? (
            <Desktop size={15} />
          ) : themeMode === 'dark' ? (
            <Moon size={15} />
          ) : (
            <Sun size={15} />
          )}
        </button>
      )}
    />
  )
}

// Bottom strip on the sidebar: tiny iconography for connections, theme, and the user menu. Mirrors
// the very low-chrome bottom row in the reference design and surfaces Profile / Providers / Admin
// from the user-menu dropdown rather than duplicating them as separate icons.
function StripLink({
  to,
  label,
  children,
}: {
  to: '/gatekeepers'
  label: string
  children: React.ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname === to
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-kumo-fill text-kumo-brand'
            : 'text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default',
        ].join(' ')}
      >
        {children}
      </Link>
    </Tooltip>
  )
}

export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  const t = useT()
  return (
    <div
      className={[
        // shrink-0 + solid base so the strip is visually pinned above the scrolling rail body
        // and content can't bleed through it. Flat treatment — no top shadow.
        'shrink-0 flex items-center gap-1 border-t border-kumo-line bg-kumo-elevated px-3 py-2',
        collapsed ? 'flex-col justify-center gap-2 px-1.5' : '',
      ].join(' ')}
    >
      <StripLink to="/gatekeepers" label={t('nav.gatekeepers')}>
        <Plug size={15} />
      </StripLink>
      <div className={collapsed ? 'flex flex-col items-center gap-2' : 'ml-auto flex items-center gap-1'}>
        <ThemeModeButton />
        <UserMenu />
      </div>
    </div>
  )
}
