import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { SkillsLibrary } from './SkillsLibrary'

export const SkillsContext = createContext<SkillsLibrary | null>(null)

/** The user's skills, read once something shows them, with what can be done to them. */
export const useSkills = () => {
  const library = useContext(SkillsContext)
  if (!library) throw new Error('useSkills needs a SkillsProvider')
  useEffect(() => library.retain(), [library])
  return { library, snapshot: useSyncExternalStore(library.subscribe, library.getSnapshot) }
}
