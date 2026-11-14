import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { SkillsContext } from './SkillsContext'
import { SkillsLibrary } from './SkillsLibrary'

/**
 * One list of the user's skills for everything beneath it: the Library's Skills tab, a skill's
 * page and the composer's skills. Nothing is read until one of them is shown; a new connection
 * reads them again, keeping what is shown meanwhile.
 */
export const SkillsProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  // The API it reads with, read when it does.
  const latestApi = useRef(api)
  const [library] = useState(() => new SkillsLibrary(() => latestApi.current))

  useEffect(() => () => library.stop(), [library])

  // Over a lost connection it could only fail; the new connection's `api` reads them again.
  useLayoutEffect(() => {
    if (reconnecting || latestApi.current === api) return
    latestApi.current = api
    library.restart()
  }, [api, reconnecting, library])

  return <SkillsContext value={library}>{children}</SkillsContext>
}
