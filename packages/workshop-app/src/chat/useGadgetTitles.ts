import { useEffect, useState } from 'react'
import { RpcTarget } from 'capnweb'
import type { OutputIcon, WorkpieceSummary, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

/** A gadget as the workspace has it: its title, and the icon of its format where it was built as one. */
export type GadgetTitle = { title: string; icon?: OutputIcon }

// Hears the workspace's workpieces once over, for the titles of some of them.
class TitleReader extends RpcTarget implements WorkpiecesSubscriber {
  #found = new Map<number, GadgetTitle>()
  constructor(private readonly wanted: ReadonlySet<number>, private readonly done: (found: ReadonlyMap<number, GadgetTitle>) => void) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (this.wanted.has(summary.id) && summary.title) {
      this.#found.set(summary.id, { title: summary.title, icon: summary.type === 'gadget' ? summary.output?.icon : undefined })
    }
  }

  removed() {}

  ready() {
    this.done(this.#found)
  }
}

const NONE: ReadonlyMap<number, GadgetTitle> = new Map()

/**
 * The titles of the gadgets `gadgetIds`, and their formats' icons, as the workspace has them
 * (`subscribeToWorkpieces`, let go of once it has listed them): for naming a gadget a chat changes
 * that its conversation does not. Read again only when another is asked for, keeping what was
 * found meanwhile. Empty until read, or where it could not be.
 */
export const useGadgetTitles = (workspaceId: string, gadgetIds: readonly number[]): ReadonlyMap<number, GadgetTitle> => {
  const { api, reconnecting } = useApi()
  const [titles, setTitles] = useState<{ workspaceId: string; asked: string; found: ReadonlyMap<number, GadgetTitle> }>()
  // As a string, so that the same gadgets asked for by a new array read nothing again.
  const asked = [...new Set(gadgetIds)].toSorted((a, b) => a - b).join(',')

  useEffect(() => {
    if (!asked || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const wanted = new Set(asked.split(',').map(Number))
    // The subscription, once made, is let go of as soon as it has listed them, or the titles are no longer wanted.
    let heard = false
    let made: Disposable | undefined
    let open = true
    const letGo = () => {
      made?.[Symbol.dispose]()
      made = undefined
    }
    const close = () => {
      letGo()
      if (open) overseer[Symbol.dispose]()
      open = false
    }
    overseer.subscribeToWorkpieces(new TitleReader(wanted, (found) => {
      heard = true
      if (current) setTitles({ workspaceId, asked, found })
      close()
    })).then((lease) => {
      made = lease
      if (heard || !current) letGo()
    }, () => {})
    return () => {
      current = false
      close()
    }
  }, [api, reconnecting, workspaceId, asked])

  // What was found for fewer stays while more are read, rather than every one going untitled meanwhile.
  return titles?.workspaceId === workspaceId ? titles.found : NONE
}
