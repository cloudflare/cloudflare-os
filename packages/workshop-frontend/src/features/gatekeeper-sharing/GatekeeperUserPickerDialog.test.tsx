/// <reference lib="es2024.promise" />
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newMessagePortRpcSession, RpcPromise, RpcTarget, type RpcStub } from "capnweb";
import type { AuthenticatedApi, UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import type { GatekeeperUserSelection } from "@gadgets/workshop-shared/gatekeeper";
import GatekeeperUserPickerDialog from "./GatekeeperUserPickerDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({ props: null as unknown }));

vi.mock("../user-directory/UserSearchCombobox", () => ({
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

vi.mock("../../components/WorkshopControls", () => ({
  WorkshopIconButton: ({ children, ...props }: { children?: ReactNode }) =>
    <button type="button" {...props}>{children}</button>,
}));

vi.mock("../../components/PersonAvatar", () => ({ PersonAvatar: () => null }));

type CapturedProps = {
  search(query: string): Promise<UserDirectoryRecord[]>;
  onSelect(user: UserDirectoryRecord): void;
  onValueChange(value: string): void;
  onSubmit(): void;
};

const ALICE: UserDirectoryRecord = { id: "alice@example.com", name: "Alice" };
const BOB: UserDirectoryRecord = { id: "bob@example.com", name: "Bob" };
const CAROL: UserDirectoryRecord = { id: "carol@example.com", name: "Carol" };

type Mint = (vendorId: string, selectedUserId: string) => Promise<GatekeeperUserSelection | null>;
type Deliver = (selection: GatekeeperUserSelection) => Promise<void>;

// What the Workshop mints for a directory record in these tests: a ticket naming the person, and
// the snapshot name the backend read (which may differ from the directory result).
function selectionFor(user: UserDirectoryRecord, displayName = user.name): GatekeeperUserSelection {
  return { ticket: `ticket-${user.id}`, profile: { displayName } };
}

const mintFor: Mint = async (_vendorId, selectedUserId) => {
  const user = [ALICE, BOB, CAROL].find(({ id }) => id === selectedUserId);
  return user ? selectionFor(user) : null;
};

describe("GatekeeperUserPickerDialog", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  const sessions: Disposable[] = [];

  afterEach(async () => {
    await act(async () => root?.unmount());
    for (const session of sessions) session[Symbol.dispose]();
    sessions.length = 0;
    container?.remove();
    captured.props = null;
  });

  async function mount(mint: Mint, deliver: Deliver = async () => {}) {
    const searchUsers = vi.fn<
      (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
    >(async () => [ALICE, BOB, CAROL]);
    const createSelection = vi.fn<
      (vendorId: string, selectedUserId: string) => RpcPromise<GatekeeperUserSelection | null>
    >((vendorId, selectedUserId) => new RpcPromise(mint(vendorId, selectedUserId)));
    const onSelected = vi.fn<Deliver>(deliver);
    const onClose = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <GatekeeperUserPickerDialog
        authenticatedApi={
          { searchUsers, createGatekeeperUserSelection: createSelection } as unknown as RpcStub<AuthenticatedApi>
        }
        gatekeeperId="context"
        onSelected={onSelected}
        onClose={onClose}
        onCancel={onCancel}
      />,
    ));
    return { searchUsers, createSelection, onSelected, onClose, onCancel, props: () => captured.props as CapturedProps };
  }

  const added = () => container!.querySelector('[aria-label="Added people"]')?.textContent ?? "";
  const notice = () => container!.querySelector('p[role="status"]')?.textContent;
  const closeButton = () => container!.querySelector<HTMLButtonElement>('[aria-label="Close person picker"]')!;

  it("mints a ticket for each pick and delivers it to the app before the picker closes", async () => {
    const { searchUsers, createSelection, onSelected, onClose, props } = await mount(
      async (vendorId, selectedUserId) =>
        selectedUserId === BOB.id ? null : await mintFor(vendorId, selectedUserId));

    await expect(props().search("a")).resolves.toEqual([ALICE, BOB, CAROL]);
    expect(searchUsers).toHaveBeenCalledWith("a", []);
    expect(createSelection).not.toHaveBeenCalled();

    await act(async () => props().onSelect(ALICE));
    // The Workshop is asked for a ticket by vendor and directory id alone; the app gets the ticket
    // and snapshot, never the directory record.
    expect(createSelection).toHaveBeenCalledWith("context", ALICE.id);
    expect(onSelected).toHaveBeenCalledWith(selectionFor(ALICE));
    expect(added()).toBe("Alice");
    // Already-added people drop out of later searches, and a repeat pick is ignored.
    await props().search("al");
    expect(searchUsers).toHaveBeenLastCalledWith("al", [ALICE.id]);
    await act(async () => props().onSelect(ALICE));
    expect(createSelection).toHaveBeenCalledTimes(1);

    // A missing or self-selected Workshop person gets no ticket; the app hears nothing about them.
    await act(async () => props().onSelect(BOB));
    expect(notice()).toBeTruthy();
    expect(onSelected).toHaveBeenCalledTimes(1);
    expect(added()).toBe("Alice");
    await props().search("bob");
    expect(searchUsers).toHaveBeenLastCalledWith("bob", [ALICE.id]);

    await act(async () => props().onSelect(CAROL));
    expect(added()).toBe("AliceCarol");
    expect(onSelected).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => closeButton().click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the name the Workshop snapshotted, not the search result's", async () => {
    const { props } = await mount(async () => selectionFor(ALICE, "Alice Renamed"));

    await act(async () => props().onSelect(ALICE));
    expect(added()).toBe("Alice Renamed");
  });

  it("shows the app's own error for a selection it rejected, leaving the person unselected", async () => {
    const { searchUsers, createSelection, props } = await mount(
      mintFor, async () => { throw new Error("Collection not found."); });

    await act(async () => props().onSelect(ALICE));
    expect(notice()).toBe("Alice: Collection not found.");
    expect(added()).toBe("");
    // The person stays selectable: not excluded from search, and a new pick mints a new ticket.
    await props().search("al");
    expect(searchUsers).toHaveBeenLastCalledWith("al", []);
    await act(async () => props().onSelect(ALICE));
    expect(createSelection).toHaveBeenCalledTimes(2);
  });

  it("releases a rejected mint and lets the person be picked again", async () => {
    const { searchUsers, createSelection, onSelected, props } = await mount(
      async () => { throw new Error("Mint failed."); });

    await act(async () => props().onSelect(ALICE));
    expect(notice()).toBe("Alice: Mint failed.");
    expect(onSelected).not.toHaveBeenCalled();
    expect(added()).toBe("");
    await expect(createSelection.mock.results[0].value).rejects.toThrow("disposed");
    await props().search("al");
    expect(searchUsers).toHaveBeenLastCalledWith("al", []);
    await act(async () => props().onSelect(ALICE));
    expect(createSelection).toHaveBeenCalledTimes(2);
  });

  it("mints one ticket for a double click", async () => {
    const minting = Promise.withResolvers<GatekeeperUserSelection | null>();
    const { createSelection, onSelected, props } = await mount(() => minting.promise);

    await act(async () => { props().onSelect(ALICE); props().onSelect(ALICE); });
    expect(createSelection).toHaveBeenCalledTimes(1);
    await act(async () => { minting.resolve(selectionFor(ALICE)); await minting.promise; });
    expect(onSelected).toHaveBeenCalledTimes(1);
    expect(added()).toBe("Alice");
  });

  it("waits for minting and delivery before closing, so the app has every selection", async () => {
    const minting = Promise.withResolvers<GatekeeperUserSelection | null>();
    const delivery = Promise.withResolvers<void>();
    const { createSelection, onSelected, onClose, props } = await mount(
      () => minting.promise, () => delivery.promise);

    await act(async () => props().onSelect(ALICE));
    expect(container!.querySelector('li[role="status"]')?.textContent).toBe("Adding…");
    await act(async () => closeButton().click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { minting.resolve(selectionFor(ALICE)); await minting.promise; });
    expect(onSelected).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    // The mint's handle is already released even though receiver delivery is still pending.
    await expect(createSelection.mock.results[0].value).rejects.toThrow("disposed");

    await act(async () => { delivery.resolve(); await delivery.promise; });
    expect(added()).toBe("Alice");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps concurrent picks distinct when they settle out of order", async () => {
    const deliveries = new Map<string, PromiseWithResolvers<void>>();
    const { onSelected, props } = await mount(mintFor, (selection) => {
      const pending = Promise.withResolvers<void>();
      deliveries.set(selection.ticket, pending);
      return pending.promise;
    });

    await act(async () => { props().onSelect(ALICE); props().onSelect(CAROL); });
    expect(onSelected).toHaveBeenCalledTimes(2);
    expect(container!.querySelectorAll('li[role="status"]')).toHaveLength(2);

    await act(async () => { deliveries.get(selectionFor(CAROL).ticket)!.resolve(); });
    expect(added()).toBe("CarolAdding…");
    await act(async () => { deliveries.get(selectionFor(ALICE).ticket)!.resolve(); });
    expect(added()).toBe("CarolAlice");
  });
  it("selects a trimmed exact identifier and displays the backend snapshot", async () => {
    const { props } = await mount(mintFor);
    await act(async () => props().onValueChange(`  ${ALICE.id}  `));
    await act(async () => props().onSubmit());
    expect(added()).toBe("Alice");
    await act(async () => props().onValueChange("missing@example.com"));
    await act(async () => props().onSubmit());
    expect(notice()).toContain("can no longer be selected");
    expect(added()).toBe("Alice");
  });

  it.each(["cancel", "unmount"] as const)(
    "releases a stalled mint before the backend resolves on %s, without late delivery",
    async (action) => {
      const minting = Promise.withResolvers<GatekeeperUserSelection | null>();
      const started = Promise.withResolvers<void>();
      const backendSettled = vi.fn<(selection: GatekeeperUserSelection | null) => void>();
      void minting.promise.then(backendSettled);

      class StalledMintApi extends RpcTarget implements Pick<AuthenticatedApi, "createGatekeeperUserSelection"> {
        createGatekeeperUserSelection(_vendorId: string, _selectedUserId: string) {
          started.resolve();
          return minting.promise;
        }
      }

      const { port1, port2 } = new MessageChannel();
      const backend = newMessagePortRpcSession(port1, new StalledMintApi());
      const api = newMessagePortRpcSession<StalledMintApi>(port2);
      sessions.push(backend, api);
      const { props, createSelection, onSelected, onClose, onCancel } = await mount(
        (vendorId, selectedUserId) => api.createGatekeeperUserSelection(vendorId, selectedUserId));
      await act(async () => { props().onSelect(ALICE); await started.promise; });
      const rejected = vi.fn<(error: unknown) => void>();
      // Observe the in-flight remote promise before disposal, rather than reusing a disposed stub.
      void createSelection.mock.results[0].value.catch(rejected);

      if (action === "cancel") {
        await act(async () => closeButton().click());
        const stop = Array.from(container!.querySelectorAll("button"))
          .find(button => button.textContent === "Stop waiting and close")!;
        await act(async () => stop.click());
      } else {
        await act(async () => root!.unmount());
        root = undefined;
      }

      expect(onCancel).toHaveBeenCalledTimes(action === "cancel" ? 1 : 0);
      expect(rejected).toHaveBeenCalledOnce();
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
        message: "RPC was canceled because the RpcPromise was disposed.",
      }));
      expect(backendSettled).not.toHaveBeenCalled();
      expect(onSelected).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => { minting.resolve(selectionFor(ALICE)); await minting.promise; });
      expect(onSelected).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(added()).not.toContain("Alice");
    },
  );

  it("bounds concurrent picks at 999 and frees a slot after a failed mint", async () => {
    const minting = Promise.withResolvers<GatekeeperUserSelection | null>();
    const { props, createSelection } = await mount(() => minting.promise);
    await act(async () => {
      for (let index = 0; index < 1000; index++) {
        props().onSelect({ id: `person-${index}`, name: `Person ${index}` });
      }
    });
    expect(createSelection).toHaveBeenCalledTimes(999);
    expect(container!.querySelectorAll('li[role="status"]')).toHaveLength(999);
    expect(container!.textContent).toContain("Close and reopen the picker to continue");
    await act(async () => { minting.resolve(null); await minting.promise; });
    await act(async () => props().onSelect(ALICE));
    expect(createSelection).toHaveBeenLastCalledWith("context", ALICE.id);
    expect(createSelection).toHaveBeenCalledTimes(1000);
  });

});
