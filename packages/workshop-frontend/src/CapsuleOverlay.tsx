import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import ResourcePicker, { type SelectableItem } from './ResourcePicker'
import styles from './CapsuleOverlay.module.css'

export interface CapsuleOverlayProps {
  url: string
  onSelectAccount: (
    accountId: number,
    vendorId: string,
    resource: SupportedResource,
    accountDescription: AccountDescription,
    vendorDescription: VendorDescription,
  ) => void
  onRefine?: (newUrl: string, placeholderStart: number, placeholderEnd: number) => void
  onDismiss: () => void
  activeIndex?: number
  onItems?: (items: SelectableItem[]) => void
  activateRef?: MutableRefObject<((index: number) => void) | null>
  /**
   * Distance from the bottom of the positioning parent to the line the URL is on, so the panel sits
   * with that line rather than above the whole composer.
   */
  lineOffset?: number
}

// Minimum URL length to trigger showing the overlay (show once the scheme is complete).
const MIN_URL_LENGTH = 'http://'.length

/** Gap between the panel and the line it points at. Matches the offset in CapsuleOverlay.module.css. */
export const CAPSULE_OVERLAY_GAP = 8

// Breathing room kept between the top of the panel and the top of the window. Generous, because the
// measurement below only knows about the window edge: any fixed chrome above the composer eats into
// the same space without being visible to it.
const OVERLAY_VIEWPORT_MARGIN = 24

// Below this the panel is more frustrating than useful, so it is allowed to overflow instead.
const MIN_OVERLAY_HEIGHT = 160

export default function CapsuleOverlay({ url, onSelectAccount, onRefine, onDismiss, activeIndex, onItems, activateRef, lineOffset }: CapsuleOverlayProps) {
  const { authenticatedApi } = useAuthenticatedApi()
  const overlayRef = useRef<HTMLDivElement>(null)
  // A list that fills in row by row moves under the pointer and shuffles what Tab is aimed at, so
  // the panel stays out of the way until there is a list to show.
  const [ready, setReady] = useState(false)
  const onReadyChange = useCallback((value: boolean) => setReady(value), [])

  // The panel is anchored to the bottom, so it grows upward and can run past the top of the window
  // -- on Home the composer sits mid-page, leaving only a few hundred pixels above it. Measure what
  // is actually there and let the list scroll in the rest. The anchored edge doesn't move when the
  // content resizes, so one measurement per layout is enough.
  const [maxHeight, setMaxHeight] = useState<number>()
  useLayoutEffect(() => {
    const node = overlayRef.current
    if (!node) return
    const measure = () => {
      const bottom = node.getBoundingClientRect().bottom
      setMaxHeight(Math.max(MIN_OVERLAY_HEIGHT, bottom - OVERLAY_VIEWPORT_MARGIN))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [lineOffset, ready])

  // Dismiss on Escape key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss])

  // Don't show if the URL is too short to be meaningful.
  if (url.length < MIN_URL_LENGTH) {
    return null
  }

  return (
    <div
      ref={overlayRef}
      className={`themed-floating-shadow ${styles.capsuleOverlay} ${ready ? '' : 'invisible'}`}
      style={lineOffset === undefined ? undefined : {bottom: lineOffset}}
    >
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText={url}
        onSelectAccount={onSelectAccount}
        onRefine={onRefine}
        onReadyChange={onReadyChange}
        compact
        maxHeight={maxHeight}
        activeIndex={activeIndex}
        onItems={onItems}
        activateRef={activateRef}
      />
    </div>
  )
}
