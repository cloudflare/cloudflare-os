import { Button } from "@cloudflare/kumo";
import { Microphone } from "@phosphor-icons/react";
import type { DictationStatus } from "./useComposerDictation";

const announcements: Record<DictationStatus, string> = {
  idle: "",
  starting: "Starting voice typing…",
  downloading: "Downloading the voice typing language pack…",
  listening: "Listening…",
  stopping: "Finishing voice typing…",
};

export const ComposerDictationButton = ({ status, disabled, onToggle }: {
  status: DictationStatus;
  disabled: boolean;
  onToggle: () => void;
}) => {
  const active = status !== "idle";
  const label = active ? "Stop voice typing" : "Start voice typing";

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
        title={status === "downloading" ? announcements.downloading : label}
        icon={
          <Microphone
            weight={active ? "fill" : "regular"}
            className={active
              ? "relative z-10 text-kumo-danger"
              : "text-kumo-inactive group-hover:text-kumo-subtle group-focus-visible:text-kumo-subtle"}
          />
        }
        onClick={onToggle}
      >
        {status === "listening" && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 m-auto hidden size-3.5 rounded-full border border-kumo-danger/45 motion-safe:block motion-safe:animate-ping"
          />
        )}
      </Button>
    </>
  );
};
