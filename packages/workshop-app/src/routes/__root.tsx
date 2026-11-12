import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    // Clipped at the window's sides: with the aside put away, the reach of the handle that brings it
    // back runs on past the edge, which would make the page scroll sideways. Nothing there can be
    // pointed at anyway.
    <div className="h-dvh overflow-x-clip bg-kumo-canvas text-kumo-default">
      <Outlet />
    </div>
  ),
})
