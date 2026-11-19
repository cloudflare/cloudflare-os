import { formatTokenCount } from '@/components/usageFormat'
import { contextWindowPresets } from '@/settings/modelOptions'

/** The context window a model is held to: what it was set to, else its own, where that is known. */
export const effectiveWindow = (known: number | undefined, held: number | undefined) => held ?? known

/**
 * The sizes a model of the user's can be held to, as options to choose from: its own, kept as
 * nothing (`''`), the usual sizes under it, and a size set elsewhere that is none of those, so that
 * what it is set to is always one of the options.
 */
export const windowSizes = (known: number | undefined, held: number | undefined): { value: string; options: { id: string; label: string }[] } => {
  const options = contextWindowPresets(known)
  const value = held === undefined ? '' : String(held)
  return { value, options: options.some(({ id }) => id === value) ? options : [...options, { id: value, label: formatTokenCount(held!) }] }
}

/** Which size was chosen, as what the model is held to: nothing for its own. */
export const heldWindow = (choice: string) => (choice === '' ? undefined : Number(choice))
