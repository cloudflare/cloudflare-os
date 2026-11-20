/** What a question of the user's access is for: a workspace as a whole, or one gadget of it. */
export type AccessQuestionPlace = { workspaceId: string; gadgetId?: number }

/** Where a gadget's pane asks in place (`useAccessQuestion`), or any pane of its workspace's, without a gadget. */
export const placeOf = (workspaceId: string, gadgetId: number | undefined) => `${workspaceId}/${gadgetId ?? ''}`

/** The page beside the sidebar (`usePageAccessQuestion`), which asks what no pane of the workspace does. */
export const PAGE = 'page'

/**
 * Where a question is asked, of the places that ask (`hosts`): in the pane of the gadget it is
 * for, or, for one of its workspace's as a whole, a pane of any gadget of that workspace, else the
 * page. Undefined where there is none.
 */
export const holderOf = ({ workspaceId, gadgetId }: AccessQuestionPlace, hosts: readonly string[]) => {
  if (gadgetId !== undefined) {
    const exact = placeOf(workspaceId, gadgetId)
    return hosts.includes(exact) ? exact : undefined
  }
  return hosts.find((place) => place.startsWith(`${workspaceId}/`)) ?? (hosts.includes(PAGE) ? PAGE : undefined)
}

/**
 * The question to ask now: the first that can be. A gadget's is asked only in its own pane, as
 * what reads it in the background (its agents, say) is no reason to ask: it waits until the gadget
 * is shown, or its workspace is left. A workspace's is asked wherever it can be, the whole window
 * where nothing else can.
 */
export const askable = <Question extends AccessQuestionPlace>(queued: readonly Question[], hosts: readonly string[]) =>
  queued.find((each) => each.gadgetId === undefined || holderOf(each, hosts) !== undefined)
