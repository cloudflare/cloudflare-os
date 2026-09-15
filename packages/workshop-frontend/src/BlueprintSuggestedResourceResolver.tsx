import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  matchesResourceUrlPattern,
  type ResourceConfiguratorFrame,
} from '@gadgets/workshop-shared/gatekeeper'

import ResourceConfiguratorHost from './ResourceConfiguratorHost'
import { normalizeResourceUrl } from './resourceMatching'

type Props = {
  accountId: number
  resourceUrl: string
  resourceUrlPattern: string
  authenticatedApi: RpcStub<AuthenticatedApi>
  onResolved: (resourceUrl: string) => void
  onRejected: () => void
}

export const disposeConfiguratorFrame = (frame: ResourceConfiguratorFrame | null) => {
  const disposable = frame?.ui as unknown as { [Symbol.dispose]?: () => void } | undefined
  disposable?.[Symbol.dispose]?.()
}

const BlueprintSuggestedResourceResolver = ({
  accountId,
  resourceUrl,
  resourceUrlPattern,
  authenticatedApi,
  onResolved,
  onRejected,
}: Props) => {
  const [frameState, setFrameState] = useState<{
    key: number,
    frame: ResourceConfiguratorFrame,
  } | null>(null)
  const frameRef = useRef<ResourceConfiguratorFrame | null>(null)
  const frameKeyRef = useRef(0)
  const collectorRef = useRef<(() => Promise<string>) | null>(null)
  const readyRef = useRef(false)
  const attemptedRef = useRef(false)
  const generationRef = useRef(0)
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved
  const onRejectedRef = useRef(onRejected)
  onRejectedRef.current = onRejected

  const stop = useCallback(() => {
    generationRef.current++
    collectorRef.current = null
    readyRef.current = false
    const frame = frameRef.current
    frameRef.current = null
    if (frame) disposeConfiguratorFrame(frame)
    setFrameState(null)
  }, [])

  const reject = useCallback(() => {
    stop()
    onRejectedRef.current()
  }, [stop])

  const tryResolve = useCallback(() => {
    const collect = collectorRef.current
    if (!readyRef.current || !collect || attemptedRef.current) return
    attemptedRef.current = true
    const generation = generationRef.current
    collect().then(resolvedUrl => {
      if (generation !== generationRef.current || !readyRef.current) return
      if (matchesResourceUrlPattern(resourceUrlPattern, resolvedUrl)) {
        stop()
        onResolvedRef.current(normalizeResourceUrl(resolvedUrl))
      } else {
        reject()
      }
    }).catch(() => {
      if (generation === generationRef.current) reject()
    })
  }, [reject, resourceUrlPattern, stop])

  const handleCollectorChange = useCallback((collect: (() => Promise<string>) | null) => {
    collectorRef.current = collect
    tryResolve()
  }, [tryResolve])

  const handleReadyChange = useCallback((ready: boolean | null) => {
    readyRef.current = ready === true
    if (ready === false) reject()
    else tryResolve()
  }, [reject, tryResolve])

  useEffect(() => {
    let cancelled = false
    const generation = ++generationRef.current
    setFrameState(null)
    collectorRef.current = null
    readyRef.current = false
    attemptedRef.current = false

    authenticatedApi.startResourceConfigurator(accountId, resourceUrlPattern).then(frame => {
      if (cancelled || generation !== generationRef.current) {
        disposeConfiguratorFrame(frame)
        return
      }
      frameRef.current = frame
      setFrameState({ key: ++frameKeyRef.current, frame })
    }).catch(() => {
      if (!cancelled && generation === generationRef.current) reject()
    })

    return () => {
      cancelled = true
      generationRef.current++
      disposeConfiguratorFrame(frameRef.current)
      frameRef.current = null
      collectorRef.current = null
    }
  }, [accountId, authenticatedApi, reject, resourceUrl, resourceUrlPattern])

  return frameState ? (
    <ResourceConfiguratorHost
      frame={frameState.frame}
      frameKey={frameState.key}
      loading={false}
      error={null}
      disabled={false}
      hidden
      initialResourceUrl={resourceUrl}
      resourceUrlPattern={resourceUrlPattern}
      onCollectResourceUrlChange={handleCollectorChange}
      onSelectionReadyChange={handleReadyChange}
    />
  ) : null
}

export default BlueprintSuggestedResourceResolver
