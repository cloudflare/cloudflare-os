import {
  FRONTEND_ERROR_MESSAGE_TYPE,
  serializeException,
  type FrontendCaptureMechanism,
  type FrontendFrameErrorReportV1,
} from "@gadgets/error-reporting";

/**
 * Whether the deployment collects frontend errors, fixed when the runtime is bundled
 * (`build/runtime.ts`). Tested only as an `if` condition wrapping everything that reports: esbuild
 * drops a constant-false branch while parsing, before it counts what the branch imports, so a bundle
 * built without reporting carries neither the reports nor the serializer.
 */
declare const __FRONTEND_REPORTING__: boolean;

type ReportOptions = {
  severity?: FrontendFrameErrorReportV1["severity"];
  handled?: boolean;
  captureMechanism?: FrontendCaptureMechanism;
};

/**
 * Sends a bounded report to the Workshop, which accepts it only from this frame's window and adds
 * the surface and vendor itself. Never throws: reporting is best-effort.
 */
export const reportFrontendIssue = (
  failureSite: string,
  caught: unknown,
  options: ReportOptions = {},
): void => {
  if (__FRONTEND_REPORTING__) {
    try {
      const report: FrontendFrameErrorReportV1 = {
        failureSite,
        severity: options.severity ?? "error",
        handled: options.handled ?? true,
        captureMechanism: options.captureMechanism ?? "explicit",
        exception: serializeException(caught),
      };
      window.parent.postMessage({ type: FRONTEND_ERROR_MESSAGE_TYPE, report }, "*");
    } catch {
      // The report is lost; there is nowhere left to send it.
    }
  }
};

export const installGlobalErrorReporting = (): void => {
  if (__FRONTEND_REPORTING__) {
    window.addEventListener("error", event => {
      if (event.error == null) return;
      reportFrontendIssue("configurator.window-error", event.error,
        { handled: false, captureMechanism: "window.error" });
    });
    window.addEventListener("unhandledrejection", event => reportFrontendIssue(
      "configurator.unhandled-rejection", event.reason,
      { handled: false, captureMechanism: "unhandledrejection" }));
  }
};
