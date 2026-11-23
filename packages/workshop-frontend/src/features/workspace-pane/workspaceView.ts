import type { GadgetSummary, WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'

/**
 * What the workspace pane shows: a workpiece (`app`, any of its tabs), nothing (`chat`, the pane
 * closed), or activity. `appId` is the workpiece the editor selects. Open, it is the one shown, and
 * is absent only while lazily migrating the legacy "open" value. Closed or showing activity, it is
 * the one the pane was showing, so that leaving it doesn't move the selection; that is kept in
 * memory only, never persisted.
 */
export type WorkspaceView =
  | { mode: 'chat'; appId?: WorkpieceId }
  | { mode: 'app'; appId?: WorkpieceId }
  | { mode: 'activity'; appId?: WorkpieceId }

/** The view with the pane closed, remembering the selected workpiece. */
export const closedWorkspaceView = (selected: WorkpieceId | null): Extract<WorkspaceView, { mode: 'chat' }> =>
  selected === null ? { mode: 'chat' } : { mode: 'chat', appId: selected }

/** The view with the pane open on `appId`, or, if none is named, on the one `view` remembers. */
export const openedWorkspaceView = (view: WorkspaceView | null, appId?: WorkpieceId): WorkspaceView =>
  ({ mode: 'app', appId: appId ?? view?.appId })

/**
 * The selected workpiece: explicit URL state wins, followed by the one the view names (only
 * accepted apps are persisted, so a draft only within this session), then the workspace default
 * and the first visible one. Each must be visible to the selected chat.
 */
export const selectWorkpiece = ({ urlWorkpieceId, view, visibleWorkpieces, visibleGadgets, defaultGadgetId }: {
  urlWorkpieceId: WorkpieceId | null
  view: WorkspaceView | null
  visibleWorkpieces: readonly WorkpieceSummary[]
  visibleGadgets: readonly GadgetSummary[]
  defaultGadgetId: WorkpieceId | undefined
}): WorkpieceId | null => {
  if (urlWorkpieceId !== null && visibleWorkpieces.some(g => g.id === urlWorkpieceId)) {
    return urlWorkpieceId
  }
  const viewId = view?.appId
  if (viewId !== undefined && visibleWorkpieces.some(g => g.id === viewId)) return viewId
  if (defaultGadgetId !== undefined && visibleGadgets.some(g => g.id === defaultGadgetId)) {
    return defaultGadgetId
  }
  return visibleWorkpieces.length > 0 ? visibleWorkpieces[0].id : null
}

// Keep the old key prefix so existing "open" / "closed" preferences can migrate lazily.
const WORKSPACE_VIEW_STORAGE_KEY_PREFIX = 'gadgets:workshop:workspaceVisibility:'

// Per-workspace keys may outlive deleted workspaces, but each entry is tiny and bounded by
// workspaces created or opened.
const workspaceViewStorageKey = (gadgetId: string) => `${WORKSPACE_VIEW_STORAGE_KEY_PREFIX}${gadgetId}`

/** Stores the view for `gadgetId`. A closed pane is stored without the workpiece it remembers. */
export const persistWorkspaceView = (
  gadgetId: string,
  view: Extract<WorkspaceView, { mode: 'chat' }> | { mode: 'app'; appId: WorkpieceId },
) => {
  try {
    window.localStorage.setItem(workspaceViewStorageKey(gadgetId),
      JSON.stringify(view.mode === 'chat' ? { mode: 'chat' } : { mode: 'app', appId: view.appId }))
  } catch {
    // The preference still works for the current session when storage is unavailable.
  }
}

/** The view stored for `gadgetId`, migrating the legacy "open" / "closed" values. */
export const getStoredWorkspaceView = (gadgetId: string | undefined): WorkspaceView | null => {
  if (typeof window === 'undefined' || !gadgetId) return null
  try {
    const stored = window.localStorage.getItem(workspaceViewStorageKey(gadgetId))
    if (stored === 'open') return { mode: 'app' }
    if (stored === 'closed') {
      const view = { mode: 'chat' } as const
      persistWorkspaceView(gadgetId, view)
      return view
    }
    if (!stored) return null

    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null || !('mode' in parsed)) return null
    if (parsed.mode === 'chat') return { mode: 'chat' }
    if (parsed.mode === 'app' && 'appId' in parsed &&
        typeof parsed.appId === 'number' && Number.isInteger(parsed.appId)) {
      return { mode: 'app', appId: parsed.appId }
    }
    return null
  } catch {
    return null
  }
}
