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
    // A collaborator with no role was added before roles, when everyone could build.
    .map(({ profile, role }) => ({ profile, role: role ?? 'build' })),
]
