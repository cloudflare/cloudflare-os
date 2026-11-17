import { useEffect, useState } from 'react'
import type { UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type UserSearch = { people: UserDirectoryRecord[]; searching: boolean; failed: boolean }

// Typing is waited out this long before asking, so each keystroke does not.
const PAUSE = 150

/**
 * The people in the deployment who match `query`, leaving out `exclude` (who have access already).
 * Nothing while not `enabled`, as where the deployment cannot be searched.
 */
export const useUserSearch = (query: string, enabled: boolean, exclude: readonly string[]): UserSearch | undefined => {
  const { api, reconnecting } = useApi()
  const [found, setFound] = useState<{ query: string; people: UserDirectoryRecord[]; failed: boolean }>()
  const trimmed = query.trim()
  // By content, as the list is worked out again each render.
  const excluded = exclude.join('\n')

  useEffect(() => {
    if (!enabled || reconnecting || trimmed === '') return
    let cancelled = false
    const timer = setTimeout(() => {
      api.searchUsers(trimmed, excluded ? excluded.split('\n') : []).then(
        (people) => { if (!cancelled) setFound({ query: trimmed, people, failed: false }) },
        () => { if (!cancelled) setFound({ query: trimmed, people: [], failed: true }) },
      )
    }, PAUSE)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, reconnecting, enabled, trimmed, excluded])

  if (!enabled) return undefined
  // What was found for something typed earlier is kept up until the answer for this arrives.
  const current = found?.query === trimmed
  return { people: found?.people ?? [], searching: !current, failed: current && found.failed }
}
