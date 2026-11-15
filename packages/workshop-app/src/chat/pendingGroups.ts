import type { ActionItem, ActionTarget, ChatItem } from './chatItems'

/** Everything waiting on one thing, such as the edits to one Google Doc, as the tray lists it. */
export type PendingGroup = {
  key: string
  target: ActionTarget
  /** Oldest first, the order they apply in. */
  actions: ActionItem[]
  /** One of them creates the thing, which the rest then change. */
  creates: boolean
  /** One of them holds the agent until it is decided. */
  holdsAgent: boolean
}

/** The approvals waiting among a chat's rows. */
export const pendingActions = (rows: readonly ChatItem[]): ActionItem[] =>
  rows.filter((item): item is ActionItem => item.kind === 'action' && item.state === 'pending')

/**
 * The approvals waiting, by what they act on (`ActionTarget.key`), in the order the first of each
 * was asked for. Within a group they are in the order they were asked for, which is the order they
 * apply in, so an edit never lands before the one it builds on.
 */
export const pendingGroups = (actions: readonly ActionItem[]): PendingGroup[] => {
  const groups = new Map<string, PendingGroup>()
  for (const action of actions.toSorted((a, b) => a.actionId - b.actionId)) {
    const { key } = action.target
    const group = groups.get(key) ?? { key, target: action.target, actions: [], creates: false, holdsAgent: false }
    group.actions.push(action)
    group.creates ||= action.creation !== undefined
    group.holdsAgent ||= action.holdsAgent
    // A file's own name, once an action names it, over the connection's.
    if (action.target.subjectId && !group.target.subjectId) group.target = action.target
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** "1 edit", "3 edits": how many changes wait on a file; "1 request" for anything else. */
export const pendingCount = (group: PendingGroup) => {
  const count = group.actions.length - (group.creates ? 1 : 0)
  const noun = group.target.fileKind ? 'change' : 'request'
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** "3 changes" and the like, for the tray's heading. */
export const changesWaiting = (count: number) => `${count} ${count === 1 ? 'change waits' : 'changes wait'} for you`

/** A file's changes in one chat: those waiting, and those decided since it was drawn. */
export type FileChanges = {
  /** Oldest first. */
  waiting: ActionItem[]
  /** By log id: approved ones settled, denied ones undone. */
  decided: Map<number, 'approved' | 'rejected'>
}

/**
 * The changes a chat asks for to one file (`gatekeeperId`, `subjectId`, empty for one not made yet,
 * whose creation and edits name none), for reviewing them on it:
 * those waiting, and those decided, which the file draws as decided while it was drawn with them
 * (`ResourcePreview.actions`), until it is drawn again. A run of decisions folded into one row
 * (`ActionItem.runOf`) counts each of its own.
 */
export const fileChanges = (rows: readonly ChatItem[], gatekeeperId: number, subjectId: string): FileChanges => {
  const waiting: ActionItem[] = []
  const decided = new Map<number, 'approved' | 'rejected'>()
  for (const item of rows) {
    if (item.kind !== 'action' || item.target.gatekeeperId !== gatekeeperId || (item.target.subjectId ?? '') !== subjectId) continue
    if (item.state === 'pending') {
      waiting.push(item)
      continue
    }
    for (const { actionId } of item.runOf ?? [item]) {
      decided.set(actionId, item.state === 'approved' ? 'approved' : 'rejected')
    }
  }
  return { waiting: waiting.toSorted((a, b) => a.actionId - b.actionId), decided }
}
