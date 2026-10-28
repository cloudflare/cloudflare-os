import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <div className="h-dvh bg-kumo-base text-kumo-default">
      <Outlet />
    </div>
  ),
})
