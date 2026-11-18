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
     * This page was opened from the one before it: an output's, expanded from beside a chat or a
     * workspace's page, or a chat's settings, from the chat. The way back to that goes back.
     */
    fromChat?: boolean
    /**
     * This item's page was opened from the Library page, which is then what it is in: going up
     * from it on a narrow screen goes there rather than to the item's workspace.
     */
    fromLibrary?: boolean
    /**
     * This step opened the settings, from the user's own button in the sidebar, so the button
     * leaves them by going back.
     */
    settingsOpenedHere?: boolean
    /**
     * This step went into a part of the settings from the list of them, on a narrow screen, so
     * the way back to the list goes back.
     */
    settingsPartOpenedHere?: boolean
    /** This skill's page was opened from the list of them, so the way back to the list goes back. */
    fromSkillList?: boolean
    /** This gadget's settings were opened from the gadget, so the way back to it goes back. */
    fromItem?: boolean
    /**
     * The title of the gadget whose settings are being opened, when the page that opened them knew
     * it, or of the gadget a new chat is started beside, which greets the user by it.
     */
    gadgetTitle?: string
    /** What a new chat's composer starts with written in it, to be changed before it is sent, such as something to ask for picked from the Automations page. */
    draft?: string
  }
}
