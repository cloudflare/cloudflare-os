import { Button, Loader } from "@cloudflare/kumo";
import { Microphone } from "@phosphor-icons/react";
import type { DictationStatus } from "./useComposerDictation";

const announcements: Record<DictationStatus, string> = {
  idle: "",
  starting: "Starting voice typing…",
  downloading: "",
  listening: "Listening…",
  stopping: "Finishing voice typing…",
};

export const ComposerDictationButton = ({ status, disabled, onToggle }: {
  status: DictationStatus;
  disabled: boolean;
  onToggle: () => void;
}) => {
  const listening = status === "listening";
  const preparing = status === "starting" || status === "downloading";
  const label = status === "idle" ? "Start voice typing" : "Stop voice typing";

  return (
    <>
      <span role="status" className="sr-only">{announcements[status]}</span>
      <Button
        type="button"
        shape="square"
        variant="ghost"
        className="group relative !h-10 !w-10 shrink-0 sm:!h-8 sm:!w-8"
        disabled={disabled}
        aria-disabled={status === "stopping" || undefined}
        aria-label={label}
        title={label}
        icon={preparing ? (
          <span aria-hidden="true" className="text-kumo-subtle">
            <Loader size="sm" className="motion-reduce:animate-none" />
          </span>
        ) : (
          <Microphone
            weight={listening ? "fill" : "regular"}
            className={listening
              ? "relative z-10 text-kumo-danger"
              : "text-kumo-inactive group-hover:text-kumo-subtle group-focus-visible:text-kumo-subtle"}
          />
        )}
        onClick={onToggle}
      >
        {listening && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-auto hidden size-3.5 rounded-full border border-kumo-danger/45 motion-safe:block motion-safe:animate-ping"
          />
        )}
      </Button>
    </>
  );
};
