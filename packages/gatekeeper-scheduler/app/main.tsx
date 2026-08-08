import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import SchedulerPage, { type ScheduleManagementClient } from "./SchedulerPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAccentVariables, applyThemeMode, type ResolvedThemeMode } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget {
  setThemeMode(mode: ResolvedThemeMode): void {
    applyThemeMode(mode);
  }

  setAccentVariables(variables: Record<string, string> | null): void {
    applyAccentVariables(variables);
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ScheduleManagementClient>;
  subscribeTheme(receiver: AppIframe): Promise<ResolvedThemeMode>;
  subscribeAccent(receiver: AppIframe): Promise<Record<string, string> | null>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
}

function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing Scheduler app root.");

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  host
    .subscribeTheme(iframe)
    .then(applyThemeMode)
    .catch(() => {});
  host.subscribeAccent(iframe).then(applyAccentVariables).catch(() => {});

  createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("scheduler.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  }).render(
    <ErrorBoundary>
      <SchedulerPage
        api={host.ui}
        openWorkspace={(workspaceId, gadgetId) => host.openWorkspace(workspaceId, gadgetId)}
        resolveWorkspaceTitles={(ids) => host.resolveWorkspaceTitles(ids)}
        openPrompt={(prompt) => host.openPrompt(prompt)}
      />
    </ErrorBoundary>,
  );
}

main();
