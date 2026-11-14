import type { WorkspaceMetadata } from '@gadgets/workshop-shared/api'

/**
 * A workspace made on purpose and named (`WorkspaceMetadata.kind`), which holds any number of
 * chats, apps and files and is listed among the user's workspaces. Any other holds a chat started
 * outside any workspace, which is shown as that chat alone: its workspace is never named.
 */
export const isNamedWorkspace = (workspace: Pick<WorkspaceMetadata, 'kind'> | undefined) => workspace?.kind === 'workspace'
