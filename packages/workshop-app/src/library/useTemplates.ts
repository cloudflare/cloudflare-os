import { useSyncExternalStore } from 'react'
import { exampleTemplates } from './exampleTemplates'
import type { Template } from './templates'

// Examples, and stars that last for the visit, kept here so that the store and a template's own
// page show the same: the backend's blueprints and their `pinned` are still to be read in their place.
const TEMPLATES = exampleTemplates()
let stars: string[] = []
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

const setStars = (next: string[]) => {
  stars = next
  for (const listener of listeners) listener()
}

/** The templates there are to start something from, and the ids of the starred ones, in their order. */
export const useTemplates = (): { templates: Template[]; stars: string[]; setStars: (stars: string[]) => void } => ({
  templates: TEMPLATES,
  stars: useSyncExternalStore(subscribe, () => stars),
  setStars,
})
