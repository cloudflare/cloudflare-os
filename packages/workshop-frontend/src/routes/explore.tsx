import { createFileRoute, redirect } from '@tanstack/react-router'

/** Explore became the Blueprints page; old links land on its Featured tab. */
export const Route = createFileRoute('/explore')({
  beforeLoad: () => {
    throw redirect({ to: '/blueprints', replace: true })
  },
})
