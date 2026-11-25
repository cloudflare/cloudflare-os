import { createContext, use, useEffect, useState, useSyncExternalStore } from 'react'
import type { SkillStore } from './SkillStore'

/**
 * The one store of the user's skills (see `SkillStore`), made over the app's `ContextApi` at its
 * root, so that every page of it shows the same.
 */
export const SkillStoreContext = createContext<SkillStore | null>(null)

export const useSkillStore = () => {
  const store = use(SkillStoreContext)
  if (!store) throw new Error('useSkillStore() used outside SkillStoreContext')
  return store
}

/** The skills as far as they have been read. */
export const useSkillsState = () => {
  const store = useSkillStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/**
 * One skill, with its files, which are read for it once it is shown, and why they could not be.
 * Key whatever uses it by the skill, so that why one could not be read is not said of the next.
 */
export const useSkill = (id: string) => {
  const store = useSkillStore()
  const state = useSkillsState()
  const ready = state.status === 'ready'
  const listed = ready && state.skills.some((skill) => skill.id === id)
  const [filesProblem, setFilesProblem] = useState<string>()
  useEffect(() => {
    if (!listed) return
    let current = true
    // Read again each time it is shown, as someone it is shared with may have changed them.
    store.open(id).catch((error: unknown) => {
      if (current) setFilesProblem(error instanceof Error ? error.message : String(error))
    })
    return () => {
      current = false
    }
  }, [store, id, listed])
  return { state, skill: ready ? state.skills.find((skill) => skill.id === id) : undefined, filesProblem }
}
