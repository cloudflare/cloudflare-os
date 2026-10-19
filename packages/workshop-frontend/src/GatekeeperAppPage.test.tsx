// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import GatekeeperAppPage from "./GatekeeperAppPage";

type CapabilityLost = (frame: GatekeeperUiFrame, error: unknown) => void;

const mounted: { frame: GatekeeperUiFrame; onCapabilityLost: CapabilityLost }[] = [];

vi.mock("./SandboxedGatekeeperApp", () => ({
  default: (props: { frame: GatekeeperUiFrame; onCapabilityLost: CapabilityLost }) => {
    mounted.push(props);
    return null;
  },
}));

vi.mock("./errorReporting", () => ({ reportIssue: () => {} }));
vi.mock("./rpcErrors", () => ({ reportDoResetError: () => {} }));

const getGatekeeperApp = vi.fn<(appId: string) => Promise<GatekeeperUiFrame>>();
const authenticatedApi = { getGatekeeperApp };
vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeFrame = () => {
  const dispose = vi.fn();
  return { frame: { iframeHtml: "<!doctype html>", ui: { [Symbol.dispose]: dispose } } as unknown as GatekeeperUiFrame, dispose };
};

describe("GatekeeperAppPage frame recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    mounted.length = 0;
    getGatekeeperApp.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const latest = () => mounted[mounted.length - 1]!;

  it("replaces a frame whose capability was lost, not sooner than 10 s after it was acquired", async () => {
    const first = makeFrame();
    const second = makeFrame();
    getGatekeeperApp.mockResolvedValueOnce(first.frame).mockResolvedValueOnce(second.frame);

    await act(async () => root.render(<GatekeeperAppPage appId="scheduler" />));
    expect(latest().frame).toBe(first.frame);

    // The capability dies 3 s in: the replacement waits for the remainder of the 10 s floor.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    act(() => latest().onCapabilityLost(first.frame, new Error("reset")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_999);
    });
    expect(getGatekeeperApp).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getGatekeeperApp).toHaveBeenCalledTimes(2);
    expect(latest().frame).toBe(second.frame);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("ignores a lost-capability report from a frame that was already replaced", async () => {
    const first = makeFrame();
    const second = makeFrame();
    getGatekeeperApp.mockResolvedValueOnce(first.frame).mockResolvedValueOnce(second.frame);

    await act(async () => root.render(<GatekeeperAppPage appId="scheduler" />));
    act(() => latest().onCapabilityLost(first.frame, new Error("reset")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(latest().frame).toBe(second.frame);

    // The first frame's session is gone but may still emit errors while it is torn down.
    act(() => latest().onCapabilityLost(first.frame, new Error("reset")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getGatekeeperApp).toHaveBeenCalledTimes(2);
  });
});
