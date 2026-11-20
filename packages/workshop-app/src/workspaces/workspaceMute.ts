import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

/** Whether a workspace's notifications are muted now: a mute that has run out is no longer one. */
export const isWorkspaceMuted = ({ notificationMute: mute }: Pick<WorkspaceMetadataWithTimestamps, 'notificationMute'>) =>
  mute !== undefined && (mute.indefinite === true || mute.until.getTime() > Date.now())
