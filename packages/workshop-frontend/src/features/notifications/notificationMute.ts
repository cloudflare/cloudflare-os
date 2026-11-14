import type { NotificationMute } from '@gadgets/workshop-shared/api'

/**
 * How a workspace's mute reads while it lasts ("Muted until Oct 16, 2026, 5:00 PM"), or undefined if
 * the workspace isn't muted. A timed mute stays on the record after it ends, and ends the moment its
 * time passes, as the backend reads it.
 */
export const describeMute = (mute: NotificationMute | undefined): string | undefined => {
  if (!mute) return undefined
  if ('indefinite' in mute) return 'Muted'
  if (mute.until.getTime() <= Date.now()) return undefined
  return `Muted until ${mute.until.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
}
