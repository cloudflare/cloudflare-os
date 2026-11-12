// The Google Chat Account configurator in a stand-in for the sandbox runtime: what it shows when the
// account's grant no longer covers starting conversations, though the Workshop lists it as granted,
// and what it asks Workshop for.

import { afterEach, expect, it, vi } from "vitest";
import { nodes, text } from "./configurator-tree";

vi.mock("@gadgets/configurator-ui", () => ({
  h: (component: unknown, props: unknown, ...children: unknown[]) => ({
    component, props: props ?? {}, children,
  }),
  Field: "Field",
  Notice: "Notice",
  RadioCards: "RadioCards",
  Section: "Section",
}));

afterEach(() => {
  vi.useRealTimers();
});

/** A fresh module, since it keeps what the grant check found at module level, and its frame. */
async function open(covered: boolean[]) {
  vi.resetModules();
  const spec = (await import("../src/configurator/chat-account-configurator-ui")).default as unknown as {
    initial: Record<string, unknown>;
    isReady(context: unknown): boolean;
    render(context: unknown): unknown;
  };
  let values = { ...spec.initial };
  let renders = 0;
  const ui = { canStartConversations: vi.fn(async () => covered.shift() ?? true) };
  const ensureResources = vi.fn(async (_patterns: string[]) => false);
  const notices = () => nodes(spec.render({
    values,
    setValues: (patch: Record<string, unknown>) => { values = { ...values, ...patch }; renders++; },
    clearFields: () => {},
    ensureResources,
    ui,
  })).filter(node => node.component === "Notice");
  return {
    ui, ensureResources, renders: () => renders,
    ready: () => spec.isReady({ values }),
    notices: () => notices().map(node => ({ tone: node.props.tone, text: text(node), action: node.props.action?.label })),
    allow: () => notices().find(node => node.props.action?.label === "Allow access")?.props.action.onClick(),
  };
}

it("shows nothing for an account whose grant covers starting conversations", async () => {
  const frame = await open([true]);
  expect(frame.notices()).toEqual([]);
  await vi.waitFor(() => expect(frame.renders()).toBe(1));

  expect(frame.notices()).toEqual([]);
  expect(frame.ui.canStartConversations).toHaveBeenCalledOnce();
});

it("offers to allow access for an account whose grant no longer covers starting conversations", async () => {
  vi.useFakeTimers();
  // Not yet when the pop-up opens, then once Google's consent lands.
  const frame = await open([false, false, true]);
  frame.notices();
  await vi.waitFor(() => expect(frame.renders()).toBe(1));

  expect(frame.notices()).toEqual([{
    tone: undefined, text: expect.stringContaining("can't start new conversations"), action: "Allow access",
  }]);
  // Reading and posting still work, so it can be connected as it is.
  expect(frame.ready()).toBe(true);

  const allowed = frame.allow();
  await vi.waitFor(() => expect(frame.notices()).toEqual([
    { tone: undefined, text: "Allow access in Google's window.", action: undefined },
  ]));
  expect(frame.ensureResources).toHaveBeenCalledExactlyOnceWith(["https://chat.google.com/"]);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await allowed;

  expect(frame.notices()).toEqual([]);
});

it("shows nothing once Workshop finds the account already holds the grant", async () => {
  const frame = await open([false]);
  frame.notices();
  await vi.waitFor(() => expect(frame.renders()).toBe(1));
  frame.ensureResources.mockResolvedValueOnce(true);

  await frame.allow();

  expect(frame.notices()).toEqual([]);
});

it("says why access wasn't allowed, and offers to ask again", async () => {
  const frame = await open([false]);
  frame.notices();
  await vi.waitFor(() => expect(frame.renders()).toBe(1));
  frame.ensureResources.mockRejectedValueOnce(new Error("The pop-up was closed."));

  await frame.allow();

  expect(frame.notices()).toEqual([{ tone: "error", text: "The pop-up was closed.", action: "Allow access" }]);
});
