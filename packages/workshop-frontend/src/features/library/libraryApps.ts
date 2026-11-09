/**
 * The gatekeeper management apps the Library hosts as tabs, by the tab, with the app's id (see
 * useGatekeeperApps): what is scheduled and the skills agents can use are things the user has, so
 * they live beside gadgets and files rather than on pages of their own.
 */
export const LIBRARY_APPS = { skills: 'context', scheduled: 'scheduler' } as const

/** A Library tab that hosts a gatekeeper's app. */
export type LibraryAppTab = keyof typeof LIBRARY_APPS

/** The Library tab hosting app `appId`, if one does. */
export const libraryTabOfApp = (appId: string): LibraryAppTab | undefined =>
  (Object.keys(LIBRARY_APPS) as LibraryAppTab[]).find(tab => LIBRARY_APPS[tab] === appId)
