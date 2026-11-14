import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { hashPassword } from './passwordHash'
import { Profile } from './Profile'
import { ProfileContext } from './ProfileContext'

/**
 * Holds the signed-in user's profile for everything beneath it: the sidebar's account button,
 * Home's greeting, and the profile page. A new connection reads it again, keeping what is shown.
 */
export const ProfileProvider = ({ children }: { children: ReactNode }) => {
  const { api, user, reconnecting } = useApi()
  // The API it reads with, read when it does.
  const latestApi = useRef(api)
  const [profile] = useState(() => new Profile(() => latestApi.current, user, hashPassword))

  useEffect(() => {
    profile.start()
    return () => profile.stop()
  }, [profile])

  // Over a lost connection it could only fail; the new connection's `api` reads it again.
  useLayoutEffect(() => {
    if (reconnecting || latestApi.current === api) return
    latestApi.current = api
    profile.start()
  }, [api, reconnecting, profile])

  return <ProfileContext value={profile}>{children}</ProfileContext>
}
