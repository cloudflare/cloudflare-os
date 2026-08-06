// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  Overseer, SlashCommandChoice,
} from "@gadgets/workshop-shared/api";
import { useSlashCommandPicker } from "./SlashCommandPicker";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom implements no layout, so it ships no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};

const choices: SlashCommandChoice[] = [{
  selection: {gatekeeperId: 1, commandId: "deploy"},
  name: "deploy",
  description: "Deploy the current project.",
  providerLabel: "Context",
}, {
  selection: {gatekeeperId: 1, commandId: "debug"},
  name: "debug",
  description: "Debug an issue.",
  providerLabel: "Context",
}];

const compact: SlashCommandChoice = {
  selection: {builtin: true, commandId: "compact"},
  name: "compact",
  description: "Summarize older context while preserving recent messages.",
  providerLabel: "Workshop",
};

function pickerOverseer(result: SlashCommandChoice[]) {
  return {
    listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => result),
  } as unknown as RpcStub<Overseer>;
}

function Harness({
  inputValue,
  cursorPosition = inputValue.length,
  getOverseer,
  onSelect,
  chatExists = true,
}: {
  inputValue: string;
  cursorPosition?: number;
  getOverseer: () => RpcStub<Overseer>;
  onSelect: (choice: SlashCommandChoice, tokenStart: number, tokenEnd: number) => void;
  chatExists?: boolean;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const picker = useSlashCommandPicker({
    inputValue,
    cursorPosition,
    selectedCommand: null,
    disabled: false,
    anchorRef,
    getOverseer,
    onSelect,
    chatExists,
  });
  return <>
    <div ref={(element) => {
      anchorRef.current = element;
      if (element) {
        element.getBoundingClientRect = () => ({
          top: 500,
          bottom: 540,
          left: 100,
          right: 500,
          width: 400,
          height: 40,
          x: 100,
          y: 500,
          toJSON: () => ({}),
        });
      }
    }} />
    <div data-testid="active-command">{picker.activeChoice?.selection.commandId}</div>
    <button
      type="button"
      data-testid="choose-second"
      aria-label="Choose second command"
      onClick={() => picker.setIndex(1)}
    />
    {picker.popup}
  </>;
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 20; i++) {
    if (check()) return;
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  }
  expect(check()).toBe(true);
}

describe("SlashCommandPicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
  });

  it("loads once, filters locally, positions above, and dismisses outside", async () => {
    Object.defineProperty(window, "innerHeight", {value: 600, configurable: true});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let overseer = pickerOverseer(choices);
    let getOverseer = () => overseer;

    await act(async () => root.render(
      <Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 2);
    expect(overseer.listSlashCommands).toHaveBeenCalledTimes(1);

    let listbox = document.querySelector('[role="listbox"]')!;
    let popup = listbox.closest("div.fixed") as HTMLElement;
    expect(popup.style.bottom).not.toBe("");
    expect(popup.style.top).toBe("");

    await act(async () => root.render(
      <Harness inputValue="/dep" getOverseer={getOverseer} onSelect={() => {}} />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 1);
    expect(overseer.listSlashCommands).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("/deploy");

    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", {bubbles: true}));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => root.render(
      <Harness inputValue="hello" getOverseer={getOverseer} onSelect={() => {}} />,
    ));
    await act(async () => root.render(
      <Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 2);
    expect(overseer.listSlashCommands).toHaveBeenCalledTimes(1);
  });

  it("reopens for another token after dismissing without changing the message", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let overseer = pickerOverseer(choices);
    const inputValue = "try /dep or /deb";

    await act(async () => root.render(
      <Harness
        inputValue={inputValue}
        cursorPosition={inputValue.indexOf("dep") + 2}
        getOverseer={() => overseer}
        onSelect={() => {}}
      />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 1);

    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", {bubbles: true}));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await act(async () => root.render(
      <Harness
        inputValue={inputValue}
        cursorPosition={inputValue.indexOf("deb") + 2}
        getOverseer={() => overseer}
        onSelect={() => {}}
      />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 1);
    expect(document.body.textContent).toContain("/debug");
  });

  it("selects a unique exact command when trailing message text starts", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let onSelect = vi.fn<(
      choice: SlashCommandChoice, tokenStart: number, tokenEnd: number,
    ) => void>();
    let getOverseer = () => pickerOverseer(choices);

    await act(async () => root.render(
      <Harness
        inputValue="/deploy production"
        cursorPosition={8}
        getOverseer={getOverseer}
        onSelect={onSelect}
      />,
    ));
    await waitFor(() => onSelect.mock.calls.length === 1);
    expect(onSelect).toHaveBeenCalledWith(choices[0], 0, 7);
  });

  it("does not default an ambiguous exact command", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let duplicates = [{...choices[0]}, {...choices[1], name: "deploy"}];
    let getOverseer = () => pickerOverseer(duplicates);

    await act(async () => root.render(
      <Harness inputValue="/deploy" getOverseer={getOverseer} onSelect={() => {}} />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 2);
    expect(document.querySelector('[data-testid="active-command"]')?.textContent).toBe("");
    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);

    let chooseSecond = document.querySelector<HTMLButtonElement>('[data-testid="choose-second"]');
    if (!chooseSecond) throw new Error("Missing test selection control");
    await act(async () => chooseSecond.click());
    expect(document.querySelector('[data-testid="active-command"]')?.textContent).toBe("debug");
    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(1);
  });

  it("offers a built-in command only once the chat exists", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let getOverseer = () => pickerOverseer([compact, ...choices]);

    await act(async () => root.render(
      <Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} chatExists={false} />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 2);
    expect([...document.querySelectorAll('[role="option"]')].map(o => o.textContent))
        .not.toContain(expect.stringContaining("compact"));

    await act(async () => root.render(
      <Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} chatExists={true} />,
    ));
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 3);
  });

  // An exact `/compact` must not resolve either, or the filtered command would still be sent.
  it("does not resolve a built-in command typed in full without a chat", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    let onSelect = vi.fn<(choice: SlashCommandChoice, tailStart: number) => void>();

    await act(async () => root.render(
      <Harness inputValue="/compact now" getOverseer={() => pickerOverseer([compact])}
               onSelect={onSelect} chatExists={false} />,
    ));
    await act(async () => { await Promise.resolve(); });
    expect(onSelect).not.toHaveBeenCalled();
  });

});
