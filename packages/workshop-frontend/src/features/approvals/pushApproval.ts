import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

/** Whether an entry is a push to a git remote: an action that names the commits it sends. */
export const isPush = (entry: ActionLogEntry): boolean =>
  entry.type === 'action' && (entry.description.pushedCommits?.length ?? 0) > 0

/**
 * Whether approving an entry goes through the review of its commits: a push, in a workspace
 * that holds restricted data. There the approver vouches for what they read, and a push's
 * content is in its commits, not in its description.
 *
 * `restricted` is `undefined` while the workspace's metadata has not loaded, and that reads as
 * unrestricted, exactly as it does for the restricted notice. The mark is a property of the
 * Workshop's surface, not the gate: the kernel judged the push when it was queued.
 */
export const reviewsBeforeApproving = (entry: ActionLogEntry, restricted: boolean | undefined): boolean =>
  restricted === true && isPush(entry)
