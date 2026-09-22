import type { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'

type Disposable = { [Symbol.dispose]?: () => void }

/**
 * Releases a frame's complete RPC result. Cap'n Web frame results own the nested `ui` stub,
 * so disposing only `ui` leaks the result's other capabilities. Local test doubles may only
 * expose the nested stub; retain that fallback for those values.
 */
export function disposeGatekeeperUiFrame(frame: GatekeeperUiFrame | null | undefined): void {
  if (!frame) return
  const result = frame as GatekeeperUiFrame & Disposable
  const dispose = result[Symbol.dispose]
  if (dispose) {
    dispose.call(result)
    return
  }
  const ui = frame.ui as unknown as Disposable
  ui[Symbol.dispose]?.()
}
