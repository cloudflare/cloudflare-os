import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'

/** Where a binding is: the gadget given it, and the name its code reaches it by. */
export const bindingKey = (gadgetId: number, name: string) => `${gadgetId} ${name}`

/**
 * What the `bindings` a chat proposes reach, by name, as people know them: a
 * document's or a repository's title rather than the name the code reaches it by
 * (`listBindings(chatId)`, which lists the chat's own pending ones too, with `resourceTitle`).
 * Keyed by `bindingKey`, and empty until read or where it could not be read.
 */
export const useBindingTitles = (workspaceId: string, chatId: number, bindings: readonly { gadgetId: number; name: string }[]) => {
  const { api, reconnecting } = useApi()
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(() => new Map())
  // As a string, so that the same bindings asked for again by a new array read nothing again,
  // and one more proposed reads them again.
  const asked = [...new Set(bindings.map(({ gadgetId, name }) => bindingKey(gadgetId, name)))].toSorted().join('|')

  useEffect(() => {
    if (!asked || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const ids = new Set(asked.split('|').map((key) => Number(key.split(' ')[0])))
    const gadgets = [...ids].map((id) => ({ id, gadget: overseer.getGadget(id) }))
    Promise.allSettled(gadgets.map(({ id, gadget }) => Promise.resolve().then(() => gadget.listBindings(chatId)).then((listed) => ({ id, listed }))))
      .then((results) => {
        if (!current) return
        const found = new Map<string, string>()
        for (const result of results) {
          if (result.status !== 'fulfilled') continue
          for (const { name, resourceTitle } of result.value.listed) if (resourceTitle) found.set(bindingKey(result.value.id, name), resourceTitle)
        }
        setTitles(found)
      })
      .finally(() => {
        for (const { gadget } of gadgets) gadget[Symbol.dispose]()
        overseer[Symbol.dispose]()
      })
    return () => {
      current = false
    }
  }, [api, reconnecting, workspaceId, chatId, asked])

  return titles
}
