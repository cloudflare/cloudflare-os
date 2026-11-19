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

export type DictationStatus = "idle" | "starting" | "downloading" | "listening" | "finishing";

/** Words waiting to be added: finalized ones, then the recognizer's latest guess. */
export type DictatedWords = { final: string; interim: string };

type Session = {
  recognition: Recognition;
  listeners: AbortController;
  started: boolean;
  // Finalized words from an earlier session, still waiting.
  earlier: string;
  transcript: string;
  interim: string;
  // The user pressed Stop, so the words go to the draft when the browser has finished.
  finishing: boolean;
};

const nothing: DictatedWords = { final: "", interim: "" };

const shownWords = ({ earlier, transcript, interim }: Session): DictatedWords => {
  // Trimmed only at the start: a finalized segment can end in the space before the guess.
  const final = appendDictatedText(earlier, transcript.trimStart());
  return { final, interim: !final || /\s$/.test(final) ? interim.trimStart() : interim };
};

/**
 * Dictation that leaves the draft alone: words wait here until the user adds them or discards
 * them. Stop lets the browser finish what it heard, then hands the words to `onFinish`; taking them
 * sooner hands over exactly what is on screen. Recognition that stops for any other reason
 * (silence, an error, the composer being disabled) keeps only finalized words, since nobody
 * confirmed the latest guess.
 */
export const useComposerDictation = ({
  disabled,
  chatKey,
  draftStorageKey,
  seedNonce,
  onFinish,
  onReady,
  onError,
}: {
  disabled: boolean;
  chatKey: number | null | undefined;
  draftStorageKey: string | undefined;
  seedNonce: number | undefined;
  onFinish: (words: string) => void;
  onReady: () => void;
  onError: (message: string) => void;
}) => {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [words, setWords] = useState(nothing);
  const active = useRef<Session | null>(null);
  // The browser ends long after the render that started the session.
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const RecognitionConstructor = getLocalRecognitionConstructor();

  // Detached listeners can't deliver late results to a draft that has moved on.
  const detach = () => {
    const session = active.current;
    if (!session) return;
    active.current = null;
    session.listeners.abort();
    if (session.started) session.recognition.abort();
    setStatus("idle");
  };

  /** Stops listening, keeping the finalized words. */
  const pause = () => {
    detach();
    setWords(({ final }) => ({ final, interim: "" }));
  };

  /** Stops listening and drops the words. */
  const discard = () => {
    detach();
    setWords(nothing);
  };

  /** Asks the browser to finish what it heard, keeping the strip until it has. */
  const finish = () => {
    const session = active.current;
    if (!session || status !== "listening") return;
    session.finishing = true;
    setStatus("finishing");
    session.recognition.stop();
  };

  /** Stops listening and hands over the words on screen. */
  const take = () => {
    const shown = (words.final + words.interim).trim();
    discard();
    return shown;
  };

  // Layout effects, so a new chat or draft never renders with the old one's words.
  useLayoutEffect(() => discard, [chatKey, draftStorageKey, seedNonce]);
  useLayoutEffect(() => {
    if (disabled) pause();
  }, [disabled]);

  const start = async () => {
    if (!RecognitionConstructor || disabled || active.current) return;
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
      recognition,
      listeners,
      started: false,
      earlier: words.final,
      transcript: "",
      interim: "",
      finishing: false,
    };
    active.current = session;
    recognition.continuous = true;
    recognition.interimResults = true;
    // Chrome ignores abort() until recognition has started, so a session dropped while it was
    // starting is aborted again once it has.
    recognition.addEventListener("start", () => {
      if (active.current !== session) recognition.abort();
    }, { once: true });
    recognition.addEventListener("start", () => {
      setStatus((previous) => previous === "starting" ? "listening" : previous);
    }, { signal });
    recognition.addEventListener("result", (event) => {
      const { resultIndex, results } = event as RecognitionResultEvent;
      const finalized: string[] = [];
      const interim: string[] = [];
      // Finalized results are cumulative. Append only newly finalized speech, but rebuild the
      // guess because the browser can revise or remove any interim word. Segments carry their
      // own leading whitespace where the language uses it, so they join as given.
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (!result.isFinal) interim.push(result[0].transcript);
        else if (index >= resultIndex) finalized.push(result[0].transcript);
      }
      session.transcript += finalized.join("");
      session.interim = interim.join("");
      setWords(shownWords(session));
    }, { signal });
    recognition.addEventListener("end", () => {
      if (!session.finishing) {
        pause();
        return;
      }
      const { final, interim } = shownWords(session);
      discard();
      onFinishRef.current((final + interim).trim());
    }, { signal });
    recognition.addEventListener("error", (event) => {
      const { error } = event as Event & { error: string };
      pause();
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
          detach();
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
          detach();
          if (installed) onReady();
          else onError(downloadFailed);
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        console.warn("Couldn't prepare on-device speech recognition:", error);
        detach();
        onError(setupError);
        return;
      }
    }

    try {
      recognition.start();
      session.started = true;
    } catch (error) {
      console.warn("Couldn't start speech recognition:", error);
      detach();
      onError("Couldn’t start voice typing. Try again.");
    }
  };

  return {
    supported: Boolean(RecognitionConstructor),
    status,
    words,
    start,
    finish,
    pause,
    take,
    discard,
  };
};
