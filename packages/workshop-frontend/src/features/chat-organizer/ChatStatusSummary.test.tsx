// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AiChatMetadata } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStatusSummary } from "./ChatStatusSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: number): AiChatMetadata =>
  ({ id, title: `Chat ${id}`, started: new Date(0), lastActive: new Date(id) });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const render = (chats: AiChatMetadata[], unreadCount: (chatId: number) => number) => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ChatStatusSummary chats={chats} unreadCount={unreadCount} />));
};

describe("ChatStatusSummary", () => {
  it("adds up the unread messages its hidden rows would show, even with nothing else to say", () => {
    render([chat(1), chat(2), chat(3)], (chatId) => (chatId === 3 ? 0 : chatId * 2));
    expect(document.querySelector('[role="img"]')?.getAttribute("aria-label"))
      .toBe("6 unread messages");
  });

  it("shows nothing when nothing inside needs a look", () => {
    render([chat(1)], () => 0);
    expect(document.body.textContent).toBe("");
  });
});
