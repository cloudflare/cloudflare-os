import { useSyncExternalStore } from 'react'

const QUERY = '(dynamic-range: high)'

/** Whether the screen the page is on, and the browser, can show HDR images brighter than white. */
const hdrSupported = () =>
  typeof matchMedia === 'function' && typeof CSS !== 'undefined' && CSS.supports('dynamic-range-limit', 'standard') && matchMedia(QUERY).matches

const subscribe = (onChange: () => void) => {
  if (typeof matchMedia !== 'function') return () => {}
  // The window can be dragged to another display.
  const query = matchMedia(QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Whether HDR can be drawn here: the display is one (`dynamic-range: high`) and the browser has
 * `dynamic-range-limit`, which is what holds an HDR image at white until it is let go. Chrome and
 * Edge 136 and later, and Safari 26; false everywhere else, so that nothing HDR is drawn for those.
 */
export const useHdrDisplay = () => useSyncExternalStore(subscribe, hdrSupported, () => false)
