import { useCallback } from 'react'
import { useMatch, useNavigate } from '@tanstack/react-router'

/** The search parameters the workspace editor reads, on whichever route renders it. */
export type WorkspaceSearch = {
  chat?: number
  /**
   * Selected workpiece (gadget) ID. Workpiece IDs start at 0, so parsing must not treat 0 as
   * absent.
   */
  w?: number
  /**
   * Show the chat even where the workspace pane hides it (a notification's "Open task" asks for
   * this). The editor drops it once honoured.
   */
  showChat?: true
}

const parseIntParam = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return undefined
}

/**
 * A route's `validateSearch` for the editor's parameters. It returns those alone; the router
 * keeps whatever else the URL's search holds.
 */
export const validateWorkspaceSearch = (search: Record<string, unknown>): WorkspaceSearch => ({
  chat: typeof search.chat === 'number' ? search.chat
    : typeof search.chat === 'string' ? Number(search.chat) || undefined
    : undefined,
  w: parseIntParam(search.w),
  showChat: search.showChat === true || undefined,
})

/** What a navigation within the editor changes; the hash is always dropped. */
export type WorkspaceSearchNavigation = {
  search: WorkspaceSearch | ((prev: WorkspaceSearch) => WorkspaceSearch)
  replace?: boolean
}

/**
 * Navigates within the route that renders the caller: the same route and params with a new
 * search. Route and params are the rendering match's, fixed when the function is created, so a
 * call that lands after the user has moved on (an RPC resolving late) returns to the workspace it
 * was made for instead of writing that workspace's ids into whichever URL is current.
 */
export const useWorkspaceSearchNavigate = () => {
  const navigate = useNavigate()
  const { fullPath: to, params } = useMatch({ strict: false })
  return useCallback(
    ({ search, replace }: WorkspaceSearchNavigation) => navigate({ to, params, search, replace }),
    [navigate, to, params],
  )
}
