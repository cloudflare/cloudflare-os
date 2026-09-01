// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { useSlashCommandPicker } from "./SlashCommandPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

const choices: SlashCommandChoice[] = [{
  selection: { gatekeeperId: 1, commandId: "deploy" },
  name: "deploy",
  description: "Deploy the current project.",
  providerLabel: "Context",
}, {
  selection: { gatekeeperId: 1, commandId: "debug" },
  name: "debug",
  description: "Debug an issue.",
  providerLabel: "Context",
}];

const compact: SlashCommandChoice = {
  selection: { builtin: true, commandId: "compact" },
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
      if (element) element.getBoundingClientRect = () => ({
        top: 500, bottom: 540, left: 100, right: 500, width: 400, height: 40,
        x: 100, y: 500, toJSON: () => ({}),
      });
    }} />
    <div data-testid="active-command">{picker.activeChoice?.selection.commandId}</div>
    <button type="button" data-testid="choose-second" aria-label="Choose second skill"
            onClick={() => picker.setIndex(1)} />
    <button type="button" data-testid="invalidate-catalog" aria-label="Invalidate skills"
            onClick={picker.invalidateCatalog} />
    {picker.popup}
  </>;
}

describe("SlashCommandPicker", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  const render = async (element: ReactNode) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(element));
  };

  it("shows the rounded skill-row presentation and filters a single catalog load", async () => {
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    const overseer = pickerOverseer(choices);
    const getOverseer = () => overseer;
    await render(<Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} />);
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(2)));

    const popup = document.querySelector('[role="listbox"]')!.closest("div.fixed") as HTMLElement;
    expect(popup.className).toContain("rounded-2xl");
    expect(popup.textContent).not.toContain("Commands");
    expect(document.querySelector('[role="option"]')?.textContent)
      .toContain("deployDeploy the current project.");
    expect(popup.style.bottom).not.toBe("");

    await act(async () => root!.render(
      <Harness inputValue="/dep" getOverseer={getOverseer} onSelect={() => {}} />,
    ));
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(1)));
    expect(overseer.listSlashCommands).toHaveBeenCalledTimes(1);
  });

  it("does not select a unique exact command without explicit confirmation", async () => {
    const onSelect = vi.fn<(
      choice: SlashCommandChoice, tokenStart: number, tokenEnd: number,
    ) => void>();
    await render(
      <Harness inputValue="/deploy production" cursorPosition={8}
               getOverseer={() => pickerOverseer(choices)} onSelect={onSelect} />,
    );
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(1)));
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="active-command"]')?.textContent).toBe("deploy");
  });

  it("does not default an ambiguous exact command", async () => {
    const duplicates = [{ ...choices[0] }, { ...choices[1], name: "deploy" }];
    await render(
      <Harness inputValue="/deploy" getOverseer={() => pickerOverseer(duplicates)}
               onSelect={() => {}} />,
    );
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(2)));
    expect(document.querySelector('[data-testid="active-command"]')?.textContent).toBe("");
    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="choose-second"]')!.click();
    });
    expect(document.querySelector('[data-testid="active-command"]')?.textContent).toBe("debug");
  });

  it("does not open for escaped double slash", async () => {
    const overseer = pickerOverseer(choices);
    await render(
      <Harness inputValue="//deploy" getOverseer={() => overseer} onSelect={() => {}} />,
    );
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(overseer.listSlashCommands).not.toHaveBeenCalled();
  });

  it("offers built-in commands only after the chat exists", async () => {
    const overseer = pickerOverseer([compact, ...choices]);
    const getOverseer = () => overseer;
    await render(
      <Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} chatExists={false} />,
    );
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(2)));
    expect(document.body.textContent).not.toContain("compact");

    await act(async () => root!.render(
      <Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} chatExists />,
    ));
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(3)));
  });

  it("rejects stale catalog results after invalidation", async () => {
    let resolveFirst!: (result: SlashCommandChoice[]) => void;
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(() => {
      if (listSlashCommands.mock.calls.length === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve([choices[1]]);
    });
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    const getOverseer = () => overseer;
    await render(<Harness inputValue="/" getOverseer={getOverseer} onSelect={() => {}} />);
    await act(async () => vi.waitFor(() => expect(listSlashCommands).toHaveBeenCalledOnce()));

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="invalidate-catalog"]')!.click();
    });
    await act(async () => vi.waitFor(() => expect(listSlashCommands).toHaveBeenCalledTimes(2)));
    await act(async () => vi.waitFor(() => expect(document.body.textContent).toContain("Debug an issue.")));

    await act(async () => resolveFirst([choices[0]]));
    expect(document.body.textContent).toContain("Debug an issue.");
    expect(document.body.textContent).not.toContain("Deploy the current project.");
  });
});
