import type { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { ResourceAuthorizationAction } from './ResourceAuthorizationAction'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

/** Releases every capability owned by a resource-configurator frame. */
export function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null): void {
  if (!frame) return
  try {
    disposeRpcStub(frame.ui)
  } finally {
    disposeRpcStub(frame.authorization?.request)
  }
}

function disposeRpcStub(stub: unknown): void {
  const isObject = typeof stub === 'object' && stub !== null
  if (!isObject && typeof stub !== 'function') return
  if (!(Symbol.dispose in stub)) return
  const dispose = stub[Symbol.dispose]
  if (typeof dispose === 'function') dispose.call(stub)
}

/** A started configurator frame together with the selection it was started for. */
export type ConfiguratorFrameState = {
  key: number
  frame: ResourceConfiguratorFrame
  accountId: number
  resourceUrlPattern: string
}

/**
 * The frame only while it still belongs to the current selection.
 *
 * Both hosts clear a superseded frame from an effect, so one committed render can pair the new
 * account with the old frame; acting on it would configure or authorize the wrong account.
 */
export function currentConfiguratorFrame(
  state: ConfiguratorFrameState | null,
  accountId: number | null,
  resourceUrlPattern: string | null,
): ConfiguratorFrameState | null {
  if (!state || state.accountId !== accountId) return null
  return state.resourceUrlPattern === resourceUrlPattern ? state : null
}

/** Renders the trusted controls and sandboxed resource configurator. */
export default function ResourceConfiguratorHost({
  state,
  accountId,
  loading,
  error,
  disabled,
  onCollectResourceUrlChange,
  onSelectionReadyChange,
  topOffset = 0,
  initialResourceUrl,
  resourceUrlPattern,
}: {
  state: ConfiguratorFrameState | null
  accountId: number | null
  loading: boolean
  error: string | null
  disabled: boolean
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
  onSelectionReadyChange?: (ready: boolean | null) => void
  topOffset?: number
  initialResourceUrl?: string
  resourceUrlPattern: string
}) {
  if (disabled) return <Placeholder>Choose an account before selecting a resource.</Placeholder>
  if (loading) return <Placeholder>Loading configurator...</Placeholder>
  if (error) return <Placeholder>{error}</Placeholder>

  const current = currentConfiguratorFrame(state, accountId, resourceUrlPattern)
  if (!current) return null
  const { frame, key } = current

  return (
    <>
      {frame.authorization && (
        <ResourceAuthorizationAction
          key={`authorization:${key}`}
          authorization={frame.authorization}
        />
      )}
      <SandboxedResourceConfigurator
        key={`configurator:${key}`}
        frame={frame}
        topOffset={topOffset}
        onCollectResourceUrlChange={onCollectResourceUrlChange}
        onSelectionReadyChange={onSelectionReadyChange}
        initialResourceUrl={initialResourceUrl}
        resourceUrlPattern={resourceUrlPattern}
      />
    </>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-3 text-[12px] leading-4 text-kumo-subtle">
      {children}
    </section>
  )
}
