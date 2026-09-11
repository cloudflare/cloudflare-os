// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import type { GatekeeperUserPickerSelection } from "@gadgets/workshop-shared/gatekeeper";
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
  WorkshopButton: ({ children, ...props }: { children?: ReactNode }) =>
    <button type="button" {...props}>{children}</button>,
}));

vi.mock("./components/PersonAvatar", () => ({ PersonAvatar: () => null }));

type CapturedProps = {
  search(query: string): Promise<UserDirectoryRecord[]>;
  onSelect(user: UserDirectoryRecord): void;
};

type FakeSelection = GatekeeperUserPickerSelection & {
  verifier: { [Symbol.dispose]: Mock<() => void> };
  profile: { [Symbol.dispose]: Mock<() => void> };
};

function fakeSelection(): FakeSelection {
  return {
    verifier: { [Symbol.dispose]: vi.fn<() => void>() },
    profile: { [Symbol.dispose]: vi.fn<() => void>() },
  } as unknown as FakeSelection;
}

const ALICE: UserDirectoryRecord = { id: "alice@example.com", name: "Alice" };
const BOB: UserDirectoryRecord = { id: "bob@example.com", name: "Bob" };
const CAROL: UserDirectoryRecord = { id: "carol@example.com", name: "Carol" };

describe("GatekeeperUserPickerDialog", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    captured.props = null;
  });

  async function mount(selections: Record<string, FakeSelection>) {
    const searchUsers = vi.fn<
      (query: string, excludeIds: string[]) => Promise<UserDirectoryRecord[]>
    >(async () => [ALICE, BOB, CAROL]);
    const selectGatekeeperUser = vi.fn<
      (gatekeeperId: string, userId: string) => Promise<GatekeeperUserPickerSelection | null>
    >(async (_gatekeeperId, userId) => selections[userId] ?? null);
    const onComplete = vi.fn<(value: GatekeeperUserPickerSelection[]) => void>();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <GatekeeperUserPickerDialog
        authenticatedApi={
          { searchUsers, selectGatekeeperUser } as unknown as RpcStub<AuthenticatedApi>
        }
        gatekeeperId="context"
        onComplete={onComplete}
      />,
    ));
    return { searchUsers, selectGatekeeperUser, onComplete, props: () => captured.props as CapturedProps };
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container!.querySelectorAll("button")].find((el) => el.textContent === label
      || el.getAttribute("aria-label") === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }

  it("picks several people in one session, checking eligibility per pick, and hands them over on Done", async () => {
    const alice = fakeSelection();
    const carol = fakeSelection();
    const { searchUsers, selectGatekeeperUser, onComplete, props } =
      await mount({ [ALICE.id]: alice, [CAROL.id]: carol });

    await expect(props().search("a")).resolves.toEqual([ALICE, BOB, CAROL]);
    expect(searchUsers).toHaveBeenCalledWith("a", []);
    expect(selectGatekeeperUser).not.toHaveBeenCalled();

    await act(async () => props().onSelect(ALICE));
    expect(selectGatekeeperUser).toHaveBeenCalledWith("context", ALICE.id);
    expect(container!.querySelector('[aria-label="Selected people"]')?.textContent).toBe("Alice");
    // Already-picked people are excluded from later searches.
    await props().search("b");
    expect(searchUsers).toHaveBeenLastCalledWith("b", [ALICE.id]);

    // An ineligible pick shows a notice and leaves the picked list alone.
    await act(async () => props().onSelect(BOB));
    expect(container!.querySelector('[role="status"]')?.textContent)
      .toBe("Bob doesn't have an account with this service.");
    expect(container!.querySelector('[aria-label="Selected people"]')?.textContent).toBe("Alice");

    await act(async () => props().onSelect(CAROL));
    expect(onComplete).not.toHaveBeenCalled();

    await act(async () => button("Done (2)").click());
    expect(onComplete).toHaveBeenCalledWith([alice, carol]);
    // Ownership moved to the app: nothing was disposed here.
    expect(alice.verifier[Symbol.dispose]).not.toHaveBeenCalled();
    expect(carol.profile[Symbol.dispose]).not.toHaveBeenCalled();
  });

  it("disposes removed picks, and everything still held when the picker is closed", async () => {
    const alice = fakeSelection();
    const carol = fakeSelection();
    const { onComplete, props } = await mount({ [ALICE.id]: alice, [CAROL.id]: carol });

    await act(async () => props().onSelect(ALICE));
    await act(async () => props().onSelect(CAROL));
    await act(async () => button("Remove Alice").click());
    expect(alice.verifier[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(alice.profile[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(carol.verifier[Symbol.dispose]).not.toHaveBeenCalled();

    await act(async () => button("Close person picker").click());
    expect(onComplete).toHaveBeenCalledWith([]);
    expect(carol.verifier[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(carol.profile[Symbol.dispose]).toHaveBeenCalledOnce();
  });
});
