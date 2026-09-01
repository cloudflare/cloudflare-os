// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { invalidateSlashCommandCatalog } from "../../../components/chat/slash-command-catalog";
import ComposerAddMenu from "./ComposerAddMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

const connectedSkill: SlashCommandChoice = {
  selection: { gatekeeperId: 1, commandId: "review" },
  name: "Review   writing",
  description: "Review and improve a draft.",
  providerLabel: "Writing tools",
};
const builtinSkill: SlashCommandChoice = {
  selection: { builtin: true, commandId: "compact" },
  name: "compact",
  description: "Compact this chat.",
  providerLabel: "Gadgets",
};

const Harness = ({
  catalogVersion = 0,
  chatExists = true,
  getOverseer,
  onAddConnection = () => {},
  onSelectSkill,
  onUpload = () => {},
  skillDisabledReason,
  skillSelected = false,
}: {
  catalogVersion?: number;
  chatExists?: boolean;
  getOverseer: () => RpcStub<Overseer>;
  onAddConnection?: () => void;
  onSelectSkill: (choice: SlashCommandChoice) => void;
  onUpload?: () => void;
  skillDisabledReason?: string;
  skillSelected?: boolean;
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div
        ref={(element) => {
          anchorRef.current = element;
          if (element) element.getBoundingClientRect = () => ({
            top: 500,
            bottom: 600,
            left: 100,
            right: 600,
            width: 500,
            height: 100,
            x: 100,
            y: 500,
            toJSON: () => ({}),
          });
        }}
      />
      <ComposerAddMenu
        anchorRef={anchorRef}
        catalogVersion={catalogVersion}
        chatExists={chatExists}
        getOverseer={getOverseer}
        skillDisabledReason={skillDisabledReason}
        skillSelected={skillSelected}
        onAddConnection={onAddConnection}
        onSelectSkill={onSelectSkill}
        onUpload={onUpload}
      />
    </>
  );
};

async function waitFor(check: () => boolean) {
  await act(async () => vi.waitFor(() => expect(check()).toBe(true)));
}

describe("ComposerAddMenu", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.querySelector('[role="dialog"]')?.remove();
  });

  const mount = async (element: ReactNode) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(element));
    return container;
  };

  it("browses and whitespace-normalizes skill search while filtering built-ins", async () => {
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(
      async () => [connectedSkill, builtinSkill],
    );
    const getOverseer = () => ({ listSlashCommands } as unknown as RpcStub<Overseer>);
    const host = await mount(
      <Harness chatExists={false} getOverseer={getOverseer} onSelectSkill={() => {}} />,
    );
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 3);
    expect(document.body.textContent).not.toContain("Compact this chat");

    const search = document.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        " review writing ",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 1);
    expect(document.body.textContent).toContain("Review   writing");
  });

  it("does not load unavailable skills and clearly gates incompatible actions", async () => {
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(
      async () => [connectedSkill],
    );
    const getOverseer = () => ({ listSlashCommands } as unknown as RpcStub<Overseer>);
    const host = await mount(
      <Harness
        getOverseer={getOverseer}
        onSelectSkill={() => {}}
        skillDisabledReason="Remove resources and attachments to add a skill."
      />,
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(async () => trigger.click());
    expect(document.body.textContent).toContain("Remove resources and attachments");
    expect(document.querySelector('[aria-label="Search skills"]')).toBeNull();
    expect(listSlashCommands).not.toHaveBeenCalled();

    await act(async () => trigger.click());
    await act(async () => root!.render(
      <Harness getOverseer={getOverseer} onSelectSkill={() => {}} skillSelected />,
    ));
    await act(async () => trigger.click());
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(options).toHaveLength(2);
    expect(options.every((option) => option.disabled)).toBe(true);
    expect(document.body.textContent).toContain("Remove the selected skill");
    expect(listSlashCommands).not.toHaveBeenCalled();
  });

  it("uses Enter for activation, leaves Tab inert, and restores focus on Escape", async () => {
    const getOverseer = () => ({
      listSlashCommands: async () => [connectedSkill],
    } as unknown as RpcStub<Overseer>);
    const onUpload = vi.fn<() => void>();
    const onSelectSkill = vi.fn<(choice: SlashCommandChoice) => void>();
    const host = await mount(
      <Harness getOverseer={getOverseer} onSelectSkill={onSelectSkill} onUpload={onUpload} />,
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(async () => trigger.click());
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 3);
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!;
    await act(async () => search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    ));
    expect(onUpload).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => trigger.click());
    await waitFor(() => document.querySelectorAll('[role="option"]').length === 3);
    const reopened = document.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!;
    await act(async () => reopened.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    ));
    await act(async () => reopened.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ));
    expect(onSelectSkill).toHaveBeenCalledWith(connectedSkill);

    await act(async () => trigger.click());
    await waitFor(() => document.querySelector('[role="dialog"]') !== null);
    const finalSearch = document.querySelector<HTMLInputElement>('[aria-label="Search skills"]')!;
    await act(async () => {
      finalSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("refetches the catalog after a connection invalidates it", async () => {
    let catalog = [connectedSkill];
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => catalog);
    const getOverseer = () => ({ listSlashCommands } as unknown as RpcStub<Overseer>);
    const host = await mount(
      <Harness getOverseer={getOverseer} onSelectSkill={() => {}} />,
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
    await act(async () => trigger.click());
    await waitFor(() => document.body.textContent?.includes("Review   writing") === true);
    await act(async () => trigger.click());

    catalog = [{ ...connectedSkill, name: "New connection skill" }];
    invalidateSlashCommandCatalog(getOverseer);
    await act(async () => root!.render(
      <Harness catalogVersion={1} getOverseer={getOverseer} onSelectSkill={() => {}} />,
    ));
    await act(async () => trigger.click());
    await waitFor(() => document.body.textContent?.includes("New connection skill") === true);
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });
});
