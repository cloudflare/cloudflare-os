import { useLayoutEffect, useRef, useState } from "react";

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type Recognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

const getLocalRecognitionConstructor = () => {
  if (typeof window === "undefined") return;
  const browser = window as Window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  // Assigning an unknown property on a legacy recognizer would not prevent cloud processing.
  return [browser.SpeechRecognition, browser.webkitSpeechRecognition].find(
    (Recognition) => Recognition && "processLocally" in Recognition.prototype,
  );
};

const recognitionUnavailable = "Voice typing is unavailable. You can still type your message.";

const recognitionError = (error: string) => {
  switch (error) {
    case "aborted": return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Voice typing was blocked. Check your browser’s microphone permissions.";
    case "audio-capture": return "Voice typing couldn’t access a microphone.";
    case "no-speech": return "No speech detected. Try voice typing again.";
    case "language-not-supported":
    case "language-unavailable":
      return "Voice typing needs a supported language pack installed in your browser.";
    default: return recognitionUnavailable;
  }
};

export type DictationStatus = "idle" | "starting" | "listening" | "stopping";

export const useComposerDictation = ({
  disabled,
  chatKey,
  draftStorageKey,
  seedNonce,
  onTranscript,
  onError,
}: {
  disabled: boolean;
  chatKey: number | null | undefined;
  draftStorageKey: string | undefined;
  seedNonce: number | undefined;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) => {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [interimText, setInterimText] = useState("");
  const active = useRef<{ recognition: Recognition; listeners: AbortController } | null>(null);
  const RecognitionConstructor = getLocalRecognitionConstructor();

  const release = () => {
    const session = active.current;
    active.current = null;
    session?.listeners.abort();
    return session;
  };

  const abort = () => {
    release()?.recognition.abort();
  };

  const reset = () => {
    setStatus("idle");
    setInterimText("");
  };

  const finish = () => {
    release();
    reset();
  };

  // Invalidate browser callbacks before a new chat or draft can receive the old transcript.
  useLayoutEffect(() => {
    reset();
    return abort;
  }, [disabled, chatKey, draftStorageKey, seedNonce]);

  const toggle = () => {
    if (!RecognitionConstructor || disabled || status === "stopping") return;
    if (active.current) {
      // stop() lets the browser return its last words; abort() would discard them.
      setStatus("stopping");
      active.current.recognition.stop();
      return;
    }

    let recognition: Recognition;
    try {
      recognition = new RecognitionConstructor();
      recognition.processLocally = true;
      if (recognition.processLocally !== true) {
        onError(recognitionUnavailable);
        return;
      }
    } catch {
      onError(recognitionUnavailable);
      return;
    }
    const listeners = new AbortController();
    const { signal } = listeners;
    active.current = { recognition, listeners };
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.addEventListener("start", () => {
      setStatus((current) => current === "starting" ? "listening" : current);
    }, { signal });
    recognition.addEventListener("result", (event) => {
      const { resultIndex, results } = event as RecognitionResultEvent;
      const finalized: string[] = [];
      const interim: string[] = [];
      // Finalized results are cumulative. Append only newly finalized speech, but rebuild the
      // preview because the browser can revise or remove any interim word.
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (!result.isFinal) interim.push(text);
        else if (index >= resultIndex) finalized.push(text);
      }
      setInterimText(interim.join(" "));
      if (finalized.length) onTranscript(finalized.join(" "));
    }, { signal });
    recognition.addEventListener("end", finish, { signal });
    recognition.addEventListener("error", (event) => {
      const { error } = event as Event & { error: string };
      finish();
      const message = recognitionError(error);
      if (message) onError(message);
    }, { signal });

    setStatus("starting");
    try {
      recognition.start();
    } catch {
      finish();
      onError("Couldn’t start voice typing. Check your browser’s microphone permissions.");
    }
  };

  const cancel = () => {
    abort();
    reset();
  };

  return { supported: Boolean(RecognitionConstructor), status, interimText, toggle, cancel };
};
