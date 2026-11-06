import { createFileRoute } from '@tanstack/react-router'

/**
 * A gatekeeper app's own path, /gatekeepers/$appId/<path>. It renders nothing: the parent route
 * hosts the app and passes it the path, so moving between paths never remounts the app's iframe.
 */
export const Route = createFileRoute('/gatekeepers_/$appId/$')({})
