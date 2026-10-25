import { useEffect, useRef, useState } from "react";
import { MAX_TRANSCRIPTION_AUDIO_BYTES } from "@gadgets/workshop-shared/api";
import { logRpcFailure, rpcFailureDescription } from "../../../rpcErrors";

/** How long one dictation records before it stops, and is transcribed, by itself. */
export const MAX_DICTATION_MS = 5 * 60_000;

// The recorder is asked for a chunk each second, and hands over one more when it stops; stopping
// this far short of the server's cap leaves room for that last chunk if it comes on time. It may
// not: browsers can hold chunks back and deliver them much larger, so a clip is still checked
// against the cap before it is sent.
const CHUNK_MS = 1000;
const CAP_HEADROOM_BYTES = 256 * 1024;
// 64 kbps fits MAX_DICTATION_MS in about 2.3 MiB. Browsers treat it as a hint.
const AUDIO_BITS_PER_SECOND = 64_000;
// The first one the browser records: Chromium and Firefox record WebM, Safari MP4.
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

export type DictationState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "recording"; startedAt: number }
  | { status: "transcribing" }
  /** `canRetry` when the recording is kept, so it can be sent again. */
  | { status: "failed"; message: string; canRetry: boolean };

// One recording, from asking for the microphone until its transcript is delivered or it is
// abandoned. Only the take in `takeRef` may change state, so the events of an abandoned one
// (cancelled, discarded, unmounted) are ignored.
type Take = {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
  bytes: number;
  timer?: number;
  clip?: Uint8Array;
};

/** Whether this browser can record audio for dictation. */
export const dictationSupported = () =>
  typeof MediaRecorder !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined;

/** Whether no control holds focus, so moving it takes nothing from the user. */
export const focusIsFree = () =>
  document.activeElement === null || document.activeElement === document.body;

const releaseMicrophone = (take: Take) => {
  clearTimeout(take.timer);
  take.stream?.getTracks().forEach((track) => track.stop());
};

/**
 * Records speech from the microphone and transcribes it when stopped, or when it reaches
 * MAX_DICTATION_MS or the server's size cap. The recording stays in the browser until the
 * transcript is delivered or the user discards it, so a failed transcription can be retried.
 */
export const useDictation = ({ transcribe, onTranscript }: {
  transcribe: (audio: Uint8Array) => Promise<string>;
  onTranscript: (text: string) => void;
}) => {
  const [state, setState] = useState<DictationState>({ status: "idle" });
  const takeRef = useRef<Take | null>(null);
  // Read when a transcription starts, so a retry after a reconnect uses the current connection.
  const callbacksRef = useRef({ transcribe, onTranscript });
  callbacksRef.current = { transcribe, onTranscript };

  const abandon = () => {
    const take = takeRef.current;
    takeRef.current = null;
    if (!take) return;
    releaseMicrophone(take);
    if (take.recorder && take.recorder.state !== "inactive") take.recorder.stop();
  };

  useEffect(() => abandon, []);

  const fail = (take: Take, message: string, canRetry: boolean) => {
    if (!canRetry) takeRef.current = null;
    setState({ status: "failed", message, canRetry });
    if (!canRetry) releaseMicrophone(take);
  };

  const send = async (take: Take, clip: Uint8Array) => {
    setState({ status: "transcribing" });
    let text: string;
    try {
      text = await callbacksRef.current.transcribe(clip);
    } catch (error) {
      if (takeRef.current !== take) return;
      logRpcFailure("Transcription failed", error);
      fail(take, rpcFailureDescription(error) ?? "Transcription failed.", true);
      return;
    }
    if (takeRef.current !== take) return;
    if (text === "") {
      fail(take, "No speech was recognized.", false);
      return;
    }
    takeRef.current = null;
    setState({ status: "idle" });
    callbacksRef.current.onTranscript(text);
  };

  const start = async () => {
    abandon();
    const take: Take = { chunks: [], bytes: 0 };
    takeRef.current = take;
    setState({ status: "starting" });
    try {
      take.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (takeRef.current !== take) return;
      const name = error instanceof DOMException ? error.name : "";
      fail(take, name === "NotAllowedError" ? "Microphone access was denied."
        : name === "NotFoundError" ? "No microphone was found."
        : "The microphone couldn't be started.", false);
      return;
    }
    if (takeRef.current !== take) {
      releaseMicrophone(take);
      return;
    }

    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    try {
      const recorder = new MediaRecorder(take.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      take.recorder = recorder;
      recorder.addEventListener("dataavailable", ({ data }) => {
        take.chunks.push(data);
        take.bytes += data.size;
        if (take.bytes >= MAX_TRANSCRIPTION_AUDIO_BYTES - CAP_HEADROOM_BYTES &&
            recorder.state === "recording") {
          recorder.stop();
        }
      });
      recorder.addEventListener("error", () => {
        if (takeRef.current === take) fail(take, "Recording failed.", false);
      });
      recorder.addEventListener("stop", async () => {
        releaseMicrophone(take);
        if (takeRef.current !== take) return;
        const clip = new Uint8Array(await new Blob(take.chunks).arrayBuffer());
        take.chunks = [];
        if (takeRef.current !== take) return;
        const problem = clip.byteLength === 0 ? "Nothing was recorded."
          : clip.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES ? "The recording is too long."
          : undefined;
        if (problem) {
          fail(take, problem, false);
          return;
        }
        take.clip = clip;
        await send(take, clip);
      });
      // Throws when the stream cannot be recorded, e.g. the device went away after the grant.
      recorder.start(CHUNK_MS);
      take.timer = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_DICTATION_MS);
    } catch {
      fail(take, "Recording failed.", false);
      return;
    }
    setState({ status: "recording", startedAt: Date.now() });
  };

  const stop = () => {
    const recorder = takeRef.current?.recorder;
    if (recorder?.state === "recording") recorder.stop();
  };

  const retry = () => {
    const take = takeRef.current;
    if (take?.clip) void send(take, take.clip);
  };

  /** Cancels a recording, or drops a failed one. */
  const discard = () => {
    abandon();
    setState({ status: "idle" });
  };

  return { state, start, stop, retry, discard };
};
