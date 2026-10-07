import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { buildWorkspaceTree, type WorkspaceTreeNode } from './workspaceTree'

/**
 * The parent option standing for the top of the space's tree. No workspace id can equal it: ids
 * are url-safe base64, which has no space.
 */
export const TOP_OF_TREE = 'top of the tree'

/** What an entry is called where it is offered: its title, or a stand-in when it has none. */
export const titleOf = (entry: SpaceWorkspaceInfo) => entry.title || 'Untitled Workspace'

/**
 * A place in a space's tree that something can go under: an entry's id, or `TOP_OF_TREE`.
 * `ancestors` are the titles of the entries above it, from the top, so their count is its depth:
 * they tell apart entries of one title to those who cannot see the indentation.
 */
export type ParentOption = { value: string; label: string; ancestors: string[] }

/**
 * The top of the space and every entry of `listing`, in tree order, as places to go under, minus
 * each entry `excluded` picks out and everything under it, such as the entry being moved, under
 * which the space refuses to put it.
 */
export const parentOptions = (
  listing: readonly SpaceWorkspaceInfo[],
  excluded: (entry: SpaceWorkspaceInfo) => boolean = () => false,
): ParentOption[] => {
  const options: ParentOption[] = [{ value: TOP_OF_TREE, label: 'Top of the space', ancestors: [] }]
  const walk = (nodes: WorkspaceTreeNode[], ancestors: string[]) => {
    for (const { entry, children } of nodes) {
      if (excluded(entry)) continue
      options.push({ value: entry.id, label: titleOf(entry), ancestors })
      walk(children, [...ancestors, titleOf(entry)])
    }
  }
  walk(buildWorkspaceTree(listing), [])
  return options
}
