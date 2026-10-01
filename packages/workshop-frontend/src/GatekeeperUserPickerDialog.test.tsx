// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import GatekeeperUserPickerDialog from "./GatekeeperUserPickerDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({ props: null as unknown }));

vi.mock("./UserSearchCombobox", () => ({
  UserSearchCombobox: (props: unknown) => {
    captured.props = props;
    return null;
  },
}));

vi.mock("@cloudflare/kumo", () => {
  const Part = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Dialog = Object.assign(Part, { Root: Part, Title: Part, Description: Part });
  return { Dialog };
});

vi.mock("./components/WorkshopControls", () => ({
  WorkshopIconButton: ({ children, ...props }: { children?: ReactNode }) =>
    <button type="button" {...props}>{children}</button>,
}));

vi.mock("./components/PersonAvatar", () => ({ PersonAvatar: () => null }));

type CapturedProps = {
  search(query: string): Promise<UserDirectoryRecord[]>;
  onSelect(user: UserDirectoryRecord): void;
};

const ALICE: UserDirectoryRecord = { id: "alice@example.com", name: "Alice" };
const BOB: UserDirectoryRecord = { id: "bob@example.com", name: "Bob" };
const CAROL: UserDirectoryRecord = { id: "carol@example.com", name: "Carol" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("GatekeeperUserPickerDialog", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    captured.props = null;
  });

  async function mount(
    selectGatekeeperUser: (
      vendorId: string, selectedUserId: string, target: string,
    ) => Promise<boolean>,
  ) {
    const searchUsers = vi.fn<
      (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
    >(async () => [ALICE, BOB, CAROL]);
    const pick = vi.fn(selectGatekeeperUser);
    const onClose = vi.fn<() => void>();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <GatekeeperUserPickerDialog
        authenticatedApi={
          { searchUsers, selectGatekeeperUser: pick } as unknown as RpcStub<AuthenticatedApi>
        }
        gatekeeperId="context"
        target="collection-1"
        onClose={onClose}
      />,
    ));
    return { searchUsers, pick, onClose, props: () => captured.props as CapturedProps };
  }

  const added = () => container!.querySelector('[aria-label="Added people"]')?.textContent ?? "";
  const notice = () => container!.querySelector('p[role="status"]')?.textContent;
  const closeButton = () => container!.querySelector<HTMLButtonElement>('[aria-label="Close person picker"]')!;

  it("delivers each pick to the gatekeeper immediately and reports the ineligible ones", async () => {
    const { searchUsers, pick, onClose, props } = await mount(
      async (_vendorId, selectedUserId) => selectedUserId !== BOB.id);

    await expect(props().search("a")).resolves.toEqual([ALICE, BOB, CAROL]);
    expect(searchUsers).toHaveBeenCalledWith("a", []);
    expect(pick).not.toHaveBeenCalled();

    await act(async () => props().onSelect(ALICE));
    expect(pick).toHaveBeenCalledWith("context", ALICE.id, "collection-1");
    expect(added()).toBe("Alice");
    // Already-added people drop out of later searches, and a repeat pick is ignored.
    await props().search("al");
    expect(searchUsers).toHaveBeenLastCalledWith("al", [ALICE.id]);
    await act(async () => props().onSelect(ALICE));
    expect(pick).toHaveBeenCalledTimes(1);

    await act(async () => props().onSelect(BOB));
    expect(notice()).toBe("Bob doesn't have an account with this service.");
    expect(added()).toBe("Alice");

    await act(async () => props().onSelect(CAROL));
    expect(added()).toBe("AliceCarol");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => closeButton().click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the gatekeeper's own error message for a failed pick", async () => {
    const { props } = await mount(async () => { throw new Error("Collection not found."); });

    await act(async () => props().onSelect(ALICE));
    expect(notice()).toBe("Alice: Collection not found.");
    expect(added()).toBe("");
  });

  it("waits for an in-flight pick before closing, so the app's refresh sees it", async () => {
    const delivery = deferred<boolean>();
    const { onClose, props } = await mount(() => delivery.promise);

    await act(async () => props().onSelect(ALICE));
    expect(container!.querySelector('li[role="status"]')?.textContent).toBe("Adding…");
    await act(async () => closeButton().click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { delivery.resolve(true); await delivery.promise; });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
