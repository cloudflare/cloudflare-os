import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ChangeDefaultsGroup } from '@/blocks/ChangeDefaultsList'

/**
 * Every kind of change a service's gatekeeper says it can make, under the kind of thing it changes,
 * in the order the service lists them (`SupportedResource.actionKinds`). A kind is the service's,
 * not the thing's, so one that several kinds of thing share (Drive's sharing, on a Doc and on a
 * folder) is listed once, under the first; a kind of thing with nothing to change is left out.
 * `automatic` says which the user has made go ahead without asking, by tag, and `alsoIn` which
 * workspaces let one go ahead though the service asks, by tag.
 */
export const changeGroups = (
  resources: readonly SupportedResource[],
  automatic: ReadonlySet<string>,
  alsoIn: ReadonlyMap<string, readonly string[]> = new Map(),
): ChangeDefaultsGroup[] => {
  const listed = new Set<string>()
  return resources.flatMap(({ urlPattern, title, icon, actionKinds = [] }) => {
    const changes = actionKinds.filter(({ kind }) => !listed.has(kind.tag)).map(({ kind, autoApprovable }) => {
      listed.add(kind.tag)
      const on = autoApprovable && automatic.has(kind.tag)
      const workspaces = autoApprovable && !on ? alsoIn.get(kind.tag) : undefined
      return { kind, autoApprovable, automatic: on, ...(workspaces?.length ? { alsoIn: [...workspaces] } : {}) }
    })
    return changes.length ? [{ key: urlPattern, title, iconUrl: icon?.url, changes }] : []
  })
}
