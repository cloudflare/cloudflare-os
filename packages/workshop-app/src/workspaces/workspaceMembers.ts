import type { AiChatAuthorInfo, CollaboratorInfo, CollaboratorRole } from '@gadgets/workshop-shared/api'

/** Someone with access to a workspace, and what they may do in it. */
export type WorkspaceMember = {
  profile: AiChatAuthorInfo
  role: 'owner' | CollaboratorRole
}

/**
 * Everyone with access to a workspace: its owner first, then its collaborators in the server's
 * order. The server leaves the owner out of its collaborators, and says who owns a workspace only
 * to those who do not, so `owner` is the workspace's `owner` or else the viewer.
 */
export const workspaceMembers = (owner: AiChatAuthorInfo, collaborators: readonly CollaboratorInfo[]): WorkspaceMember[] => [
  { profile: owner, role: 'owner' },
  ...collaborators
    .filter(({ profile }) => profile.id !== owner.id)
    .map(({ profile, access }) => ({ profile, role: access.role })),
]

/**
 * Those of `people` who are in the workspace, as it lists them: its owner and its members. Someone
 * only given one of its apps to use is not, as the old app had it: they are that app's, listed where
 * it is shared from. They still lose it with the workspace, so a count of who it is taken from is of
 * everyone.
 */
export const membersOnly = (people: readonly WorkspaceMember[]): WorkspaceMember[] => people.filter(({ role }) => role !== 'use')
