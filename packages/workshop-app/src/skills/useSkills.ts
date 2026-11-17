import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { SkillStore } from './SkillStore'

/**
 * The user's skills, from the Context Library (see `SkillStore`). The one store, so that a
 * skill's own page, the list it is in and the composers that offer them show the same.
 */
export const skillStore = new SkillStore()

/**
 * The skills as far as they have been read, read over the backend connection there is: again over
 * a new one, with what was read before shown meanwhile.
 */
export const useSkillsState = () => {
  const { api, reconnecting } = useApi()
  // Over a lost connection it could only fail; the new connection's `api` reads them.
  useEffect(() => {
    if (!reconnecting) skillStore.connect(api)
  }, [api, reconnecting])
  return useSyncExternalStore(skillStore.subscribe, skillStore.getSnapshot)
}

/** The skills as they are now: none until they have been read. */
export const useSkills = () => {
  useSkillsState()
  return skillStore.skills
}

/**
 * One skill, with its files, which are read for it once it is shown, and why they could not be.
 * Key whatever uses it by the skill, so that why one could not be read is not said of the next.
 */
export const useSkill = (id: string) => {
  const state = useSkillsState()
  const ready = state.status === 'ready'
  const listed = ready && state.skills.some((skill) => skill.id === id)
  const [filesProblem, setFilesProblem] = useState<string>()
  useEffect(() => {
    if (!listed) return
    let current = true
    // Read again each time it is shown, as someone it is shared with may have changed them.
    skillStore.open(id).catch((error: unknown) => {
      if (current) setFilesProblem(error instanceof Error ? error.message : String(error))
    })
    return () => {
      current = false
    }
  }, [id, listed])
  return { state, skill: ready ? state.skills.find((skill) => skill.id === id) : undefined, filesProblem }
}
