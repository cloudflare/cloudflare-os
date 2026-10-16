import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'

/**
 * Releases the gatekeeper-side resources backing a configurator frame's iframe. `ui` is typed
 * RpcStub<RpcTarget>, whose type omits the disposer every stub has.
 */
export const disposeConfiguratorFrame = (frame: GatekeeperUiFrame | null) =>
  (frame?.ui as unknown as Partial<Disposable> | undefined)?.[Symbol.dispose]?.()
