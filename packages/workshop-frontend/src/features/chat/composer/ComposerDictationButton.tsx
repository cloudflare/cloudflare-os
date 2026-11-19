import { Button, Loader } from "@cloudflare/kumo";
import { Hourglass, Microphone } from "@phosphor-icons/react";
import type { DictationStatus } from "./useComposerDictation";

const announcements: Record<DictationStatus, string> = {
  idle: "",
  starting: "Starting voice typing…",
  downloading: "Downloading the voice typing language pack…",
  listening: "Listening… Stop adds what you said to your message, and Escape discards it.",
  finishing: "Finishing voice typing…",
};

export const ComposerDictationButton = ({ status, disabled, onToggle, onCancel }: {
  status: DictationStatus;
  disabled: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) => {
  const listening = status === "listening";
  const preparing = status === "starting" || status === "downloading" || status === "finishing";
  const label = status === "idle"
    ? "Start voice typing"
    : status === "finishing" ? "Add what you said now" : "Stop voice typing";

  return (
    <>
      <span role="status" className="sr-only">{announcements[status]}</span>
      <Button
        type="button"
        shape="square"
        variant="ghost"
        className="group relative !h-10 !w-10 shrink-0 sm:!h-8 sm:!w-8"
        disabled={disabled}
        aria-label={label}
        title={label}
        icon={preparing ? (
          <span aria-hidden="true" className="text-kumo-subtle">
            <Loader size="sm" className="motion-reduce:hidden" />
            <Hourglass size={16} className="hidden motion-reduce:block" />
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
        onKeyDown={(e) => {
          // Clicking the mic leaves focus here, so Escape discards from the button as well as from
          // the textarea.
          if (e.key !== "Escape" || status === "idle") return;
          e.preventDefault();
          onCancel();
        }}
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
