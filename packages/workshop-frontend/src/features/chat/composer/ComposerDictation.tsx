import { useEffect, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import { ArrowClockwise, Check, Microphone, X } from "@phosphor-icons/react";
import { WorkshopIconButton } from "../../../components/WorkshopControls";
import { focusIsFree, useDictation } from "./useDictation";

const BUTTON_SIZE = "!h-10 !w-10 sm:!h-8 sm:!w-8";

/**
 * The composer's microphone. Records a dictation, transcribes it with `transcribe`, and hands the
 * text to `onTranscript`; it never sends anything itself. `disabled` only stops a new dictation
 * from starting, so one under way is never lost. `onReturnFocus` is called when a control that may
 * have had focus goes away without a transcript, which focuses the composer itself.
 */
export const ComposerDictation = ({ transcribe, onTranscript, disabled, onReturnFocus }: {
  transcribe: (audio: Uint8Array) => Promise<string>;
  onTranscript: (text: string) => void;
  disabled: boolean;
  onReturnFocus: () => void;
}) => {
  const { state, start, stop, retry, discard } = useDictation({ transcribe, onTranscript });
  const recording = state.status === "recording";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [recording]);

  // A status change can remove the control that had focus: the microphone button when it starts,
  // Cancel once recording, Finish when the recording stops, whether by itself or not, Retry when
  // the clip is sent again. Lost focus goes to the composer while transcribing, and otherwise to
  // the status's own control. Focus that has moved on stays where it is: the user may be typing.
  const focusTargetRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusIsFree()) return;
    if (state.status === "transcribing") onReturnFocus();
    else focusTargetRef.current?.focus();
    // oxlint-disable-next-line exhaustive-deps -- only a status change moves focus.
  }, [state.status]);

  const close = () => {
    discard();
    onReturnFocus();
  };

  const cancelButton = (ref?: typeof focusTargetRef) => (
    <WorkshopIconButton
      ref={ref}
      onClick={close}
      className={BUTTON_SIZE}
      aria-label="Cancel dictation"
    >
      <X size={16} />
    </WorkshopIconButton>
  );

  const announcement = state.status === "starting" ? "Waiting for the microphone"
    : state.status === "recording" ? "Recording"
    : state.status === "transcribing" ? "Transcribing"
    : state.status === "failed" ? state.message
    : "";

  let controls;
  if (state.status === "starting") {
    // Keyed so that recording replaces this Cancel, rather than letting it keep focus from Finish.
    controls = (
      <div key="starting" className="flex items-center gap-0.5 rounded-lg bg-kumo-tint pl-2.5">
        <Loader size="sm" />
        {cancelButton(focusTargetRef)}
      </div>
    );
  } else if (state.status === "recording") {
    const seconds = Math.max(0, Math.floor((now - state.startedAt) / 1000));
    controls = (
      <div className="flex items-center gap-0.5 rounded-lg bg-kumo-tint pl-2.5">
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-kumo-danger" />
        <span className="px-1 text-xs tabular-nums text-kumo-subtle">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
        {cancelButton()}
        <WorkshopIconButton
          ref={focusTargetRef}
          onClick={stop}
          className={BUTTON_SIZE}
          aria-label="Finish dictation"
        >
          <Check size={16} weight="bold" />
        </WorkshopIconButton>
      </div>
    );
  } else if (state.status === "transcribing") {
    controls = (
      <div className="flex h-10 items-center gap-1.5 px-2 text-xs text-kumo-subtle sm:h-8">
        <Loader size="sm" />
        <span aria-hidden>Transcribing…</span>
      </div>
    );
  } else if (state.status === "failed") {
    controls = (
      <div className="flex min-w-0 items-center gap-0.5 rounded-lg bg-kumo-danger-tint pl-2.5">
        <span aria-hidden className="truncate text-xs text-kumo-danger" title={state.message}>
          {state.message}
        </span>
        {state.canRetry && (
          <WorkshopIconButton
            ref={focusTargetRef}
            onClick={retry}
            className={BUTTON_SIZE}
            aria-label="Retry transcription"
          >
            <ArrowClockwise size={16} />
          </WorkshopIconButton>
        )}
        <WorkshopIconButton
          ref={state.canRetry ? undefined : focusTargetRef}
          onClick={close}
          className={BUTTON_SIZE}
          aria-label={state.canRetry ? "Discard recording" : "Dismiss"}
        >
          <X size={16} />
        </WorkshopIconButton>
      </div>
    );
  } else {
    controls = (
      <WorkshopIconButton
        onClick={() => void start()}
        disabled={disabled}
        className={BUTTON_SIZE}
        aria-label="Dictate"
      >
        <Microphone size={18} />
      </WorkshopIconButton>
    );
  }

  return (
    <>
      <span role="status" className="sr-only">{announcement}</span>
      {controls}
    </>
  );
};
