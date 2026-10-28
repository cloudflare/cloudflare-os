import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <div className="h-dvh bg-kumo-canvas text-kumo-default">
      <Outlet />
    </div>
  ),
})
