// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import {
  DEFAULT_UI_FEATURE_FLAGS,
  type UiFeatureFlags,
} from "@gadgets/workshop-shared/feature-flags";
import { useAuthenticatedApi } from "./AuthContext";
import { FeatureFlagsProvider, useUiFeatureFlags } from "./FeatureFlagsContext";

vi.mock("./AuthContext", () => ({ useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESOLVED_FLAGS = {
  "test-flag": true,
} as unknown as UiFeatureFlags;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function api(getUiFeatureFlags: () => Promise<UiFeatureFlags>): RpcStub<AuthenticatedApi> {
  return { getUiFeatureFlags } as unknown as RpcStub<AuthenticatedApi>;
}

describe("FeatureFlagsProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("uses defaults while loading and ignores a stale API response", async () => {
    const first = deferred<UiFeatureFlags>();
    const second = deferred<UiFeatureFlags>();
    let currentApi = api(() => first.promise);
    let current: ReturnType<typeof useUiFeatureFlags> | undefined;

    vi.mocked(useAuthenticatedApi).mockImplementation(
      () => ({ authenticatedApi: currentApi }) as ReturnType<typeof useAuthenticatedApi>,
    );

    function Probe() {
      current = useUiFeatureFlags();
      return null;
    }

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<FeatureFlagsProvider><Probe /></FeatureFlagsProvider>));
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    currentApi = api(() => second.promise);
    await act(async () => root!.render(<FeatureFlagsProvider><Probe /></FeatureFlagsProvider>));
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    await act(async () => { first.resolve(RESOLVED_FLAGS); });
    expect(current).toEqual({ flags: DEFAULT_UI_FEATURE_FLAGS, loading: true });

    await act(async () => { second.resolve(RESOLVED_FLAGS); });
    expect(current).toEqual({
      flags: { ...DEFAULT_UI_FEATURE_FLAGS, ...RESOLVED_FLAGS },
      loading: false,
    });
  });
});
