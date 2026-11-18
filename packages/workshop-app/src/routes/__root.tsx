import { createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { legacyTarget } from './-legacy'

export const Route = createRootRoute({
  // The old Workshop's addresses, as people kept them and the server still links to them.
  beforeLoad: ({ location }) => {
    const target = legacyTarget(location.pathname, location.search as Record<string, unknown>)
    if (target) throw redirect({ href: target.href, replace: true })
  },
  component: () => (
    // Clipped at the window's sides: with the aside put away, the reach of the handle that brings it
    // back runs on past the edge, which would make the page scroll sideways. Nothing there can be
    // pointed at anyway.
    // As tall as the window, and no taller than the page is laid out in: on Android an on-screen
    // keyboard makes that shorter (`interactive-widget` in `index.html`) but not the window as
    // viewport units have it, and a frame taller than it runs on under the keyboard, where the
    // browser scrolls only the line being typed into sight.
    <div className="h-dvh max-h-full overflow-x-clip bg-kumo-canvas text-kumo-default">
      <Outlet />
    </div>
  ),
})
