// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MAX_TRANSCRIPTION_AUDIO_BYTES } from "@gadgets/workshop-shared/api";
import { ComposerDictation } from "./ComposerDictation";
import { FINAL_CHUNK, installFakeMicrophone, type FakeMicrophone } from "./fakeMicrophone";
import { MAX_DICTATION_MS } from "./useDictation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ComposerDictation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let microphone: FakeMicrophone;
  let transcribe: Mock<(audio: Uint8Array) => Promise<string>>;
  let onTranscript: Mock<(text: string) => void>;
  let onReturnFocus: Mock<() => void>;

  beforeEach(async () => {
    microphone = installFakeMicrophone();
    transcribe = vi.fn<(audio: Uint8Array) => Promise<string>>(async () => "Build me a gadget");
    onTranscript = vi.fn<(text: string) => void>();
    onReturnFocus = vi.fn<() => void>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(
      <ComposerDictation
        transcribe={transcribe}
        onTranscript={onTranscript}
        disabled={false}
        onReturnFocus={onReturnFocus}
      />,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

  const click = async (name: string) => {
    await act(async () => button(name)!.click());
  };

  // Starts recording and hands the recorder one chunk.
  const record = async (chunk = new Uint8Array([1, 2, 3])) => {
    await click("Dictate");
    let recorder = microphone.recorders.at(-1)!;
    expect(recorder.state).toBe("recording");
    act(() => recorder.emit(chunk));
    return recorder;
  };

  // Leaves the request for the microphone pending; the returned function grants it.
  const holdMicrophone = () => {
    let resolve!: (stream: MediaStream) => void;
    microphone.getUserMedia.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    return () => act(async () => resolve(microphone.stream));
  };

  it("transcribes the recording once finished and hands over the text", async () => {
    await record();
    expect(transcribe).not.toHaveBeenCalled();

    await click("Finish dictation");

    expect(transcribe).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3, ...FINAL_CHUNK]));
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Build me a gadget");
    expect(microphone.track.stop).toHaveBeenCalled();
    expect(button("Dictate")).not.toBeNull();
  });

  it("discards a cancelled recording without transcribing it and releases the microphone",
      async () => {
    await record();

    await click("Cancel dictation");

    expect(microphone.track.stop).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(button("Dictate")).not.toBeNull();
  });

  it("stops by itself after the longest dictation and transcribes it", async () => {
    vi.useFakeTimers();
    await record();

    await act(async () => vi.advanceTimersByTime(MAX_DICTATION_MS - 1));
    expect(transcribe).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));

    expect(transcribe).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("Build me a gadget");
  });

  describe("stopping by itself", () => {
    // Stands in for the composer, which `onReturnFocus` focuses.
    let composer: HTMLInputElement;

    beforeEach(async () => {
      vi.useFakeTimers();
      composer = document.createElement("input");
      document.body.append(composer);
      onReturnFocus.mockImplementation(() => composer.focus());
      // Still transcribing while the test looks.
      transcribe.mockReturnValueOnce(new Promise(() => {}));
      await record();
    });

    afterEach(() => {
      composer.remove();
    });

    it("gives focus back to the composer when Finish had it", async () => {
      expect(document.activeElement).toBe(button("Finish dictation"));

      await act(async () => vi.advanceTimersByTime(MAX_DICTATION_MS));

      expect(container.textContent).toContain("Transcribing");
      expect(document.activeElement).toBe(composer);
    });

    it("leaves focus where the user moved it", async () => {
      let elsewhere = document.createElement("input");
      document.body.append(elsewhere);
      elsewhere.focus();

      await act(async () => vi.advanceTimersByTime(MAX_DICTATION_MS));

      expect(container.textContent).toContain("Transcribing");
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });
  });

  it("stops by itself short of the server's size cap, leaving room for the last chunk",
      async () => {
    let recorder = await record(new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES / 2));
    expect(recorder.state).toBe("recording");

    await act(async () => recorder.emit(new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES / 2 - 1)));

    expect(recorder.state).toBe("inactive");
    let sent = transcribe.mock.calls[0][0];
    expect(sent.byteLength).toBeLessThanOrEqual(MAX_TRANSCRIPTION_AUDIO_BYTES);
  });

  it("refuses a recording that late chunks took over the server's cap, with nothing to retry",
      async () => {
    let recorder = await record();

    // A browser that held chunks back hands them over at once, past the stop short of the cap.
    await act(async () => recorder.emit(new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES)));

    expect(container.textContent).toContain("The recording is too long.");
    expect(button("Retry transcription")).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    expect(microphone.track.stop).toHaveBeenCalled();
  });

  it("keeps a recording whose transcription failed, so Retry sends it again", async () => {
    let consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    transcribe.mockRejectedValueOnce(new Error("Voice input is turned off on this deployment."));
    await record();

    await click("Finish dictation");

    expect(container.textContent).toContain("Voice input is turned off on this deployment.");
    expect(onTranscript).not.toHaveBeenCalled();

    await click("Retry transcription");

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[1][0]).toEqual(transcribe.mock.calls[0][0]);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("Build me a gadget");
    consoleError.mockRestore();
  });

  it("gives focus back while transcribing, and a failure does not take it away", async () => {
    let consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectCall!: (error: Error) => void;
    transcribe.mockImplementation(() => new Promise((_, reject) => { rejectCall = reject; }));
    // Stands in for the composer, where the user may type while the clip is transcribed.
    let composer = document.createElement("input");
    document.body.append(composer);
    onReturnFocus.mockImplementation(() => composer.focus());
    await record();

    await click("Finish dictation");
    expect(document.activeElement).toBe(composer);
    await act(async () => rejectCall(new Error("Network error")));

    expect(button("Retry transcription")).not.toBeNull();
    expect(document.activeElement).toBe(composer);
    // A click or keypress on Retry focuses it first, and Retry is gone once the clip is sent.
    button("Retry transcription")!.focus();
    await click("Retry transcription");
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(composer);
    composer.remove();
    consoleError.mockRestore();
  });

  it("focuses Retry when a failed transcription finds focus nowhere", async () => {
    let consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    transcribe.mockRejectedValueOnce(new Error("Network error"));
    await record();

    await click("Finish dictation");

    expect(document.activeElement).toBe(button("Retry transcription"));
    consoleError.mockRestore();
  });

  it("ignores a transcript that arrives after the composer is gone", async () => {
    let finish!: (text: string) => void;
    transcribe.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await record();
    await click("Finish dictation");
    expect(transcribe).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await act(async () => finish("Build me a gadget"));

    expect(onTranscript).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("says when nothing was recognized, with nothing to retry", async () => {
    transcribe.mockResolvedValueOnce("");
    await record();

    await click("Finish dictation");

    expect(container.textContent).toContain("No speech was recognized.");
    expect(button("Retry transcription")).toBeNull();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("releases the microphone when unmounted mid-recording, and never transcribes", async () => {
    await record();

    await act(async () => root.unmount());
    await act(async () => {});

    expect(microphone.track.stop).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("releases a microphone granted after the composer is gone, without recording", async () => {
    let grant = holdMicrophone();
    await click("Dictate");

    await act(async () => root.unmount());
    await grant();

    expect(microphone.track.stop).toHaveBeenCalled();
    expect(microphone.recorders).toHaveLength(0);
    root = createRoot(container);
  });

  it("can be cancelled while waiting for the microphone, releasing a later grant", async () => {
    let grant = holdMicrophone();
    await click("Dictate");
    expect(container.textContent).toContain("Waiting for the microphone");

    await click("Cancel dictation");
    await grant();

    expect(microphone.track.stop).toHaveBeenCalled();
    expect(microphone.recorders).toHaveLength(0);
    expect(onReturnFocus).toHaveBeenCalled();
    expect(button("Dictate")).not.toBeNull();
  });

  it("moves lost focus to Cancel while the microphone opens, then to Finish", async () => {
    let grant = holdMicrophone();
    await click("Dictate");
    expect(document.activeElement).toBe(button("Cancel dictation"));

    await grant();

    expect(document.activeElement).toBe(button("Finish dictation"));
  });

  it("leaves focus where the user moved it while the microphone opened", async () => {
    let grant = holdMicrophone();
    await click("Dictate");
    let elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    elsewhere.focus();

    await grant();

    expect(button("Finish dictation")).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("releases the microphone and explains when the recording cannot start", async () => {
    vi.spyOn(MediaRecorder.prototype, "start").mockImplementation(() => {
      throw new DOMException("inactive stream", "NotSupportedError");
    });

    await click("Dictate");

    expect(container.textContent).toContain("Recording failed.");
    expect(microphone.track.stop).toHaveBeenCalled();
    await click("Dismiss");
    expect(button("Dictate")).not.toBeNull();
  });

  it("explains a denied microphone, with nothing to retry", async () => {
    microphone.getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));

    await click("Dictate");

    expect(container.textContent).toContain("Microphone access was denied.");
    expect(button("Retry transcription")).toBeNull();
    // The microphone button that had focus is gone; focus goes to what replaced it.
    expect(document.activeElement).toBe(button("Dismiss"));
    await click("Dismiss");
    expect(button("Dictate")).not.toBeNull();
  });
});
