import { actionChangeTime, type ActionLogEntry, type AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

/** Something the agent asked to do outside the workspace, which a person approves or denies. */
export type ActionEntry = Extract<ActionLogEntry, { type: 'action' }>

/**
 * What became of an entry in a workspace's activity, as it is filtered and marked: an action
 * waiting on a person, approved by one, approved by a standing rule, or denied; something read; an
 * automation set up.
 */
export type ActivityOutcome = 'waiting' | 'approved' | 'auto' | 'denied' | 'read' | 'automation'

export const outcomeOf = (entry: ActionLogEntry): ActivityOutcome => {
  if (entry.type === 'observation') return 'read'
  if (entry.type === 'bindHook') return 'automation'
  if (entry.state === 'pending') return 'waiting'
  if (entry.state === 'rejected') return 'denied'
  return entry.autoApproved ? 'auto' : 'approved'
}

/** Whoever decided it, where a person did: the owner of the rule that approved it is not one. */
export const deciderOf = (entry: ActionLogEntry): AiChatAuthorInfo | undefined =>
  entry.type === 'action' && entry.state !== 'pending' && !entry.autoApproved ? entry.resolvedBy : undefined

/** A person's name as the viewer reads it: "you" for themselves. */
const named = (person: AiChatAuthorInfo, viewerId: string | undefined, start = false) =>
  person.type === 'user' && person.id === viewerId ? (start ? 'You' : 'you') : person.name

/** What it is, in a line: what the action does, what was read, the automation. */
export const activityTitle = (entry: ActionLogEntry): string => {
  const title = entry.description.title.trim()
  if (entry.type === 'observation') return title ? `Read ${title}` : entry.resourceTitle ? `Read ${entry.resourceTitle}` : 'Read a resource'
  return title || entry.resourceTitle || (entry.type === 'bindHook' ? 'An automation' : 'An action')
}

/**
 * How it stands, in a few words: "Approved by Ada", "Auto-approved by your rule", "Denied by you",
 * "Waiting", "Read", "Automation on", "Automation paused", "Automation removed".
 */
export const activityStatus = (entry: ActionLogEntry, viewerId?: string): string => {
  if (entry.type === 'observation') return 'Read'
  if (entry.type === 'bindHook') return entry.hookId === undefined ? 'Automation removed' : entry.enabled ? 'Automation on' : 'Automation paused'
  if (entry.state === 'pending') return 'Waiting'
  const by = entry.resolvedBy
  if (entry.autoApproved) {
    if (!by) return 'Auto-approved'
    return by.type === 'user' && by.id === viewerId ? 'Auto-approved by your rule' : `Auto-approved by ${by.name}’s rule`
  }
  const verb = entry.state === 'approved' ? 'Approved' : 'Denied'
  return by ? `${verb} by ${named(by, viewerId)}` : verb
}

/** When it last changed: as it was decided, or else as it was made. */
export const activityTime = (entry: ActionLogEntry): Date => actionChangeTime(entry)
