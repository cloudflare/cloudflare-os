import { describe, expect, it } from "vitest";
import deployed from "../cloudflare.config";

// The first compatibility date at which workerd provides `node:crypto` with no flag.
const NODE_CRYPTO_BY_DATE = "2026-08-04";

// The worker pools turn Node compatibility on themselves, so a test that runs in them imports
// `node:crypto` whatever the deployed worker's settings are. This reads the settings the worker
// is deployed with.
describe("the deployed worker's Node compatibility", () => {
  it("keeps node:crypto importable in the deployed worker", () => {
    const { compatibilityDate, compatibilityFlags = [] } = deployed.worker;

    // ISO dates order as strings.
    expect(
      compatibilityDate >= NODE_CRYPTO_BY_DATE || compatibilityFlags.includes("nodejs_compat"),
    ).toBe(true);
    expect(compatibilityFlags).not.toContain("no_nodejs_compat");
    expect(compatibilityFlags).not.toContain("no_nodejs_compat_v2");
  });
});
