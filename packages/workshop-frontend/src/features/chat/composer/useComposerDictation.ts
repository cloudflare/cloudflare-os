import { useLayoutEffect, useRef, useState } from "react";

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};

type Recognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type LanguagePackOptions = { langs: string[]; processLocally: true };
type LanguagePackAvailability = "available" | "downloadable" | "downloading" | "unavailable";
type RecognitionConstructor = {
  new (): Recognition;
  available?: (options: LanguagePackOptions) => Promise<LanguagePackAvailability>;
  install?: (options: LanguagePackOptions) => Promise<boolean>;
};

const getLocalRecognitionConstructor = () => {
  if (typeof window === "undefined") return;
  const browser = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  // Assigning an unknown property on a legacy recognizer would not prevent cloud processing.
  return [browser.SpeechRecognition, browser.webkitSpeechRecognition].find(
    (Recognition) => Recognition && "processLocally" in Recognition.prototype,
  );
};

// The browser's language first, then English (US) for locales with no on-device language pack.
const candidateLanguages = () => [...new Set([navigator.language, "en-US"].filter(Boolean))];

const recognitionUnavailable = "Voice typing is unavailable. You can still type your message.";
const downloadFailed = "Couldn’t download the voice typing language pack. Try again later.";

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

/** Joins dictated words onto `text`, separated by a space unless `text` already ends in one. */
export const appendDictatedText = (text: string, dictated: string) =>
  text + (dictated && text && !/\s$/.test(text) ? " " : "") + dictated;

export type DictationStatus = "idle" | "starting" | "downloading" | "listening" | "stopping";

type Session = {
  recognition: Recognition;
  listeners: AbortController;
  started: boolean;
  stopRequested: boolean;
  transcript: string;
  interim: string;
};

/**
 * Holds what the user says outside the draft until dictation ends, then hands the words shown to
 * `onTranscript` in one piece, or drops them when the user cancels or the draft changes identity.
 */
export const useComposerDictation = ({
  disabled,
  chatKey,
  draftStorageKey,
  seedNonce,
  onTranscript,
  onReady,
  onError,
}: {
  disabled: boolean;
  chatKey: number | null | undefined;
  draftStorageKey: string | undefined;
  seedNonce: number | undefined;
  onTranscript: (text: string) => void;
  onReady: () => void;
  onError: (message: string) => void;
}) => {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [text, setText] = useState("");
  // The words the last commit painted, which can trail the session by a result still rendering.
  // A ref, because callers such as a toast's action hold an older render's closure.
  const shown = useRef("");
  const active = useRef<Session | null>(null);
  const RecognitionConstructor = getLocalRecognitionConstructor();

  // Detached listeners can't deliver a late transcript to a draft that has moved on.
  const detach = () => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    shown.current = "";
    session.listeners.abort();
    setStatus("idle");
    setText("");
    return session;
  };

  // abort(), unlike stop(), keeps the browser from finalizing words the caller already has.
  const discard = () => {
    const session = detach();
    if (session?.started) session.recognition.abort();
    return session;
  };

  const keep = (words: string) => {
    const trimmed = words.trim();
    if (trimmed) onTranscript(trimmed);
  };

  /** Ends dictation, keeping the words on screen rather than a newer guess the user hasn't seen. */
  const finish = () => {
    const words = shown.current;
    if (discard()) keep(words);
  };

  /** Ends dictation, dropping the words it shows. */
  const cancel = () => {
    discard();
  };

  useLayoutEffect(() => {
    shown.current = text;
  }, [text]);
  // Layout effects, so a new chat or draft never renders with the old one's words.
  useLayoutEffect(() => cancel, [chatKey, draftStorageKey, seedNonce]);
  // Send and the resource flows finish dictation before they disable it, so whatever disables it
  // here, such as an agent blocking the composer, is not the user keeping the words: only
  // finalized ones survive, as when the browser ends on its own.
  useLayoutEffect(() => {
    if (!disabled) return;
    const session = discard();
    if (session) keep(session.transcript);
  }, [disabled]);

  const toggle = async () => {
    if (!RecognitionConstructor || disabled || status === "stopping") return;
    const current = active.current;
    if (current) {
      if (!current.started) {
        discard();
        return;
      }
      // stop() lets the browser return its last words, which the end event then keeps.
      setStatus("stopping");
      current.stopRequested = true;
      current.recognition.stop();
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
    } catch (error) {
      console.warn("Couldn't create a local speech recognizer:", error);
      onError(recognitionUnavailable);
      return;
    }
    const listeners = new AbortController();
    const { signal } = listeners;
    const session: Session = {
      recognition, listeners, started: false, stopRequested: false, transcript: "", interim: "",
    };
    active.current = session;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.addEventListener("start", () => {
      setStatus((previous) => previous === "starting" ? "listening" : previous);
    }, { signal });
    recognition.addEventListener("result", (event) => {
      const { resultIndex, results } = event as RecognitionResultEvent;
      const finalized: string[] = [];
      const interim: string[] = [];
      // Finalized results are cumulative. Append only newly finalized speech, but rebuild the
      // preview because the browser can revise or remove any interim word. Segments carry their
      // own leading whitespace where the language uses it, so they join as given.
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (!result.isFinal) interim.push(result[0].transcript);
        else if (index >= resultIndex) finalized.push(result[0].transcript);
      }
      session.transcript += finalized.join("");
      session.interim = interim.join("");
      setText((session.transcript + session.interim).trim());
    }, { signal });
    // The browser may end without finalizing its last guess. Stop is the user keeping the words on
    // screen; otherwise, as after an error, only finalized words survive.
    recognition.addEventListener("end", () => {
      const ended = detach();
      if (ended) keep(ended.transcript + (ended.stopRequested ? ended.interim : ""));
    }, { signal });
    recognition.addEventListener("error", (event) => {
      const { error } = event as Event & { error: string };
      const failed = detach();
      if (failed) keep(failed.transcript);
      const message = recognitionError(error);
      if (message) onError(message);
    }, { signal });

    setStatus("starting");
    const languages = candidateLanguages();
    recognition.lang = languages[0];
    if (RecognitionConstructor.available) {
      let setupError = recognitionUnavailable;
      try {
        let availability: LanguagePackAvailability = "unavailable";
        for (const lang of languages) {
          availability = await RecognitionConstructor.available({ langs: [lang], processLocally: true });
          if (signal.aborted) return;
          recognition.lang = lang;
          if (availability !== "unavailable") break;
        }
        if (availability === "unavailable") {
          discard();
          onError("Voice typing isn’t available for your language in this browser.");
          return;
        }
        if (availability !== "available") {
          setupError = downloadFailed;
          setStatus("downloading");
          // The mic stays off until the user asks again, however long the browser's download takes.
          const installed = await RecognitionConstructor.install?.(
            { langs: [recognition.lang], processLocally: true },
          );
          if (signal.aborted) return;
          discard();
          if (installed) onReady();
          else onError(downloadFailed);
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        console.warn("Couldn't prepare on-device speech recognition:", error);
        discard();
        onError(setupError);
        return;
      }
    }

    try {
      recognition.start();
      session.started = true;
    } catch (error) {
      console.warn("Couldn't start speech recognition:", error);
      discard();
      onError("Couldn’t start voice typing. Try again.");
    }
  };

  return {
    supported: Boolean(RecognitionConstructor),
    status,
    /** The words dictation shows but the draft doesn't hold yet. */
    text,
    toggle,
    finish,
    cancel,
  };
};
