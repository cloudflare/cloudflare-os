import { Tooltip } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";

type CapturedConsoleLogsPromptProps = {
  count: number;
  preview: string;
  severity: "error" | "warn" | "info";
  onAttach: () => void;
  onDiscard: () => void;
};

export const CapturedConsoleLogsPrompt = ({
  count,
  preview,
  severity,
  onAttach,
  onDiscard,
}: CapturedConsoleLogsPromptProps) => {
  if (count <= 0) return null;

  // Keep the chip neutral and communicate severity with the dot so noisy errors do not paint the
  // entire prompt red.
  const dotClass = severity === "error"
    ? "bg-kumo-danger"
    : severity === "warn"
      ? "bg-kumo-warning"
      : "bg-kumo-inactive";
  const logKind = severity === "error" ? "error" : severity === "warn" ? "warning" : "log";

  return (
    <div className="pointer-events-none absolute inset-x-4 -top-10 z-10 flex justify-center">
      <div className="themed-floating-shadow pointer-events-auto flex items-center gap-2 rounded-full border border-kumo-line bg-kumo-elevated px-3 py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
        <Tooltip
          content={
            <pre className="m-0 max-h-[300px] max-w-[500px] overflow-auto whitespace-pre-wrap text-[11px]">
              {preview}
            </pre>
          }
          side="top"
          align="end"
          asChild
        >
          <button
            type="button"
            onClick={onAttach}
            className="flex min-w-0 items-center gap-2 truncate text-left hover:text-kumo-default"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
            <span className="truncate">
              Send {count} captured {logKind}{count !== 1 ? "s" : ""} to chat
            </span>
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={onDiscard}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-kumo-tint hover:opacity-100"
          aria-label="Discard captured logs"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  );
};
