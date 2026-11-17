import { useSyncExternalStore } from 'react'
import { exampleSkills } from './exampleSkills'
import { SkillStore } from './SkillStore'

/**
 * The user's skills, for as long as the page is up: examples to start with, and whatever is done
 * to them since, which is kept nowhere else (see `SkillStore`). The one store, so that a skill's
 * own page and the list it is in show the same.
 */
export const skillStore = new SkillStore(exampleSkills())

/** The skills as they are now. */
export const useSkills = () => useSyncExternalStore(skillStore.subscribe, skillStore.getSnapshot)
