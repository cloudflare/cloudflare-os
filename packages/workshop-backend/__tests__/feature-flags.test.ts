import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UI_FEATURE_FLAGS,
  DEV_UI_FEATURE_FLAGS,
  UI_FEATURE_FLAGS,
} from "@gadgets/workshop-shared/feature-flags";
import { resolveUiFeatureFlags } from "../src/feature-flags.js";

const TEST_USER_ID = "test-user";

describe("resolveUiFeatureFlags", () => {
  it("uses default values when Flagship is not configured", async () => {
    await expect(resolveUiFeatureFlags({}, TEST_USER_ID)).resolves.toEqual(DEFAULT_UI_FEATURE_FLAGS);
  });

  it("uses development values without evaluating Flagship", async () => {
    const getBooleanValue = vi.fn();
    const env = { DEV: true, FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(DEV_UI_FEATURE_FLAGS);
    expect(getBooleanValue).not.toHaveBeenCalled();
  });

  it("evaluates every registered flag with its key, default, and user ID", async () => {
    const getBooleanValue = vi.fn().mockResolvedValue(true);
    const env = { FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(
      Object.fromEntries(UI_FEATURE_FLAGS.map((flag) => [flag.key, true])),
    );
    expect(getBooleanValue).toHaveBeenCalledTimes(UI_FEATURE_FLAGS.length);
    for (const flag of UI_FEATURE_FLAGS) {
      expect(getBooleanValue).toHaveBeenCalledWith(
        flag.key,
        flag.default,
        { userId: TEST_USER_ID },
      );
    }
  });

  it("uses a flag default when evaluation throws", async () => {
    const getBooleanValue = vi.fn().mockRejectedValue(new Error("Flagship unavailable"));
    const env = { FLAGS: { getBooleanValue } };

    await expect(resolveUiFeatureFlags(env, TEST_USER_ID)).resolves.toEqual(DEFAULT_UI_FEATURE_FLAGS);
  });
});
