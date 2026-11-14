// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { DropdownMenu } from "@cloudflare/kumo";
import { afterEach, expect, it, vi } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";
import { makeTestRoot } from "../../action-test-harness";
import { ChatNotificationsMenu } from "./ChatNotificationsMenu";

const mock = vi.hoisted(() => ({
  addToast: vi.fn<ReturnType<typeof import("@cloudflare/kumo").useKumoToastManager>["add"]>(),
  logRpcFailure: vi.fn<typeof import("../../rpcErrors").logRpcFailure>(),
}));
vi.mock("../../rpcErrors", () => ({logRpcFailure: mock.logRpcFailure}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: mock.addToast}),
}));

const testRoot = makeTestRoot();
afterEach(() => { testRoot.cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each([
  {enabled: true, override: undefined, label: "Mute notifications", value: false},
  {enabled: false, override: false, label: "Unmute notifications", value: true},
  {enabled: false, override: undefined, label: "Mute notifications", value: false},
  {enabled: false, override: undefined, label: "Enable notifications", value: true},
])("blocks duplicate saves and allows retry after failure ($label, override: $override)", async ({enabled, override, label, value}) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const pending = Promise.withResolvers<void>();
  const setChatNotificationsEnabled = vi.fn<Overseer["setChatNotificationsEnabled"]>()
    .mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  await testRoot.render(
    <DropdownMenu open>
      <DropdownMenu.Trigger render={<button>Chat actions</button>} />
      <DropdownMenu.Content>
        <ChatNotificationsMenu overseer={{setChatNotificationsEnabled}} chatId={7}
          enabled={enabled} override={override} disabled={false} />
      </DropdownMenu.Content>
    </DropdownMenu>,
  );
  const item = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(element => element.textContent === label)!;
  await act(async () => item().click());
  expect(item().getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    for (const element of document.querySelectorAll<HTMLElement>('[role="menuitem"]')) element.click();
  });
  expect(setChatNotificationsEnabled).toHaveBeenCalledExactlyOnceWith(7, value);

  const error = new Error("Preference update failed");
  await act(async () => pending.reject(error));
  expect(mock.addToast).toHaveBeenCalledExactlyOnceWith({title: "Failed to update notifications", variant: "error"});
  expect(mock.logRpcFailure).toHaveBeenCalledExactlyOnceWith("Failed to update chat notifications:", error);
  expect(item().getAttribute("aria-disabled")).toBeNull();
  await act(async () => item().click());
  expect(setChatNotificationsEnabled).toHaveBeenCalledTimes(2);
  expect(setChatNotificationsEnabled).toHaveBeenLastCalledWith(7, value);
  expect(item().getAttribute("aria-disabled")).toBeNull();
  expect(mock.addToast).toHaveBeenCalledOnce();
});
