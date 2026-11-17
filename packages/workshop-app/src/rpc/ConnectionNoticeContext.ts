import { createContext, useContext } from 'react'
import type { ConnectionNotice } from './ConnectionNotice'

export const ConnectionNoticeContext = createContext<ConnectionNotice | null>(null)

/**
 * What the user is told about the connection to the backend while it is made again, and whether
 * what they ask for can be done meanwhile (`blocked`). Null where there is no connection to lose.
 */
export const useConnectionNotice = () => useContext(ConnectionNoticeContext)
