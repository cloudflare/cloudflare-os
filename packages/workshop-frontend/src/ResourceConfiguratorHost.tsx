import { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

/** Renders the resource configurator slot inside the gatekeeper modal. */
export default function ResourceConfiguratorHost({
  frame,
  frameKey,
  loading,
  error,
  disabled,
  onCollectResourceUrlChange,
  onSelectionReadyChange,
  onEnsureResources,
  topOffset = 0,
  initialResourceUrl,
  resourceUrlPattern,
  acceptedResourceUrlPatterns,
}: {
  frame: ResourceConfiguratorFrame | null
  frameKey: number | null
  loading: boolean
  error: string | null
  disabled: boolean
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
  onSelectionReadyChange?: (ready: boolean | null) => void
  /** Serves the configurator's requests for more access; see SandboxedResourceConfigurator. */
  onEnsureResources?: (resourceUrlPatterns: string[]) => Promise<boolean>
  topOffset?: number
  initialResourceUrl?: string
  resourceUrlPattern?: string
  /** The resource types the caller will accept a URL of from the configurator. */
  acceptedResourceUrlPatterns: readonly string[]
}) {
  if (disabled) return <Placeholder>Choose an account before selecting a resource.</Placeholder>
  if (loading) return <Placeholder>Loading configurator...</Placeholder>
  if (error) return <Placeholder>{error}</Placeholder>
  if (!frame) return null

  return <SandboxedResourceConfigurator
    key={frameKey}
    frame={frame}
    topOffset={topOffset}
    onCollectResourceUrlChange={onCollectResourceUrlChange}
    onSelectionReadyChange={onSelectionReadyChange}
    onEnsureResources={onEnsureResources}
    initialResourceUrl={initialResourceUrl}
    resourceUrlPattern={resourceUrlPattern}
    acceptedResourceUrlPatterns={acceptedResourceUrlPatterns}
  />
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-3 text-[12px] leading-4 text-kumo-subtle">
      {children}
    </section>
  )
}
