import { createContext, useContext } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'

export const GatekeeperAppsContext = createContext<readonly GatekeeperAppInfo[]>([])

/**
 * The management apps of the user's gatekeepers (`listGatekeeperApps()`), in the order the backend
 * gives them, each with its title and icon: none until they are read, or beneath no
 * `GatekeeperAppsProvider`.
 */
export const useGatekeeperApps = () => useContext(GatekeeperAppsContext)
