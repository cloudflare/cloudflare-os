import type { CommitInfo } from '@gadgets/workshop-shared/api'
import type { CodeBrowserCommit } from '@/blocks/CodeBrowser'
import { formatActivity } from '@/workspaces/formatActivity'

/** A commit as the history lists it: its message's first line, who kept it, and when. */
export const historyEntry = ({ oid, message, author, timestamp }: CommitInfo): CodeBrowserCommit =>
  ({ id: oid, summary: message.split('\n')[0]?.trim() || 'Kept changes', author: author.name, time: formatActivity(timestamp) })

/** When the code shown was kept, as the footer says it: "Kept 5 min ago", "Kept yesterday", "Kept on Aug 2". */
export const keptWhen = (date: Date) => {
  const when = formatActivity(date)
  if (when.endsWith('ago')) return `Kept ${when}`
  if (when === 'Just now' || when === 'Yesterday') return `Kept ${when.toLowerCase()}`
  return `Kept on ${when}`
}
