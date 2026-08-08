import {
  FRONTEND_ERROR_MESSAGE_TYPE,
  serializeException,
  type FrontendCaptureMechanism,
  type FrontendFrameErrorReportV1,
} from "@gadgets/error-reporting";

type Options = Readonly<{
  severity?: FrontendFrameErrorReportV1["severity"];
  handled?: boolean;
  captureMechanism?: FrontendCaptureMechanism;
}>;

export function reportIssue(site: string, caught: unknown, options?: Options): void {
  try {
    if (import.meta.env.VITE_FRONTEND_ERROR_REPORTING !== "true") return;
    const report: FrontendFrameErrorReportV1 = {
      failureSite: site,
      severity: options?.severity ?? "error",
      handled: options?.handled ?? true,
      captureMechanism: options?.captureMechanism ?? "explicit",
      exception: serializeException(caught),
    };
    window.parent.postMessage({ type: FRONTEND_ERROR_MESSAGE_TYPE, report }, "*");
  } catch {
    // Reporting must never affect the management UI.
  }
}

export function installErrorReporting(): void {
  if (import.meta.env.VITE_FRONTEND_ERROR_REPORTING !== "true") return;
  window.addEventListener("error", (event) => {
    if (event.error !== undefined) {
      reportIssue("webhook.window-error", event.error, {
        handled: false,
        captureMechanism: "window.error",
      });
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportIssue("webhook.unhandled-rejection", event.reason, {
      handled: false,
      captureMechanism: "unhandledrejection",
    });
  });
}
