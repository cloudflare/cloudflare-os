import { useT, localizeGatekeeperAppTitle } from '../i18n'
import { Link } from '@tanstack/react-router'
import { Hexagon, List, X } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../AuthContext'
import { useGatekeeperApps } from '../useGatekeeperApps'
import { useSiteName } from '../ServerConfigContext'
import { useState, useEffect, useRef } from 'react'
import UserMenu from './UserMenu'
import TopBarNotice from '../TopBarNotice'
import SiteLogo from './SiteLogo'

export default function Header() {
  const auth = useOptionalAuthenticatedApi()
  const t = useT()
  const gatekeeperApps = useGatekeeperApps()
  const siteName = useSiteName()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const headerRef = useRef<HTMLElement>(null)

  // Click-outside handler to close mobile menu
  useEffect(() => {
    if (!mobileMenuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [mobileMenuOpen])

  const closeMobileMenu = () => setMobileMenuOpen(false)

  const navLinkClass = "text-sm px-3 py-1.5 rounded-md transition-colors text-kumo-subtle"
  const navLinkActiveClass = "text-sm font-medium px-3 py-1.5 rounded-md transition-colors text-kumo-default bg-kumo-tint"

  return (
    <header
      ref={headerRef}
      className="app-header sticky top-0 z-50 backdrop-blur-md border-b border-kumo-line"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)',
      }}
      >
      <div className="relative px-4 sm:px-6 h-14 flex items-center justify-between">
        <TopBarNotice />
        {/* Logo */}
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2">
            <SiteLogo size={22} className="shrink-0">
              <Hexagon size={22} className="text-kumo-brand" weight="bold" />
            </SiteLogo>
            <span className="text-base font-semibold tracking-tight text-kumo-default">
              {siteName}
            </span>
          </Link>

          {/* Desktop nav links */}
          <nav className="hidden sm:flex items-center gap-1">
            <Link
              to="/"
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
              activeOptions={{ exact: true }}
            >
              Home
            </Link>
            <Link
              to="/gatekeepers"
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
              activeOptions={{ exact: true }}
            >
              Gatekeepers
            </Link>
            <Link
              to="/explore"
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
            >
              Explore
            </Link>
            {gatekeeperApps.map((app) => (
              <Link
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                className={navLinkClass}
                activeProps={{ className: navLinkActiveClass }}
              >
                {localizeGatekeeperAppTitle(t, app)}
              </Link>
            ))}
          </nav>
        </div>

        {/* Right side */}
        <div className="flex items-center gap-2">
          {/* Desktop avatar dropdown */}
          {auth && (
            <div className="hidden sm:block">
              <UserMenu />
            </div>
          )}

          {/* Mobile hamburger button */}
          <div className="sm:hidden">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-kumo-tint transition-colors text-kumo-default"
            >
              {mobileMenuOpen ? <X size={20} /> : <List size={20} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile dropdown menu */}
      {mobileMenuOpen && (
        <div className="sm:hidden border-t border-kumo-line bg-kumo-base">
          <nav className="flex flex-col px-4 py-3 gap-1">
            <Link
              to="/"
              onClick={closeMobileMenu}
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
              activeOptions={{ exact: true }}
            >
              Home
            </Link>
            <Link
              to="/gatekeepers"
              onClick={closeMobileMenu}
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
              activeOptions={{ exact: true }}
            >
              Gatekeepers
            </Link>
            <Link
              to="/explore"
              onClick={closeMobileMenu}
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
            >
              Explore
            </Link>
            {gatekeeperApps.map((app) => (
              <Link
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                onClick={closeMobileMenu}
                className={navLinkClass}
                activeProps={{ className: navLinkActiveClass }}
              >
                {localizeGatekeeperAppTitle(t, app)}
              </Link>
            ))}

            {auth && (
              <>
                <hr className="my-2 border-kumo-line" />

                <Link
                  to="/profile"
                  onClick={closeMobileMenu}
                  className={navLinkClass}
                  activeProps={{ className: navLinkActiveClass }}
                >
                  Profile
                </Link>
                <Link
                  to="/providers"
                  onClick={closeMobileMenu}
                  className={navLinkClass}
                  activeProps={{ className: navLinkActiveClass }}
                >
                  Providers
                </Link>
                {auth.isAdmin && (
                  <Link
                    to="/admin"
                    onClick={closeMobileMenu}
                    className={navLinkClass}
                    activeProps={{ className: navLinkActiveClass }}
                  >
                    Admin
                  </Link>
                )}
                <button
                  onClick={() => { closeMobileMenu(); auth.logout() }}
                  className="text-left text-sm px-3 py-1.5 rounded-md text-kumo-danger hover:bg-kumo-tint transition-colors"
                >
                  Sign out
                </button>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  )
}
