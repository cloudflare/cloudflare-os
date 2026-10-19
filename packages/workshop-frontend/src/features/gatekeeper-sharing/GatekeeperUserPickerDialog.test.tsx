/// <reference lib="es2024.promise" />
// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newMessagePortRpcSession, RpcPromise, RpcTarget, type RpcStub } from "capnweb";
import type { AuthenticatedApi, ServerConfig, UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import type { GatekeeperUserSelection } from "@gadgets/workshop-shared/gatekeeper";
import type * as Kumo from '@cloudflare/kumo';
import type * as UserSearch from "../user-directory/UserSearchCombobox";
import { ServerConfigContext } from "../../ServerConfigContext";
import GatekeeperUserPickerDialog from "./GatekeeperUserPickerDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captured = vi.hoisted(() => ({ props: null as unknown }));

vi.mock("../user-directory/UserSearchCombobox", async (importOriginal) => {
  const { UserSearchCombobox } = await importOriginal<typeof UserSearch>();
  return {
    UserSearchCombobox: (props: ComponentProps<typeof UserSearchCombobox>) => {
      captured.props = props;
      return <UserSearchCombobox {...props} />;
    },
  };
});

vi.mock("@cloudflare/kumo", async (importOriginal) => {
  const Part = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Dialog = Object.assign(Part, { Root: Part, Title: Part, Description: Part });
  const { Button } = await importOriginal<typeof Kumo>();
  return { Dialog, Button };
});

vi.mock("../../components/WorkshopControls", () => ({
  WorkshopIconButton: ({ children, ...props }: { children?: ReactNode }) =>
    <button type="button" {...props}>{children}</button>,
}));

vi.mock("../../components/PersonAvatar", () => ({ PersonAvatar: () => null }));

type CapturedProps = {
  search(query: string): RpcPromise<UserDirectoryRecord[]>;
  onSelect(user: UserDirectoryRecord): void;
  onValueChange(value: string): void;
  onSubmit(): void;
};

const ALICE: UserDirectoryRecord = { id: "alice@example.com", name: "Alice" };
const BOB: UserDirectoryRecord = { id: "bob@example.com", name: "Bob" };
const CAROL: UserDirectoryRecord = { id: "carol@example.com", name: "Carol" };

type Mint = (vendorId: string, selectedUserId: string) => Promise<GatekeeperUserSelection | null>;
type SearchUsers = (query: string, excludeIds: string[]) => RpcPromise<UserDirectoryRecord[]>;
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
    vi.useRealTimers();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  async function mount(
    mint: Mint,
    deliver: Deliver = async () => {},
    { searchEnabled = false, searchUsers: search = () => new RpcPromise(Promise.resolve([ALICE, BOB, CAROL])) }:
      { searchEnabled?: boolean; searchUsers?: SearchUsers } = {},
  ) {
    const searchUsers = vi.fn<SearchUsers>(search);
    const createSelection = vi.fn<
      (vendorId: string, selectedUserId: string) => RpcPromise<GatekeeperUserSelection | null>
    >((vendorId, selectedUserId) => new RpcPromise(mint(vendorId, selectedUserId)));
    const onSelected = vi.fn<Deliver>(deliver);
    const onClose = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();

    if (searchEnabled) {
      // The real combobox debounces searches and scrolls its active option into view.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => {} });
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={{ userSearchEnabled: searchEnabled } as ServerConfig}>
        <GatekeeperUserPickerDialog
          authenticatedApi={
            { searchUsers, createGatekeeperUserSelection: createSelection } as unknown as RpcStub<AuthenticatedApi>
          }
          gatekeeperId="context"
          onSelected={onSelected}
          onClose={onClose}
          onCancel={onCancel}
        />
      </ServerConfigContext.Provider>,
    ));
    return { searchUsers, createSelection, onSelected, onClose, onCancel, props: () => captured.props as CapturedProps };
  }

  async function searchFor(query: string) {
    await act(async () => (captured.props as CapturedProps).onValueChange(query));
    await act(async () => vi.advanceTimersByTimeAsync(200));
  }

  const added = () => container!.querySelector('[aria-label="Added people"]')?.textContent ?? "";
  const notice = () => container!.querySelector('p[role="status"]:not([aria-live])')?.textContent;
  const announcement = () => container!.querySelector('[role="status"][aria-live="polite"]')?.textContent;
  const options = () => Array.from(container!.querySelectorAll<HTMLElement>('[role="option"]'));

  const closeButton = () => container!.querySelector<HTMLButtonElement>('[aria-label="Close person picker"]')!;
  const doneButton = () => Array.from(container!.querySelectorAll('button'))
    .find(button => button.textContent === 'Done')!;

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

    await act(async () => doneButton().click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows and announces the name the Workshop snapshotted, not the search result's", async () => {
    const { props } = await mount(async () => selectionFor(ALICE, "Alice Renamed"));
    expect(announcement()).toBe("");

    await act(async () => props().onSelect(ALICE));
    expect(added()).toBe("Alice Renamed");
    expect(announcement()).toBe("Added Alice Renamed");
  });

  it("keeps the current search when a pick settles, hiding picked people from its results", async () => {
    const delivery = Promise.withResolvers<void>();
    // The directory double ignores exclusions, so anything hidden here is hidden by the picker.
    const { searchUsers, props } = await mount(mintFor, () => delivery.promise, { searchEnabled: true });
    const shown = () => options().map(option => option.textContent);

    await act(async () => props().onSelect(ALICE));
    await searchFor("a");
    expect(searchUsers).toHaveBeenCalledExactlyOnceWith("a", [ALICE.id]);
    expect(shown()).toEqual([`${BOB.name}${BOB.id}`, `${CAROL.name}${CAROL.id}`]);

    await act(async () => { delivery.resolve(); await delivery.promise; });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(added()).toBe("Alice");
    expect(searchUsers).toHaveBeenCalledOnce();
    expect(shown()).toEqual([`${BOB.name}${BOB.id}`, `${CAROL.name}${CAROL.id}`]);

    await act(async () => options()[0].click());
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(added()).toBe("AliceBob");
    expect(searchUsers).toHaveBeenCalledOnce();
    await searchFor("a");
    expect(searchUsers).toHaveBeenLastCalledWith("a", [ALICE.id, BOB.id]);
    expect(shown()).toEqual([`${CAROL.name}${CAROL.id}`]);
  });

  it("refreshes a search that excluded a pending person when their delivery fails", async () => {
    const delivery = Promise.withResolvers<void>();
    const { searchUsers, createSelection, props } = await mount(mintFor, () => delivery.promise, {
      searchEnabled: true,
      searchUsers: (_query, excludeIds) => new RpcPromise(Promise.resolve(
        [ALICE].filter(user => !excludeIds.includes(user.id)),
      )),
    });

    await act(async () => props().onSelect(ALICE));
    await searchFor("alice");
    expect(options()).toEqual([]);
    expect(searchUsers).toHaveBeenCalledExactlyOnceWith("alice", [ALICE.id]);

    await act(async () => delivery.reject(new Error("Try again.")));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(notice()).toBe("Alice: Try again.");
    expect(searchUsers).toHaveBeenLastCalledWith("alice", []);
    expect(options().map(option => option.textContent)).toEqual([`${ALICE.name}${ALICE.id}`]);

    await act(async () => options()[0].click());
    expect(createSelection).toHaveBeenCalledTimes(2);
  });

  it("shows the app's own error for a selection it rejected, leaving the person unselected", async () => {
    const { searchUsers, createSelection, props } = await mount(
      mintFor, async () => { throw new Error("Collection not found."); });

    await act(async () => props().onSelect(ALICE));
    expect(notice()).toBe("Alice: Collection not found.");
    expect(added()).toBe("");
    expect(announcement()).toBe("");
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

  it("waits for minting and delivery when Done is clicked, so the app has every selection", async () => {
    const minting = Promise.withResolvers<GatekeeperUserSelection | null>();
    const delivery = Promise.withResolvers<void>();
    const { createSelection, onSelected, onClose, props } = await mount(
      () => minting.promise, () => delivery.promise);

    await act(async () => props().onSelect(ALICE));
    expect(container!.querySelector('li[role="status"]')?.textContent).toBe("Adding…");
    await act(async () => doneButton().click());
    expect(doneButton().disabled).toBe(true);
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

  it.each(["missing person", "mint rejection", "delivery rejection"] as const)(
    "keeps a %s visible after Done and allows retry before an explicit close",
    async (failure) => {
      const minting = Promise.withResolvers<GatekeeperUserSelection | null>();
      const delivery = Promise.withResolvers<void>();
      let attempts = 0;
      const { onClose, props } = await mount(
        () => ++attempts === 1 ? minting.promise : Promise.resolve(selectionFor(ALICE)),
        () => attempts === 1 ? delivery.promise : Promise.resolve(),
      );
      await act(async () => props().onSelect(ALICE));
      await act(async () => doneButton().click());
      expect(doneButton().disabled).toBe(true);

      await act(async () => {
        if (failure === "missing person") minting.resolve(null);
        else if (failure === "mint rejection") minting.reject(new Error("Mint unavailable."));
        else minting.resolve(selectionFor(ALICE));
      });
      if (failure === "delivery rejection") {
        await act(async () => delivery.reject(new Error("Collection access refused.")));
      }
      expect(onClose).not.toHaveBeenCalled();
      expect(notice()).toContain(ALICE.name);
      expect(added()).toBe("");
      expect(doneButton().disabled).toBe(false);
      expect(container!.querySelector('input')!.disabled).toBe(false);

      await act(async () => props().onSelect(ALICE));
      expect(added()).toBe(ALICE.name);
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => doneButton().click());
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

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

  it.each(["supersede", "unmount"] as const)(
    "releases a stalled directory search before the backend resolves on %s, without late results",
    async (action) => {
      const searching = Promise.withResolvers<UserDirectoryRecord[]>();
      const started = Promise.withResolvers<void>();

      class StalledSearchApi extends RpcTarget implements Pick<AuthenticatedApi, "searchUsers"> {
        searchUsers(_query: string, _excludeIds: string[]) {
          started.resolve();
          return searching.promise;
        }
      }

      const { port1, port2 } = new MessageChannel();
      const backend = newMessagePortRpcSession(port1, new StalledSearchApi());
      const api = newMessagePortRpcSession<StalledSearchApi>(port2);
      sessions.push(backend, api);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { searchUsers } = await mount(mintFor, undefined, {
        searchEnabled: true,
        searchUsers: (query, excludeIds) => api.searchUsers(query, excludeIds),
      });
      await searchFor("ada");
      await act(async () => started.promise);
      const rejected = vi.fn<(error: unknown) => void>();
      // Observe the in-flight remote promise before disposal, rather than reusing a disposed stub.
      void searchUsers.mock.results[0].value.catch(rejected);

      if (action === "supersede") {
        await act(async () => (captured.props as CapturedProps).onValueChange("adb"));
      } else {
        await act(async () => root!.unmount());
        root = undefined;
      }

      expect(rejected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        message: "RPC was canceled because the RpcPromise was disposed.",
      }));
      await act(async () => { searching.resolve([ALICE]); await searching.promise; });
      expect(options()).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
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
