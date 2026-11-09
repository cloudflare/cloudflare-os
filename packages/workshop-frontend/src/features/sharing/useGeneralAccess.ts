import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, ShareLinkInfo, WorkpieceId } from '@gadgets/workshop-shared/api'

/**
 * Whether anyone who can sign in to this deployment may open the gadget from its link. That is the
 * gadget's share link: one link, on or off, rather than links managed one by one.
 *
 * - `on`: `url` carries a key minted this session, ready to copy. Copying must not wait on the
 *   server (a clipboard write is refused once the click that asked for it is past), so the key is
 *   minted as soon as the link is known to exist.
 */
export type GeneralAccess =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'off' }
  | { kind: 'on'; linkIds: string[]; url: string | null }

// Where a recipient lands: the workspace, opened on the gadget. A key rides in the fragment,
// which browsers never send to a server.
export const gadgetUrl = (workspaceId: string, gadgetId: WorkpieceId, key?: string): string => {
  const url = new URL(`/workspace/${workspaceId}`, window.location.origin)
  url.searchParams.set('w', String(gadgetId))
  if (key !== undefined) url.hash = `share=${key}`
  return url.href
}

// Links made before a gadget had a single one still grant it; all of them are "the" link.
const linksFor = (links: ShareLinkInfo[], gadgetId: WorkpieceId) =>
  links.filter(link => link.role === 'use' && link.gadgetId === gadgetId)

export const useGeneralAccess = ({ overseer, open, workspaceId, gadgetId, onChanged }: {
  overseer: RpcStub<Overseer>
  /** Loads while the dialog is open. */
  open: boolean
  workspaceId: string
  gadgetId: WorkpieceId
  /** Who holds the gadget may have changed. */
  onChanged: () => void
}) => {
  const [state, setState] = useState<GeneralAccess>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const request = useRef(0)

  useEffect(() => {
    if (!open) return
    const id = ++request.current
    setState({ kind: 'loading' })
    ;(async () => {
      const linkIds = linksFor(await overseer.listShareLinks(), gadgetId).map(link => link.linkId)
      if (id !== request.current) return
      if (linkIds.length === 0) { setState({ kind: 'off' }); return }
      setState({ kind: 'on', linkIds, url: null })
      const { key } = await overseer.newShareLinkKey(linkIds[0]!)
      if (id === request.current) setState({ kind: 'on', linkIds, url: gadgetUrl(workspaceId, gadgetId, key) })
    })().catch(() => { if (id === request.current) setState({ kind: 'failed' }) })
    return () => { request.current++ }
  }, [open, overseer, workspaceId, gadgetId])

  /**
   * Turn the link on or off. Turning it off keeps everyone who already opened the gadget through
   * it: they are listed among the people it is shared with, and are removed one by one like
   * anyone else, never all at once by a switch.
   */
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (busy || state.kind === 'loading' || state.kind === 'failed') return
    if (enabled === (state.kind === 'on')) return
    const id = ++request.current
    setBusy(true)
    try {
      if (enabled) {
        const { key, linkId } = await overseer.createShareLink({ gadgetId })
        if (id === request.current) {
          setState({ kind: 'on', linkIds: [linkId], url: gadgetUrl(workspaceId, gadgetId, key) })
        }
      } else if (state.kind === 'on') {
        for (const linkId of state.linkIds) {
          const affected = await overseer.previewRevokeShareLink(linkId)
          await overseer.revokeShareLink(linkId, affected.map(person => person.profile.id))
        }
        if (id === request.current) setState({ kind: 'off' })
        onChanged()
      }
    } finally {
      setBusy(false)
    }
  }, [busy, state, overseer, workspaceId, gadgetId, onChanged])

  return { state, busy, setEnabled }
}
