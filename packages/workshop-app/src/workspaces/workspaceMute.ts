import type { NotificationMute, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { MuteLength } from '@/blocks/SidebarMenus'

/** Whether a workspace's notifications are muted now: a mute that has run out is no longer one. */
export const isWorkspaceMuted = ({ notificationMute: mute }: Pick<WorkspaceMetadataWithTimestamps, 'notificationMute'>) =>
  mute !== undefined && (mute.indefinite === true || mute.until.getTime() > Date.now())

// Tomorrow starts for being told things at eight in the morning.
const MORNING = 8

/** The mute a length asks for from `now`: an hour, until tomorrow morning, or until it is unmuted. */
export const muteFor = (length: MuteLength, now: Date = new Date()): NotificationMute => {
  if (length === 'always') return { indefinite: true }
  if (length === 'hour') return { until: new Date(now.getTime() + 60 * 60_000) }
  return { until: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, MORNING) }
}
