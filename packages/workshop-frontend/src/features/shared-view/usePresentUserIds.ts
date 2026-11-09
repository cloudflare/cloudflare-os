import { useEffect, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type { Overseer, PresenceParticipant, PresenceSubscriber } from '@gadgets/workshop-shared/api'

const NONE: ReadonlySet<string> = new Set()

class Roster extends RpcTarget implements PresenceSubscriber {
  #people = new Map<string, string>()
  #onChange: (ids: ReadonlySet<string>) => void

  constructor(onChange: (ids: ReadonlySet<string>) => void) {
    super()
    this.#onChange = onChange
  }

  init(list: PresenceParticipant[]) {
    this.#people = new Map(list.map(p => [p.key, p.user.id]))
    this.#flush()
  }

  add(p: PresenceParticipant) {
    this.#people.set(p.key, p.user.id)
    this.#flush()
  }

  remove(key: string) {
    this.#people.delete(key)
    this.#flush()
  }

  #flush() {
    this.#onChange(new Set(this.#people.values()))
  }
}

/** Who has the workspace open right now, by profile id, while `enabled`. */
export const usePresentUserIds = (overseer: RpcStub<Overseer>, enabled: boolean): ReadonlySet<string> => {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const subscriber = new RpcStub(new Roster(next => { if (!cancelled) setIds(next) }))
    const subscription = overseer.subscribeToPresence(subscriber)
    subscription.catch(() => {})
    return () => {
      cancelled = true
      subscription[Symbol.dispose]()
      subscriber[Symbol.dispose]()
      setIds(NONE)
    }
  }, [overseer, enabled])
  return ids
}
