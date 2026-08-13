import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * Legacy URL. Workspaces historically lived at /gadget/$id (from when each workspace held
 * exactly one gadget); the editor now lives at /workspace/$id. Redirect old links there,
 * preserving search params (?chat=, ?w=) and the hash (#share=, #fullscreen).
 */
export const Route = createFileRoute('/gadget/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/workspace/$id',
      params: { id: params.id },
      search: true,
      hash: true,
      replace: true,
    })
  },
  component: () => null,
})
