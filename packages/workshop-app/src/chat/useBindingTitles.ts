import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'

/** Where a binding is: the gadget given it, and the name its code reaches it by. */
export const bindingKey = (gadgetId: number, name: string) => `${gadgetId} ${name}`

/** What a binding reaches, as people know it: its title, and whether it is one of their AI models. */
export type BindingReach = { title: string; model?: true }

/**
 * What the `bindings` a chat proposes reach, by name, as people know them: a
 * document's or a repository's title rather than the name the code reaches it by
 * (`listBindings(chatId)`, which lists the chat's own pending ones too, with `resourceTitle`),
 * and whether it is a model (`kind`), whose title is the model's name. Keyed by `bindingKey`, and
 * empty until read or where it could not be read.
 */
export const useBindingTitles = (workspaceId: string, chatId: number, bindings: readonly { gadgetId: number; name: string }[]) => {
  const { api, reconnecting } = useApi()
  const [titles, setTitles] = useState<ReadonlyMap<string, BindingReach>>(() => new Map())
  // As a string, so that the same bindings asked for again by a new array read nothing again,
  // and one more proposed reads them again.
  const asked = [...new Set(bindings.map(({ gadgetId, name }) => bindingKey(gadgetId, name)))].toSorted().join('|')

  useEffect(() => {
    if (!asked || reconnecting) return
    let current = true
    const overseer = api.openWorkspace(workspaceId)
    const ids = new Set(asked.split('|').map((key) => Number(key.split(' ')[0])))
    const gadgets = [...ids].map((id) => ({ id, gadget: overseer.getGadget(id) }))
    const wanted = new Set(asked.split('|'))
    Promise.allSettled(gadgets.map(({ id, gadget }) => Promise.resolve().then(() => gadget.listBindings(chatId)).then((listed) =>
      listed
        .filter(({ name, resourceTitle }) => resourceTitle && wanted.has(bindingKey(id, name)))
        .map(({ name, resourceTitle, kind }) => [bindingKey(id, name), { title: resourceTitle, ...(kind === 'aiModel' ? { model: true as const } : {}) }] as const),
    )))
      .then((results) => {
        if (!current) return
        const found = new Map<string, BindingReach>()
        for (const result of results) if (result.status === 'fulfilled') for (const [key, reach] of result.value) found.set(key, reach)
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
