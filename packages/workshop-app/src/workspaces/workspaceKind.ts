import type { WorkspaceMetadata } from '@gadgets/workshop-shared/api'

/**
 * A workspace made on purpose and named (`WorkspaceMetadata.kind`), which holds any number of
 * chats, apps and files and is listed among the user's workspaces. Any other holds a chat started
 * outside any workspace, which is shown as that chat alone: its workspace is never named.
 */
export const isNamedWorkspace = (workspace: Pick<WorkspaceMetadata, 'kind'> | undefined) => workspace?.kind === 'workspace'

/**
 * What the server calls a workspace made without a title, until its first chat is titled, when it
 * takes the chat's title.
 */
export const UNTITLED_WORKSPACE = 'Untitled Workspace'
