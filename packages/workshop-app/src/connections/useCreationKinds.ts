import { useEffect, useState } from 'react'
import { connectedKindOfUrl, type ConnectedFileKind } from '@/files/connectedFile'
import { useApi } from '@/rpc/ApiContext'

// What each creation's gatekeeper makes, by workspace and gatekeeper: it never changes.
const known = new Map<string, ConnectedFileKind | null>()

/**
 * What kind of Google file each of `gatekeeperIds` will create, such as a Slides deck, read from
 * its creation spec's resource pattern (`getCreationSpec`), so that a file not made yet is shown
 * as what it will be. Null for one that makes something else; absent until it is known.
 */
export const useCreationKinds = (workspaceId: string, gatekeeperIds: readonly number[]) => {
  const { api, reconnecting } = useApi()
  const [, setRead] = useState(0)
  const wanted = gatekeeperIds.filter((id) => !known.has(`${workspaceId}/${id}`)).join(',')

  useEffect(() => {
    if (!wanted || reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    const asked = wanted.split(',').map(Number).map((id) => {
      const gatekeeper = overseer.getGatekeeperById(id)
      return gatekeeper.getCreationSpec().then(
        (spec) => known.set(`${workspaceId}/${id}`, spec.type === 'gatekeeper' ? connectedKindOfUrl(spec.typeUrlPattern) ?? null : null),
        // Shown as a request, as it was, and asked again next time.
        () => {},
      ).finally(() => gatekeeper[Symbol.dispose]())
    })
    void Promise.all(asked).then(() => {
      overseer[Symbol.dispose]()
      if (!cancelled) setRead((count) => count + 1)
    })
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, workspaceId, wanted])

  return (gatekeeperId: number) => known.get(`${workspaceId}/${gatekeeperId}`) ?? undefined
}
