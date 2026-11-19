// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";

type TestToast = {
  title: string;
  description?: string;
  variant: string;
  timeout?: number;
  actions?: { children: string; onClick: () => void }[];
};

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: TestToast) => string>(() => "toast-1"),
  closeToast: vi.fn<(toastId?: string) => void>(),
  gatekeeperModalProps: undefined as undefined | {
    open: boolean;
    onCreated: (gatekeeper: unknown) => Promise<void>;
    initialVendorId?: string;
    initialResourceUrl?: string;
    initialResourceUrlPattern?: string;
    initialAccountId?: number;
  },
  capsuleOverlayProps: undefined as undefined | {
    url: string;
    onSelectAccount: (accountId: number, vendorId: string, resource: { urlPattern: string }) => void;
  },
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast, close: testState.closeToast }),
}));

vi.mock("../../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}));

vi.mock("../../../useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));

vi.mock("../../../CapsuleOverlay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../CapsuleOverlay")>()),
  default: (props: typeof testState.capsuleOverlayProps) => {
    testState.capsuleOverlayProps = props;
    return null;
  },
}));

vi.mock("../../../GatekeeperModal", () => ({
  default: (props: typeof testState.gatekeeperModalProps) => {
    testState.gatekeeperModalProps = props;
    return null;
  },
}));

import { ChatComposer } from "./ChatComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

class TestSpeechRecognition extends EventTarget {
  static current: TestSpeechRecognition;
  #processLocally = false;
  get processLocally() { return this.#processLocally; }
  set processLocally(value: boolean) { this.#processLocally = value; }
  interimResults = false;
  lang = "";
  startedLocally = false;
  start = vi.fn<() => void>(() => {
    TestSpeechRecognition.current = this;
    this.startedLocally = this.processLocally;
    this.dispatchEvent(new Event("start"));
  });
  stop = vi.fn<() => void>();
  abort = vi.fn<() => void>();

  report(resultIndex: number, ...parts: { text: string; final: boolean }[]) {
    this.dispatchEvent(Object.assign(new Event("result"), {
      resultIndex,
      results: parts.map(({ text, final }) => ({ isFinal: final, 0: { transcript: text } })),
    }));
  }

  fail(error: string) {
    this.dispatchEvent(Object.assign(new Event("error"), { error }));
  }
}

const typeText = async (textarea: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      text,
    );
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
};

const pressEscape = (target: Element) => act(async () => target.dispatchEvent(
  new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
));

const addConnectionOption = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find((option) => option.textContent?.includes("Add a new connection"));

describe("ChatComposer", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  beforeEach(() => vi.stubGlobal("ResizeObserver", TestResizeObserver));

  afterEach(async () => {
    await act(async () => root?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    container?.remove();
    sessionStorage.clear();
    testState.addToast.mockClear();
    testState.closeToast.mockClear();
    testState.gatekeeperModalProps = undefined;
    testState.capsuleOverlayProps = undefined;
  });

  const renderDictationComposer = async (props: Partial<Parameters<typeof ChatComposer>[0]> = {}) => {
    if (!container?.isConnected) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={null}
        onModelChange={() => {}}
        {...props}
      />,
    ));
    return container.querySelector<HTMLTextAreaElement>("textarea")!;
  };

  const voiceButton = (action: "Start" | "Stop") =>
    container?.querySelector<HTMLButtonElement>(`button[aria-label="${action} voice typing"]`);
  const strip = () => container?.querySelector<HTMLElement>('[role="group"][aria-label="Voice typing"]');
  const stripText = () => strip()?.querySelector("p")?.textContent;
  const stripButton = (label: "Add to message" | "Discard what you said") =>
    strip()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  // The strip dims the guess the recognizer may still revise.
  const guess = () => strip()?.querySelector("p .text-kumo-subtle")?.textContent;
  const stopAndFinish = async (speech: TestSpeechRecognition) => {
    await act(async () => voiceButton("Stop")!.click());
    await act(async () => speech.dispatchEvent(new Event("end")));
  };

  it("shows speech apart from the draft and adds it when the user stops", async () => {
    vi.stubGlobal("webkitSpeechRecognition", TestSpeechRecognition);
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    const textarea = await renderDictationComposer({ onSend });
    await typeText(textarea, "Build");
    await act(async () => voiceButton("Start")!.click());
    const speech = TestSpeechRecognition.current;
    expect(speech.startedLocally).toBe(true);
    expect(speech.interimResults).toBe(true);
    expect(stripText()).toBe("Listening…");

    await act(async () => speech.report(0, { text: "a dash", final: false }));
    expect(textarea.value).toBe("Build");
    expect(guess()).toBe("a dash");
    expect(document.getElementById(textarea.getAttribute("aria-describedby")!)?.textContent)
      .toBe("a dash");
    const first = { text: "a dashboard", final: true };
    await act(async () => speech.report(0, first, { text: " with fil", final: false }));
    expect(guess()).toBe(" with fil");
    await act(async () => speech.report(1, first, { text: " with filters", final: false }));
    expect(stripText()).toBe("a dashboard with filters");

    await act(async () => voiceButton("Stop")!.click());
    expect(speech.stop).toHaveBeenCalledOnce();
    // The browser finishes what it heard first, and the strip stays until it has.
    expect(textarea.value).toBe("Build");
    expect(stripText()).toBe("a dashboard with filters");
    await act(async () => {
      speech.report(1, first, { text: " with filters", final: true });
      speech.dispatchEvent(new Event("end"));
    });
    expect(textarea.value).toBe("Build a dashboard with filters");
    expect(strip()).toBeNull();
    expect(voiceButton("Start")).not.toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("adds the words with the check, and discards them with the cross or Escape", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const textarea = await renderDictationComposer();
    await typeText(textarea, "Keep this");
    for (const discard of [
      () => act(async () => stripButton("Discard what you said")!.click()),
      () => pressEscape(textarea),
      () => pressEscape(voiceButton("Stop")!),
    ]) {
      await act(async () => voiceButton("Start")!.click());
      const speech = TestSpeechRecognition.current;
      await act(async () => speech.report(
        0,
        { text: "spoken words", final: true },
        { text: " and more", final: false },
      ));
      await discard();
      expect(speech.abort).toHaveBeenCalledOnce();
      expect(strip()).toBeNull();
      expect(textarea.value).toBe("Keep this");
    }

    await act(async () => voiceButton("Start")!.click());
    await act(async () => TestSpeechRecognition.current.report(0, { text: "for later", final: true }));
    await act(async () => stripButton("Add to message")!.click());
    expect(textarea.value).toBe("Keep this for later");
    expect(strip()).toBeNull();
  });

  it("leaves the draft's value, selection and typing to the user while listening", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const textarea = await renderDictationComposer();
    await typeText(textarea, "Build a dashboard");
    await act(async () => voiceButton("Start")!.click());
    const speech = TestSpeechRecognition.current;
    textarea.setSelectionRange(0, 5);
    await act(async () => speech.report(0, { text: "with filters", final: true }));
    expect(textarea.value).toBe("Build a dashboard");
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);

    await typeText(textarea, "Create a dashboard");
    expect(speech.abort).not.toHaveBeenCalled();
    expect(stripText()).toBe("with filters");
    await stopAndFinish(speech);
    expect(textarea.value).toBe("Create a dashboard with filters");
  });

  it("lets Add connection finish while listening", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const overseer = { listSlashCommands: async () => [] } as unknown as RpcStub<Overseer>;
    const textarea = await renderDictationComposer({ getOverseer: () => overseer });
    await typeText(textarea, "Summarize");
    await act(async () => voiceButton("Start")!.click());
    const speech = TestSpeechRecognition.current;
    await act(async () => container!
      .querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!.click());
    await act(async () => vi.waitFor(() => expect(addConnectionOption()).toBeDefined()));
    await act(async () => addConnectionOption()!.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);

    await act(async () => speech.report(0, { text: "the plan", final: true }));
    const gatekeeper = {
      getId: async () => 9,
      describe: async () => ({ title: "Project", url: "https://example.com/project" }),
      getCreationSpec: async () => ({ type: "gatekeeper", vendorId: "example" }),
      [Symbol.dispose]: vi.fn<() => void>(),
    };
    await act(async () => {
      await testState.gatekeeperModalProps!.onCreated(gatekeeper);
      await new Promise(requestAnimationFrame);
    });
    expect(textarea.value).toContain("Project");
    expect(testState.addToast).not.toHaveBeenCalled();
    await stopAndFinish(speech);
    expect(textarea.value.endsWith(" the plan")).toBe(true);
  });

  it("sends the words on screen with the draft, and drops a chat's words on leaving it", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    const textarea = await renderDictationComposer({ chatKey: 1, onSend });
    await act(async () => voiceButton("Start")!.click());
    const first = TestSpeechRecognition.current;
    const sentence = { text: "Show me the", final: true };
    await act(async () => first.report(0, sentence, { text: " forecast", final: false }));
    expect(textarea.value).toBe("");
    expect(container!.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled)
      .toBe(false);
    const lateResult = { text: " Late", final: true };
    await act(async () => {
      // Recognized, but not yet rendered, when Enter arrives.
      first.report(1, sentence, { text: " four cats", final: false });
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      first.report(1, sentence, lateResult);
    });
    expect(first.abort).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(
      "Show me the forecast", null, undefined, undefined, undefined,
    );
    expect(textarea.value).toBe("");
    expect(strip()).toBeNull();

    await act(async () => voiceButton("Start")!.click());
    const second = TestSpeechRecognition.current;
    await act(async () => second.report(0, { text: "Previous chat", final: true }));
    expect(stripText()).toBe("Previous chat");
    await renderDictationComposer({ chatKey: 2, onSend });
    await act(async () => second.report(0, lateResult));
    expect(second.abort).toHaveBeenCalledOnce();
    expect(strip()).toBeNull();
    expect(textarea.value).toBe("");
  });

  // None of these is the user keeping the latest guess, and none of them touches the draft.
  it.each(["ends on its own", "fails", "is blocked"])(
    "keeps only finalized words waiting when recognition %s",
    async (cause) => {
      vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
      const textarea = await renderDictationComposer();
      await typeText(textarea, "Note:");
      await act(async () => voiceButton("Start")!.click());
      const speech = TestSpeechRecognition.current;
      await act(async () => speech.report(
        0,
        { text: "call the bank", final: true },
        { text: " tomorrow maybe", final: false },
      ));
      if (cause === "is blocked") {
        await renderDictationComposer({ blockedReason: "Approve the request first" });
      } else {
        await act(async () => {
          // Chrome reports a lost local recognizer as "aborted", which the user never asked for.
          if (cause === "fails") speech.fail("aborted");
          else speech.dispatchEvent(new Event("end"));
        });
      }
      expect(speech.abort).toHaveBeenCalledOnce();
      expect(textarea.value).toBe("Note:");
      expect(stripText()).toBe("call the bank");
      expect(voiceButton("Start")).not.toBeNull();
      expect(testState.addToast).not.toHaveBeenCalled();
    },
  );

  it("adds the words at once, or drops them, while Stop is still finishing", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const textarea = await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    const first = TestSpeechRecognition.current;
    await act(async () => first.report(0, { text: "Quick note", final: true }));
    await act(async () => voiceButton("Stop")!.click());
    await act(async () => stripButton("Add to message")!.click());
    expect(first.abort).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("Quick note");
    await act(async () => first.dispatchEvent(new Event("end")));
    expect(textarea.value).toBe("Quick note");

    await act(async () => voiceButton("Start")!.click());
    const second = TestSpeechRecognition.current;
    await act(async () => second.report(0, { text: "never mind", final: true }));
    await act(async () => voiceButton("Stop")!.click());
    await pressEscape(textarea);
    await act(async () => second.dispatchEvent(new Event("end")));
    expect(textarea.value).toBe("Quick note");
    expect(strip()).toBeNull();
  });

  it("keeps the space a finalized segment ends with before the guess", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const textarea = await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    await act(async () => TestSpeechRecognition.current.report(
      0,
      { text: "Open the ", final: true },
      { text: "dashboard", final: false },
    ));
    expect(stripText()).toBe("Open the dashboard");
    await act(async () => stripButton("Add to message")!.click());
    expect(textarea.value).toBe("Open the dashboard");
  });

  it("returns focus to the draft when the strip's discard button takes itself away", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const textarea = await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    await act(async () => TestSpeechRecognition.current.report(0, { text: "scratch that", final: true }));
    const discard = stripButton("Discard what you said")!;
    discard.focus();
    await act(async () => discard.click());
    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("joins speech segments with the spacing the recognizer gives them", async () => {
    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    const textarea = await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    const speech = TestSpeechRecognition.current;
    const first = { text: "明日の", final: true };
    await act(async () => speech.report(0, first));
    await act(async () => speech.report(1, first, { text: "予定を確認", final: true }));
    expect(stripText()).toBe("明日の予定を確認");
    await stopAndFinish(speech);
    expect(textarea.value).toBe("明日の予定を確認");
  });

  // Chrome ignores abort() and stop() until recognition has started.
  it("aborts a session the user dropped while the browser was still starting it", async () => {
    class SlowRecognition extends TestSpeechRecognition {
      start = vi.fn<() => void>(() => {
        TestSpeechRecognition.current = this;
      });
    }
    vi.stubGlobal("SpeechRecognition", SlowRecognition);
    await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    await act(async () => voiceButton("Stop")!.click());
    const speech = TestSpeechRecognition.current;
    const aborts = speech.abort.mock.calls.length;
    await act(async () => speech.dispatchEvent(new Event("start")));
    expect(speech.abort).toHaveBeenCalledTimes(aborts + 1);
    expect(voiceButton("Start")).not.toBeNull();
  });

  it("keeps typing available without speech support or microphone permission", async () => {
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const textarea = await renderDictationComposer();
    expect(voiceButton("Start")).toBeNull();

    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    await act(async () => TestSpeechRecognition.current.fail("not-allowed"));
    expect(testState.addToast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("microphone permissions"),
      variant: "error",
    }));
    expect(voiceButton("Start")).not.toBeNull();
    await typeText(textarea, "Typed prompt");
    expect(textarea.value).toBe("Typed prompt");
  });

  it("never falls back to a cloud recognizer when local recognition is unavailable", async () => {
    const legacyStart = vi.fn<() => void>();
    vi.stubGlobal("SpeechRecognition", undefined);
    vi.stubGlobal("webkitSpeechRecognition", class { start = legacyStart; });
    await renderDictationComposer();
    expect(voiceButton("Start")).toBeNull();

    vi.stubGlobal("SpeechRecognition", TestSpeechRecognition);
    await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    const speech = TestSpeechRecognition.current;
    expect(speech.startedLocally).toBe(true);
    await act(async () => speech.fail("language-not-supported"));
    expect(testState.addToast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining("language pack"),
    }));
    expect(speech.start).toHaveBeenCalledOnce();
    expect(legacyStart).not.toHaveBeenCalled();
  });

  it.each([false, true])("downloads a language pack without turning the mic on (switched chats: %s)", async (switched) => {
    const download = Promise.withResolvers<boolean>();
    const started = vi.fn<() => void>();
    class DownloadableRecognition extends TestSpeechRecognition {
      static available = vi.fn<(options: { langs: string[]; processLocally: boolean }) => Promise<string>>()
        .mockResolvedValueOnce("downloadable")
        .mockResolvedValue("available");
      static install = vi.fn<(options: { langs: string[]; processLocally: boolean }) => Promise<boolean>>()
        .mockReturnValue(download.promise);

      constructor() {
        super();
        this.addEventListener("start", () => started());
      }
    }
    vi.stubGlobal("SpeechRecognition", DownloadableRecognition);
    const textarea = await renderDictationComposer({ chatKey: 1 });
    expect(DownloadableRecognition.install).not.toHaveBeenCalled();
    await act(async () => voiceButton("Start")!.click());
    const options = { langs: ["en-US"], processLocally: true };
    expect(DownloadableRecognition.available).toHaveBeenCalledWith(options);
    expect(DownloadableRecognition.install).toHaveBeenCalledWith(options);
    expect(container!.querySelector('[role="status"].sr-only')?.textContent)
      .toBe("Downloading the voice typing language pack…");

    if (switched) await renderDictationComposer({ chatKey: 2 });
    await act(async () => download.resolve(true));
    expect(started).not.toHaveBeenCalled();
    expect(voiceButton("Start")).not.toBeNull();
    expect(testState.addToast.mock.calls.map(([toast]) => toast.title))
      .toEqual(switched ? [] : ["Voice typing is ready"]);

    await act(async () => voiceButton("Start")!.click());
    expect(started).toHaveBeenCalledOnce();
    expect(DownloadableRecognition.install).toHaveBeenCalledOnce();
    const speech = TestSpeechRecognition.current;
    await act(async () => speech.report(0, { text: "Build a dashboard", final: true }));
    await stopAndFinish(speech);
    expect(textarea.value).toBe("Build a dashboard");
  });

  it("falls back to English (US) when the browser's language has no on-device pack", async () => {
    const language = vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    onTestFinished(() => language.mockRestore());
    const available = vi.fn<(options: { langs: string[]; processLocally: boolean }) => Promise<string>>(
      async ({ langs }) => langs[0] === "de-DE" ? "unavailable" : "available",
    );
    class LocalizedRecognition extends TestSpeechRecognition {
      static available = available;
    }
    vi.stubGlobal("SpeechRecognition", LocalizedRecognition);
    await renderDictationComposer();
    await act(async () => voiceButton("Start")!.click());
    expect(available.mock.calls.map(([options]) => options.langs)).toEqual([["de-DE"], ["en-US"]]);
    expect(TestSpeechRecognition.current.lang).toBe("en-US");
    expect(TestSpeechRecognition.current.start).toHaveBeenCalledOnce();
  });

  it("sends on Enter without clearing document changes made while sending", async () => {
    let finishSend: (() => void) | undefined;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(
      () => new Promise<void>((resolve) => { finishSend = resolve; }),
    );
    const overseer = {} as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "  Build a dashboard  ",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      "Build a dashboard",
      "model-a",
      undefined,
      undefined,
      undefined,
    );
    expect(textarea.disabled).toBe(false);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Next question",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => finishSend!());
    expect(textarea.value).toBe("Next question");
    expect(textarea.disabled).toBe(false);
    expect(testState.addToast).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error("Peer closed WebSocket"), transient: true },
    { error: new Error("send rejected"), transient: false },
  ])("preserves the draft after a failed send", async ({ error, transient }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(async () => {
      throw error;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
        chatKey={7}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Keep this draft",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(textarea.value).toBe("Keep this draft");
    expect(container.textContent?.includes("Connection hiccup")).toBe(transient);
    expect(consoleError).toHaveBeenCalledTimes(transient ? 0 : 1);
    consoleError.mockRestore();
  });

  describe("while the agent works", () => {
    type ComposerProps = Parameters<typeof ChatComposer>[0];

    const mountRoot = () => {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    };
    const render = (props: Partial<ComposerProps>) => act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        isAgentActive
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
        chatKey={7}
        draftStorageKey="draft:chat-7"
        {...props}
      />,
    ));
    const textarea = () => container!.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const button = (label: string) =>
      container!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    const pressEnter = () => act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    it("steers on Enter, and keeps Stop disabled while the steer sends", async () => {
      let finishSend: (() => void) | undefined;
      const onSend = vi.fn<ComposerProps["onSend"]>(
        () => new Promise<void>((resolve) => { finishSend = resolve; }),
      );
      mountRoot();
      await render({ onSend, onStop: async () => {} });

      await typeText(textarea(), "Make it dark.");
      await pressEnter();
      expect(onSend).toHaveBeenCalledWith("Make it dark.", "model-a", undefined, undefined, undefined);
      expect(button("Stop agent")!.disabled).toBe(true);
      await act(async () => finishSend!());
      expect(textarea().value).toBe("");
      expect(button("Stop agent")!.disabled).toBe(false);
    });

    it("puts the dropped steers after the draft, and steers nothing until the agent is idle",
        async () => {
      const onSend = vi.fn<ComposerProps["onSend"]>();
      const onStop = vi.fn<() => Promise<void>>(async () => {});
      mountRoot();
      await render({ onSend, onStop, queuedSteers: ["A"] });

      await typeText(textarea(), "Half a thought  ");
      expect(button("Send message")).not.toBeNull();
      await act(async () => button("Stop agent")!.click());
      expect(onStop).toHaveBeenCalledOnce();
      expect(textarea().value).toBe("Half a thought\n\nA");
      expect(button("Stop agent")!.disabled).toBe(true);
      expect(button("Send message")).toBeNull();
      await pressEnter();
      expect(onSend).not.toHaveBeenCalled();

      await render({ onSend, onStop, queuedSteers: [], isAgentActive: false });
      await pressEnter();
      expect(onSend).toHaveBeenCalledWith("Half a thought\n\nA", "model-a", undefined, undefined, undefined);
    });

    it("keeps the dropped steers in the draft when Stop fails", async () => {
      let failStop: ((err: Error) => void) | undefined;
      const onStop = vi.fn<() => Promise<void>>(
        () => new Promise<void>((_, reject) => { failStop = reject; }),
      );
      mountRoot();
      await render({ onStop, queuedSteers: ["A"] });
      await typeText(textarea(), "Draft");

      await act(async () => button("Stop agent")!.click());
      expect(button("Stop agent")!.disabled).toBe(true);
      await act(async () => failStop!(new Error("Peer closed WebSocket")));
      expect(textarea().value).toBe("Draft\n\nA");
      expect(button("Stop agent")!.disabled).toBe(false);
    });
  });

  it("keeps add-menu actions enabled after inserting a skill and removes the legacy button", async () => {
    const skill = {
      selection: { gatekeeperId: 42, commandId: "review" },
      name: "review",
      description: "Review the current project.",
      providerLabel: "Projects",
    };
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [skill]);
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
        attachLabel="Legacy resource"
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "before after",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    textarea.setSelectionRange(7, 7);
    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!;
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .some((option) => option.textContent?.includes("review")),
    ).toBe(true)));
    const skillOption = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("review"))!;
    await act(async () => {
      skillOption.click();
      await new Promise(requestAnimationFrame);
    });

    expect(textarea.value).toBe("before /review after");
    expect(document.body.textContent)
      .toContain("Slash command /review from Projects is ready to send");
    expect(document.activeElement).toBe(textarea);

    await act(async () => add.click());
    const actions = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => !action.disabled)).toBe(true);
    expect(document.querySelector('[aria-label="Search skills"]')).toBeNull();
    expect(container.textContent).not.toContain("Add resource");
    expect(container.textContent).not.toContain("Legacy resource");
    const connection = actions.find((action) => action.textContent?.includes("Add a new connection"))!;
    await act(async () => connection.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);
    expect(listSlashCommands).toHaveBeenCalledTimes(1);
  });

  it("sends unconfirmed slash text as plain text", async () => {
    const skill: SlashCommandChoice = {
      selection: { gatekeeperId: 42, commandId: "deploy" },
      name: "deploy",
      description: "Deploy the current project.",
      providerLabel: "Projects",
    };
    const overseer = {
      listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [skill]),
    } as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "/deploy production",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      "/deploy production",
      "model-a",
      undefined,
      undefined,
      undefined,
    );
  });

  it("sends double slash as literal text without opening the skill picker", async () => {
    const overseer = {
      listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => []),
    } as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={null}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "//deploy literally",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(overseer.listSlashCommands).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      "//deploy literally", null, undefined, undefined, undefined,
    );
  });

  it("invalidates and refetches skills after adding a connection", async () => {
    const firstSkill = {
      selection: { gatekeeperId: 1, commandId: "first" },
      name: "first skill",
      description: "Initially connected.",
      providerLabel: "Tools",
    };
    const nextSkill = {
      ...firstSkill,
      selection: { gatekeeperId: 2, commandId: "next" },
      name: "new connection skill",
    };
    let catalog = [firstSkill];
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => catalog);
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!;
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(document.body.textContent).toContain("first skill")));
    const connect = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Add a new connection"))!;
    await act(async () => connect.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);

    catalog = [firstSkill, nextSkill];
    const gatekeeper = {
      getId: async () => 9,
      describe: async () => ({ title: "Project", url: "https://example.com/project" }),
      getCreationSpec: async () => ({ type: "gatekeeper", vendorId: "example" }),
      [Symbol.dispose]: vi.fn<() => void>(),
    };
    await act(async () => {
      await testState.gatekeeperModalProps!.onCreated(gatekeeper);
      await new Promise(requestAnimationFrame);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const resourceEnd = textarea.value.indexOf("Project") + "Project".length;
    textarea.setSelectionRange(resourceEnd, resourceEnd);
    await act(async () => textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    ));
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(document.body.textContent)
      .toContain("new connection skill")));
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });

  const url = "https://docs.google.com/spreadsheets/d/abc123/edit";
  const reason = "This file is an Office file rather than a Google Sheets file.";

  // Pastes `url` after "Summarize ", picks account 4 for it, and has the connection fail.
  const pasteFailingUrl = async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // jsdom has no Range layout; the URL panel measures the line its URL sits on.
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    onTestFinished(() => {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    });
    const createCapsuleGatekeeper = vi.fn<
      Parameters<typeof ChatComposer>[0]["createCapsuleGatekeeper"]
    >(async () => {
      throw new Error(reason);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={createCapsuleGatekeeper}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const text = `Summarize ${url}`;
    await typeText(textarea, text);
    expect(testState.capsuleOverlayProps?.url).toBe(url);

    await act(async () => testState.capsuleOverlayProps!.onSelectAccount(
      4,
      "google",
      { urlPattern: "https://docs.google.com/spreadsheets/d/*" },
    ));
    await act(async () => vi.waitFor(() => expect(testState.addToast).toHaveBeenCalledOnce()));
    consoleError.mockRestore();

    expect(createCapsuleGatekeeper).toHaveBeenCalledWith(4, url);
    return { textarea, toast: testState.addToast.mock.calls[0][0] };
  };

  it("offers to configure a pasted URL that could not be connected, then replaces it", async () => {
    const { textarea, toast } = await pasteFailingUrl();

    expect(toast).toMatchObject({
      title: "Failed to add resource",
      description: reason,
      variant: "error",
      timeout: 0,
    });
    expect(toast.actions?.map((action) => action.children)).toEqual(["Configure…"]);
    expect(testState.gatekeeperModalProps?.open).toBe(false);

    act(() => toast.actions![0].onClick());

    expect(testState.closeToast).toHaveBeenCalledWith("toast-1");
    expect(testState.gatekeeperModalProps).toMatchObject({
      open: true,
      initialVendorId: "google",
      initialResourceUrl: url,
      initialResourceUrlPattern: "https://docs.google.com/spreadsheets/d/*",
      initialAccountId: 4,
    });

    const gatekeeper = {
      getId: async () => 9,
      describe: async () => ({ title: "Budget", url: "https://docs.google.com/spreadsheets/d/copy" }),
      getCreationSpec: async () => ({ type: "gatekeeper", vendorId: "google" }),
      remove: vi.fn<() => Promise<void>>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    };
    await act(async () => {
      await testState.gatekeeperModalProps!.onCreated(gatekeeper);
      await new Promise(requestAnimationFrame);
    });

    expect(textarea.value).toBe("Summarize Budget ");
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(testState.gatekeeperModalProps?.open).toBe(false);
    expect(testState.gatekeeperModalProps?.initialResourceUrl).toBeUndefined();
  });

  it("closes its Configure… toast when the composer unmounts", async () => {
    const { toast } = await pasteFailingUrl();
    expect(toast.actions?.map((action) => action.children)).toEqual(["Configure…"]);
    expect(testState.closeToast).not.toHaveBeenCalled();

    act(() => root!.unmount());
    root = undefined;

    expect(testState.closeToast).toHaveBeenCalledExactlyOnceWith("toast-1");
  });

  it("reports a URL gone before Configure with a toast that times out as usual", async () => {
    const { textarea, toast } = await pasteFailingUrl();
    await typeText(textarea, "Summarize nothing");

    act(() => toast.actions![0].onClick());

    expect(testState.gatekeeperModalProps?.open).toBe(false);
    expect(testState.addToast).toHaveBeenCalledTimes(2);
    const changed = testState.addToast.mock.calls[1][0];
    expect(changed).toMatchObject({
      title: "The prompt changed before the resource could be added",
      variant: "error",
    });
    expect(changed.timeout).toBeUndefined();
    expect(changed.actions).toBeUndefined();
  });
});
