/* eslint-disable react/react-in-jsx-scope */

// The composer's bottom line in Chromium, at the narrowest chat pane: every control there has to
// stay inside the prompt box, which only a real layout engine measures.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import type { Overseer } from "@gadgets/workshop-shared/api";
import "../../../styles.css";

vi.mock("../../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}));
vi.mock("../../../useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));

import { ChatComposer } from "./ChatComposer";

// Voice typing adds a control to the left of the line, so the test has it offered.
class TestSpeechRecognition extends EventTarget {
  start() {}
  stop() {}
  abort() {}
}

describe("the composer's bottom line", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  // 280px is the narrowest chat pane GadgetEditor supports. A steer while the agent runs shows
  // both Stop and Send, the widest the line gets.
  it("keeps every control inside the prompt box in the narrowest pane, the mode named", async () => {
    vi.stubGlobal("webkitSpeechRecognition", TestSpeechRecognition);
    container = document.body.appendChild(document.createElement("div"));
    container.style.width = "280px";
    root = createRoot(container);
    await act(async () => root!.render(
      <TooltipProvider><Toasty><ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        isAgentActive
        onStop={async () => {}}
        models={[{ type: "agent", id: "claude-opus-5-5", name: "Claude Opus 5.5" }]}
        selectedModel={{ id: "claude-opus-5-5" }}
        onModelChange={() => {}}
        mode={{ mode: "review", restricted: false, onModeChange: () => {} }}
        onToggleThinkingTraces={() => {}}
      /></Toasty></TooltipProvider>,
    ));
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Also add a map");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const box = container.getBoundingClientRect();
    const send = container.querySelector<HTMLElement>('button[aria-label="Send message"]')!;
    const stop = container.querySelector<HTMLElement>('button[aria-label="Stop agent"]')!;
    const mode = container.querySelector<HTMLElement>('button[aria-label="Mode: Review"]')!;
    for (const control of [send, stop, mode, ...container.querySelectorAll<HTMLElement>("button")]) {
      const rect = control.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
      expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
    }
    // The name is shown whole, not cut short.
    const label = mode.querySelector("span")!;
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    expect(label.textContent).toBe("Review");
  });
});
