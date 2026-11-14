import { createRouter as createTanStackRouter, stringifySearchWith } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export const createRouter = () =>
  createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    // Values are read back as JSON where they look like it (`?chat=4` is a number), but a string
    // that does is written as it is, not quoted to keep it a string: `?open=12`, not `?open=%2212%22`.
    // Each route's `validateSearch` takes either.
    stringifySearch: stringifySearchWith(JSON.stringify),
  })

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
  interface HistoryState {
    /** The title of the chat being opened, when the page that opened it knew it. */
    chatTitle?: string
    /** This step showed the aside, so putting it away goes back (`useAsideNavigation`). */
    asideOpenedHere?: boolean
    /**
     * This page was opened from the one before it: an output's, expanded from beside a chat, or a
     * chat's settings, from the chat. The way back to that goes back.
     */
    fromChat?: boolean
    /**
     * This item's page was opened from the Library page, which is then what it is in: going up
     * from it on a narrow screen goes there rather than to the item's workspace.
     */
    fromLibrary?: boolean
  }
}
