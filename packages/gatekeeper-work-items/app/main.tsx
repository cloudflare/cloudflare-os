import { TooltipProvider, Toasty } from "@cloudflare/kumo";
import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from "@gadgets/workshop-shared/theme";
import ErrorBoundary from "./ErrorBoundary";
import WorkItemsPage from "./WorkItemsPage";
import { WorkItemsApiProvider, WorkItemsRouteStateProvider } from "./bridge";
import { composeWorkItemsApi, type HostCompositionApi, type WorkItemsShellRuntimeApi } from "./composition";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

interface HostCapability extends HostCompositionApi {
  openWorkItemsConnectors(): Promise<void>;
  retryWorkItemsProviders(): Promise<void>;
  readonly ui: RpcStub<WorkItemsShellRuntimeApi>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  getRouteState(): Promise<string>;
  setRouteState(value: string): Promise<void>;
  codingSessionAvailable(): Promise<boolean>;
  requestCodingSession(source: "jira" | "zendesk", id: string, key: string | undefined, url: string | undefined, title: string): Promise<void>;
}

async function main() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing Work Items app root.");

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  host.subscribeTheme(iframe).then(applyAppTheme).catch(() => {});
  const [api, initialRouteState, codingSessionAvailable] = await Promise.all([
    composeWorkItemsApi(host),
    host.getRouteState().catch(() => ""),
    host.codingSessionAvailable().catch(() => false),
  ]);

  createRoot(root, {
    onUncaughtError: (error) => reportIssue("work-items.react-root", error, {
      handled: false,
      severity: "fatal",
      captureMechanism: "react",
    }),
  }).render(
    <ErrorBoundary>
      <TooltipProvider>
        <Toasty>
          <WorkItemsApiProvider value={api}>
            <WorkItemsRouteStateProvider value={{
              initialRouteState,
              setRouteState: (value) => { void host.setRouteState(value).catch(() => {}); },
              codingSessionAvailable,
              openConnectors: () => host.openWorkItemsConnectors(),
              retryProviders: () => host.retryWorkItemsProviders(),
              requestCodingSession: (target, title) => {
                void host.requestCodingSession(target.source, target.id, target.key, target.url, title).catch(() => {});
              },
            }}>
              <WorkItemsPage />
            </WorkItemsRouteStateProvider>
          </WorkItemsApiProvider>
        </Toasty>
      </TooltipProvider>
    </ErrorBoundary>,
  );
}

void main();
