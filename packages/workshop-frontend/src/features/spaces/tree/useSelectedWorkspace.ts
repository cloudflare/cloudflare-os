import { useLocation, useMatch, useNavigate } from '@tanstack/react-router'

// The search parameter holding the previewed workspace's id, so that a preview can be linked to
// and Back returns to the one before.
const SELECTED_PARAM = 'selected'

/**
 * The id of the workspace a space's tree previews, from the URL; undefined while none is selected.
 * It need not be one the tree shows.
 */
export const useSelectedWorkspaceId = (): string | undefined => {
  const selected = useLocation({
    select: location => (location.search as Record<string, unknown>)[SELECTED_PARAM],
  })
  return typeof selected === 'string' && selected !== '' ? selected : undefined
}

/**
 * The previewed workspace's id (`useSelectedWorkspaceId`), and the way to preview another: a
 * navigation of its own, so Back returns to the previous one. Every other search parameter is kept.
 */
export const useSelectedWorkspace = (): [string | undefined, (id: string) => void] => {
  const navigate = useNavigate()
  const { fullPath, params } = useMatch({ strict: false })
  const select = (id: string) => void navigate({
    to: fullPath,
    params,
    search: (previous: Record<string, unknown>) => ({ ...previous, [SELECTED_PARAM]: id }),
  })
  return [useSelectedWorkspaceId(), select]
}
