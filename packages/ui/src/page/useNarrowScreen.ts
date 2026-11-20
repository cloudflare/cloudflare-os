import { useSyncExternalStore } from 'react'

// Narrower than Tailwind's `md`: too narrow for the sidebar and a page side by side, such as a phone.
const NARROW = '(max-width: 767px)'

const subscribe = (onChange: () => void) => {
  const query = matchMedia(NARROW)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Whether the window is too narrow for more than one thing at a time, as it is now. */
export const isNarrowScreen = () => matchMedia(NARROW).matches

/** Whether the window is too narrow for more than one thing at a time, kept current as it is resized. */
export const useNarrowScreen = () => useSyncExternalStore(subscribe, isNarrowScreen)
