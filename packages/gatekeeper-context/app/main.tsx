// Entrypoint for the sandboxed Context Library iframe. All data flows through the host-injected
// ContextApi RPC capability.

import { createRoot } from 'react-dom/client'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { ContextApi } from '../src/context-types'
import type {
  GatekeeperAppNavigation,
  GatekeeperAppPathReceiver,
} from '@gadgets/workshop-shared/gatekeeper-app'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import ContextLibraryPage from './ContextLibraryPage'
import {
  AppLocationProvider,
  ContextApiProvider,
  PresentationProvider,
  SelectUsersProvider,
  createAppLocation,
  type PresentAck,
  type SelectUsers,
  type UserSelectionReceiver,
} from './bridge'
import { applyAppTheme } from './theme'
import './styles.css'
import ErrorBoundary from './ErrorBoundary'
import { installErrorReporting, reportIssue } from './error-reporting'

installErrorReporting()

// The capability the iframe exposes back to the host: receivers for theme and path pushes.
class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver, GatekeeperAppPathReceiver {
  readonly #onPath: (path: string) => void

  constructor(onPath: (path: string) => void) {
    super()
    this.#onPath = onPath
  }

  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme)
  }

  setPath(path: string): void {
    this.#onPath(path)
  }
}

interface HostCapability extends GatekeeperAppNavigation {
  readonly ui: RpcStub<ContextApi>
  // Grow the iframe to a full-viewport overlay for app-level modals (`true`) or restore it (`false`).
  setPresenting(active: boolean): Promise<PresentAck>
  // Returns the current theme and calls back on `receiver` whenever it changes.
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>
  // Opens the Workshop's person picker, delivering each pick to `receiver`; see SelectUsers.
  selectUsers(receiver: UserSelectionReceiver): Promise<void>
}

function main() {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')

  const { port1, port2 } = new MessageChannel()
  // Opaque-origin iframes can't name their parent origin. The parent accepts this handshake only from
  // this frame + null origin; the message only transfers a private port.
  window.parent.postMessage({ type: 'handshake' }, '*', [port2])
  // The host is only asked to navigate after render, by which point `host` is initialized.
  const appLocation = createAppLocation((path, options) => host.navigatePath(path, options))
  const iframe = new AppIframe(path => appLocation.setPath(path))
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe)
  // The initial theme comes back from the call; later changes arrive via iframe.setTheme().
  host.subscribeTheme(iframe).then(applyAppTheme).catch(() => {})
  // The current path and every later one arrive via iframe.setPath().
  host.subscribePath(iframe).catch(error => reportIssue('context.subscribe-path', error))

  const selectUsers: SelectUsers = (receiver) => host.selectUsers(receiver)

  createRoot(root, {
    onUncaughtError: (error) => reportIssue('context.react-root', error, {
      handled: false, severity: 'fatal', captureMechanism: 'react',
    }),
  }).render(
    <ErrorBoundary><ContextApiProvider value={host.ui}>
      <AppLocationProvider value={appLocation}>
        <SelectUsersProvider value={selectUsers}>
          <PresentationProvider setPresenting={(active) => host.setPresenting(active)}>
            <TooltipProvider>
              <Toasty>
                <ContextLibraryPage />
              </Toasty>
            </TooltipProvider>
          </PresentationProvider>
        </SelectUsersProvider>
      </AppLocationProvider>
    </ContextApiProvider></ErrorBoundary>,
  )
}

main()
