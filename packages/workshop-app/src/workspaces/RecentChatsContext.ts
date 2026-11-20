import { createContext, useContext } from 'react'
import type { RecentChats } from './RecentChatsStore'

/** The viewer's recent chats, live from the account (`RecentChatsProvider`). */
export const RecentChatsContext = createContext<RecentChats | null>(null)

/** The viewer's recent chats beneath `RecentChatsProvider`; null elsewhere. */
export const useRecentChatsContext = (): RecentChats | null => useContext(RecentChatsContext)
