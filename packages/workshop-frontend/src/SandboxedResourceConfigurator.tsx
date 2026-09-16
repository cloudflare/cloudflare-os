import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { ResourceConfiguratorFrame, ResourceConfiguratorHost, ResourceConfiguratorIframe } from '@gadgets/workshop-shared/gatekeeper'
import { createRateLimitedCapability } from './rateLimitedCapability'
import { useTheme } from './ThemeContext'
import { forwardTrustedFrameError } from './errorReporting'

// Upper bound on iframe height. Sized to leave room for a typical configurator form plus an open
// autocomplete popup, while staying within a reasonable viewport even on short screens.
const MAX_CONFIGURATOR_HEIGHT = 720
const MIN_CONFIGURATOR_HEIGHT = 80
// Cap on each scroll delta forwarded from the iframe, so a misbehaving iframe can't post
// extreme values to scroll-jack the host modal.
const SCROLL_FORWARD_MAX_DELTA = 1000
const COLLECT_VALUES_TIMEOUT_MS = 5000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

class ResourceConfiguratorHostImpl extends RpcTarget implements ResourceConfiguratorHost {
  readonly #gatekeeper: RpcStub<RpcTarget>

  constructor(
    configurator: any,
    private readonly onResize: (height: number, layoutHeight: number) => void,
    private readonly onSelectionReady: (ready: boolean) => void,
    private readonly onScroll: (deltaX: number, deltaY: number) => void,
    private readonly getInitialResourceImpl: () => { resourceUrl: string; resourceUrlPattern: string } | null,
  ) {
    super()
    // The configurator form is short-lived, so a burst past the per-minute cap is always a bug:
    // reject rather than throttle. (No resume timer is created in reject mode, so no dispose needed.)
    this.#gatekeeper = createRateLimitedCapability(configurator, {
      maxConcurrency: 4,
      maxCallsPerMinute: 120,
      maxPendingCalls: 32,
      onRateLimit: 'reject',
      label: 'Resource configurator',
    }).capability
  }

  get gatekeeper(): RpcStub<RpcTarget> {
    return this.#gatekeeper
  }

  async getInitialResource(): Promise<{ resourceUrl: string; resourceUrlPattern: string } | null> {
    return this.getInitialResourceImpl()
  }

  resize(height: number, layoutHeight: number): void {
    this.onResize(height, layoutHeight)
  }

  setSelectionReady(ready: boolean): void {
    this.onSelectionReady(ready)
  }

  forwardScroll(deltaX: number, deltaY: number): void {
    this.onScroll(deltaX, deltaY)
  }
}

export default function SandboxedResourceConfigurator({
  frame,
  topOffset = 0,
  onCollectResourceUrlChange,
  onSelectionReadyChange,
  initialResourceUrl,
  resourceUrlPattern,
}: {
  frame: ResourceConfiguratorFrame,
  topOffset?: number,
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void,
  onSelectionReadyChange?: (ready: boolean | null) => void,
  /**
   * When set, the configurator opens pre-filled to this concrete resource URL (e.g. supplied by an
   * AI agent's connection request). `resourceUrlPattern` is this resource's pattern, used by the
   * iframe runtime's fallback URL->values extraction.
   */
  initialResourceUrl?: string,
  resourceUrlPattern?: string,
}) {
  const { resolvedThemeMode } = useTheme()
  const placeholderRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const rpcSessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const iframeRpcRef = useRef<RpcStub<ResourceConfiguratorIframe> | null>(null)
  // The configurator stub is an arbitrary gatekeeper-defined capability: its method shape is
  // unknown to Workshop, so we treat it as `any` and let Cap'n Web carry calls through.
  const configuratorRef = useRef<any>(null)
  const iframeConnectedRef = useRef(false)
  const iframeInvalidatedRef = useRef(false)
  const iframeLoadCountRef = useRef(0)
  const pendingScrollRef = useRef({ x: 0, y: 0 })
  const scrollFrameRef = useRef<number | null>(null)
  const [height, setHeight] = useState(MIN_CONFIGURATOR_HEIGHT)
  const [layoutHeight, setLayoutHeight] = useState(MIN_CONFIGURATOR_HEIGHT)
  const [frameRect, setFrameRect] = useState<{ top: number, left: number, width: number } | null>(null)
  const [clipInsets, setClipInsets] = useState<{ top: number, right: number, bottom: number, left: number } | null>(null)
  const heightRef = useRef(MIN_CONFIGURATOR_HEIGHT)
  heightRef.current = height
  const layoutHeightRef = useRef(MIN_CONFIGURATOR_HEIGHT)
  layoutHeightRef.current = layoutHeight
  const topOffsetRef = useRef(topOffset)
  topOffsetRef.current = topOffset
  configuratorRef.current = frame.ui
  // Resource to pre-fill the configurator with, read lazily when the iframe connects.
  const initialResourceRef = useRef<{ resourceUrl: string; resourceUrlPattern: string } | null>(null)
  initialResourceRef.current = (initialResourceUrl && resourceUrlPattern)
    ? { resourceUrl: initialResourceUrl, resourceUrlPattern }
    : null

  // Cached scroll ancestor of the placeholder. We rediscover it lazily because the modal DOM is
  // stable for the lifetime of the configurator, so walking up via getComputedStyle on every event is
  // wasted work.
  const scrollAncestorRef = useRef<HTMLElement | null>(null)
  const findScrollAncestor = (): HTMLElement | null => {
    if (scrollAncestorRef.current && scrollAncestorRef.current.isConnected) return scrollAncestorRef.current
    let node = placeholderRef.current?.parentElement ?? null
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden') {
        scrollAncestorRef.current = node
        return node
      }
      node = node.parentElement
    }
    scrollAncestorRef.current = null
    return null
  }

  // rAF-batched recompute. Scroll events fire at native rate; we coalesce to one update per frame
  // and skip setState when nothing changed to avoid forcing a re-render on every wheel tick.
  const updateScheduledRef = useRef(false)
  const lastFrameRectRef = useRef<{ top: number, left: number, width: number } | null>(null)
  const lastClipRef = useRef<{ top: number, right: number, bottom: number, left: number } | null>(null)
  const updateFrameRect = () => {
    if (updateScheduledRef.current) return
    updateScheduledRef.current = true
    requestAnimationFrame(() => {
      updateScheduledRef.current = false
      const placeholder = placeholderRef.current
      const rect = placeholder?.getBoundingClientRect()
      if (!placeholder || !rect) return

      const visualTop = rect.top + topOffsetRef.current
      const nextRect = { top: visualTop, left: rect.left, width: rect.width }
      const prevRect = lastFrameRectRef.current
      const rectChanged = !prevRect
        || prevRect.top !== nextRect.top
        || prevRect.left !== nextRect.left
        || prevRect.width !== nextRect.width
      if (rectChanged) {
        lastFrameRectRef.current = nextRect
        setFrameRect(nextRect)
      }

      // Notify the iframe of viewport position so floating popups can clamp their max-height.
      if (rectChanged && iframeConnectedRef.current) {
        iframeRpcRef.current?.updateViewport(visualTop, window.innerHeight)
      }

      // Clip the iframe to the nearest scrollable ancestor (typically the modal's scroll area).
      // In normal viewports the modal grows tall enough that no clipping is needed, but when the
      // viewport is too short for the modal to fully expand, the inner scroll-area takes over and
      // this clip prevents the iframe from rendering over the modal's footer.
      const ancestor = findScrollAncestor()
      let nextClip: { top: number, right: number, bottom: number, left: number } | null = null
      if (ancestor) {
        const ancestorRect = ancestor.getBoundingClientRect()
        // When popup is open (iframe taller than layout), allow bottom overflow so dropdowns can
        // extend past the modal like native autocomplete behavior.
        const popupOpen = heightRef.current > layoutHeightRef.current + 8
        nextClip = {
          top: Math.max(0, ancestorRect.top - visualTop),
          right: Math.max(0, (rect.left + rect.width) - ancestorRect.right),
          bottom: popupOpen ? 0 : Math.max(0, (visualTop + heightRef.current) - ancestorRect.bottom),
          left: Math.max(0, ancestorRect.left - rect.left),
        }
      }
      const prevClip = lastClipRef.current
      const clipChanged = !prevClip !== !nextClip
        || (prevClip && nextClip && (
          prevClip.top !== nextClip.top
          || prevClip.right !== nextClip.right
          || prevClip.bottom !== nextClip.bottom
          || prevClip.left !== nextClip.left
        ))
      if (clipChanged) {
        lastClipRef.current = nextClip
        setClipInsets(nextClip)
      }
    })
  }

  const connectIframe = (port: MessagePort) => {
    if (iframeConnectedRef.current) {
      iframeInvalidatedRef.current = true
      port.close()
      iframeRpcRef.current?.[Symbol.dispose]?.()
      iframeRpcRef.current = null
      rpcSessionRef.current?.[Symbol.dispose]?.()
      rpcSessionRef.current = null
      return
    }
    if (iframeInvalidatedRef.current) return
    if (!configuratorRef.current) {
      port.close()
      return
    }
    rpcSessionRef.current?.[Symbol.dispose]?.()
    const iframe = newMessagePortRpcSession<ResourceConfiguratorIframe>(port, new ResourceConfiguratorHostImpl(
      configuratorRef.current,
      (nextHeight, nextLayoutHeight) => {
        if (!Number.isFinite(nextHeight)) return
        const maxHeight = Math.max(MIN_CONFIGURATOR_HEIGHT, Math.min(MAX_CONFIGURATOR_HEIGHT, window.innerHeight - 120))
        setHeight(clamp(Math.ceil(nextHeight), MIN_CONFIGURATOR_HEIGHT, maxHeight))
        const layoutHeight = Number.isFinite(nextLayoutHeight) ? nextLayoutHeight : nextHeight
        setLayoutHeight(clamp(Math.ceil(layoutHeight), MIN_CONFIGURATOR_HEIGHT, maxHeight))
      },
      ready => onSelectionReadyChange?.(Boolean(ready)),
      (deltaX, deltaY) => applyForwardedScroll(
        clamp(Number(deltaX) || 0, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA),
        clamp(Number(deltaY) || 0, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA),
      ),
      () => initialResourceRef.current,
    ))
    rpcSessionRef.current = iframe
    iframeRpcRef.current?.[Symbol.dispose]?.()
    iframeRpcRef.current = iframe.dup()
    const placeholderRect = placeholderRef.current?.getBoundingClientRect()
    if (placeholderRect) {
      iframe.updateViewport(placeholderRect.top + topOffsetRef.current, window.innerHeight)
    }
    iframeConnectedRef.current = true
  }

  const handleIframeLoad = () => {
    iframeLoadCountRef.current++
    if (iframeLoadCountRef.current > 1) {
      iframeInvalidatedRef.current = true
      iframeRpcRef.current?.[Symbol.dispose]?.()
      iframeRpcRef.current = null
      rpcSessionRef.current?.[Symbol.dispose]?.()
      rpcSessionRef.current = null
    }
  }

  const collectResourceUrl = () => {
    if (iframeInvalidatedRef.current) return Promise.reject(new Error('Configurator is no longer available.'))
    const iframe = iframeRpcRef.current
    if (!iframe || !iframeConnectedRef.current) return Promise.reject(new Error('Configurator is not ready.'))

    let timeout: number | null = null
    return Promise.race([
      iframe.collectResourceUrl(),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          reject(new Error('Configurator did not provide its resource URL. Please try again.'))
        }, COLLECT_VALUES_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timeout !== null) window.clearTimeout(timeout)
    })
  }

  const applyForwardedScroll = (deltaX: number, deltaY: number) => {
    pendingScrollRef.current.x += deltaX
    pendingScrollRef.current.y += deltaY
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const deltaX = clamp(pendingScrollRef.current.x, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA)
      const deltaY = clamp(pendingScrollRef.current.y, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA)
      pendingScrollRef.current = { x: 0, y: 0 }
      if (deltaY === 0 && deltaX === 0) return
      const target = findScrollAncestor()
      if (target && target.scrollHeight > target.clientHeight) {
        target.scrollBy({ top: deltaY, left: deltaX })
      }
    })
  }

  useLayoutEffect(() => {
    iframeConnectedRef.current = false
    iframeInvalidatedRef.current = false
    iframeLoadCountRef.current = 0
    onSelectionReadyChange?.(null)
    iframeRpcRef.current?.[Symbol.dispose]?.()
    iframeRpcRef.current = null
    rpcSessionRef.current?.[Symbol.dispose]?.()
    rpcSessionRef.current = null
    scrollAncestorRef.current = null
    lastFrameRectRef.current = null
    lastClipRef.current = null
    setHeight(MIN_CONFIGURATOR_HEIGHT)
    setLayoutHeight(MIN_CONFIGURATOR_HEIGHT)
    updateFrameRect()
  }, [frame.iframeHtml])

  useEffect(() => {
    onCollectResourceUrlChange?.(collectResourceUrl)
    return () => {
      onCollectResourceUrlChange?.(null)
    }
  }, [onCollectResourceUrlChange])

  useLayoutEffect(() => {
    updateFrameRect()
  }, [layoutHeight, height, topOffset])

  useEffect(() => {
    updateFrameRect()
    const update = () => updateFrameRect()
    const onResize = () => {
      updateFrameRect()
      if (iframeConnectedRef.current) {
        iframeRpcRef.current?.windowResized()
      }
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', update, true)
    }
  }, [])

  // Track the placeholder geometry while the modal finishes opening. The iframe is portaled with a
  // fixed width/left measured from the placeholder via getBoundingClientRect. When the configurator
  // mounts while the modal is still playing its open animation (e.g. the agent accept flow opens it
  // pre-seeded), getBoundingClientRect reflects the modal's transient transform (scale-in), so the
  // iframe is sized too narrow and would stay that way until something re-measures (a window resize
  // fixes it). A ResizeObserver can't catch this because CSS transforms don't change the observed
  // box size. Instead we re-measure each frame until the geometry is stable for a few frames (the
  // animation has settled) or a 1s cap elapses — which also makes the iframe track the modal as it
  // animates in.
  useEffect(() => {
    let raf = 0
    let stableFrames = 0
    let lastKey = ''
    const start = performance.now()
    const tick = () => {
      const rect = placeholderRef.current?.getBoundingClientRect()
      const key = rect ? `${Math.round(rect.width)}x${Math.round(rect.left)}x${Math.round(rect.top)}` : ''
      if (key && key === lastKey) stableFrames++
      else { stableFrames = 0; lastKey = key }
      updateFrameRect()
      if (stableFrames < 3 && performance.now() - start < 1000) {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [frame.iframeHtml])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== 'null') return
      if (iframeInvalidatedRef.current) return

      const frameWindow = iframeRef.current?.contentWindow
      if (frameWindow && forwardTrustedFrameError(
        event, frameWindow, { surface: 'configurator' },
      )) return

      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connectIframe(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
      onSelectionReadyChange?.(null)
      iframeRpcRef.current?.[Symbol.dispose]?.()
      iframeRpcRef.current = null
      rpcSessionRef.current?.[Symbol.dispose]?.()
      rpcSessionRef.current = null
    }
  }, [])

  return (
    <>
      <div ref={placeholderRef} style={{ height: layoutHeight + topOffset }} />
      {frameRect && createPortal(<iframe
        ref={iframeRef}
        srcDoc={frame.iframeHtml}
        onLoad={handleIframeLoad}
        sandbox="allow-scripts"
        title="Resource configurator"
        scrolling="no"
        style={{
          position: 'fixed',
          top: frameRect.top,
          left: frameRect.left,
          zIndex: 2147483647,
          display: 'block',
          width: frameRect.width,
          height,
          clipPath: clipInsets
            ? `inset(${clipInsets.top}px ${clipInsets.right}px ${clipInsets.bottom}px ${clipInsets.left}px)`
            : undefined,
          border: 0,
          background: 'transparent',
          colorScheme: resolvedThemeMode,
          pointerEvents: 'auto',
        }}
      />, document.body)}
    </>
  )
}
