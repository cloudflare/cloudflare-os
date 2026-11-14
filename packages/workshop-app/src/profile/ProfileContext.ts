import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Profile, ProfileSnapshot } from './Profile'

export const ProfileContext = createContext<Profile | null>(null)

/** The signed-in user's profile, live, and the way to change it. Only beneath `ProfileProvider`. */
export const useProfile = (): { profile: Profile; snapshot: ProfileSnapshot } => {
  const profile = useContext(ProfileContext)
  if (!profile) throw new Error('useProfile must be used inside ProfileProvider')
  return { profile, snapshot: useSyncExternalStore(profile.subscribe, profile.getSnapshot) }
}
