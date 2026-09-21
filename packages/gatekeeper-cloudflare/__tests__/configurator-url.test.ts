// The two configurator UIs build the resource URL that `parseObservabilityResourceUrl` then has to
// accept, but they cannot share the builders in `resources.ts`: each configurator module is
// transpiled on its own by `scripts/build-gatekeeper-configurator.mjs`, which only strips
// `@gadgets/configurator-ui` and type-only imports, so a runtime import would not resolve inside the
// sandboxed frame. The duplication is therefore deliberate, and this test is what keeps the copies
// honest: it runs each configurator's real `resourceUrl` and requires the result to round-trip through
// the server-side parser. A drift on either side -- a changed path segment, a lost `encodeURIComponent`
// -- shows up here rather than as a resource the backend rejects after the user has filled the form.

import { describe, expect, it } from "vitest";
import accountConfigurator from "../src/configurator/cloudflare-account-configurator-ui.js";
import workerConfigurator from "../src/configurator/cloudflare-worker-configurator-ui.js";
import {
  accountObservabilityUrl,
  parseObservabilityResourceUrl,
  workerObservabilityUrl,
} from "../src/resources.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

// The configurators never call `ui` from `resourceUrl`; it is present only to satisfy the context type.
const noUi = new Proxy({}, {
  get() { throw new Error("resourceUrl must not call the ui capability"); },
}) as never;

describe("configurator resource URLs", () => {
  it("builds the same account URL the server-side builder does", () => {
    const url = accountConfigurator.resourceUrl!({ values: { accountId: ACCOUNT_ID }, ui: noUi });

    expect(url).toBe(accountObservabilityUrl(ACCOUNT_ID));
    expect(parseObservabilityResourceUrl(url as string)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("builds the same Worker URL the server-side builder does", () => {
    const values = { accountId: ACCOUNT_ID, workerName: "api-worker" };

    const url = workerConfigurator.resourceUrl!({ values, ui: noUi });

    expect(url).toBe(workerObservabilityUrl(ACCOUNT_ID, "api-worker"));
    expect(parseObservabilityResourceUrl(url as string))
      .toEqual({ accountId: ACCOUNT_ID, workerName: "api-worker" });
  });

  it("round-trips a Worker name that needs URL encoding", () => {
    // Worker names allow characters that change the path's meaning if unescaped. A configurator that
    // dropped `encodeURIComponent` would produce a URL the parser reads as a different resource --
    // potentially a wider one -- so the encoded round-trip is the assertion that matters.
    const workerName = "my worker/production?x=1";

    const url = workerConfigurator.resourceUrl!({
      values: { accountId: ACCOUNT_ID, workerName },
      ui: noUi,
    }) as string;

    expect(url).toBe(workerObservabilityUrl(ACCOUNT_ID, workerName));
    expect(parseObservabilityResourceUrl(url)).toEqual({ accountId: ACCOUNT_ID, workerName });
  });

  it("reports readiness only once the URL it would build is parseable", () => {
    // `isReady` gates the form's submit button, so it must not enable a submission that the backend
    // would then reject.
    expect(accountConfigurator.isReady!({ values: { accountId: null } })).toBe(false);
    expect(workerConfigurator.isReady!({ values: { accountId: ACCOUNT_ID, workerName: null } }))
      .toBe(false);
    expect(workerConfigurator.isReady!({
      values: { accountId: ACCOUNT_ID, workerName: "api-worker" },
    })).toBe(true);
  });
});
