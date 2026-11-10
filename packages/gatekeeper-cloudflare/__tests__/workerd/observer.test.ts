// The collaborator ACL: verifyObserverAccess() for the account every read reports, and
// addObserver(), which still checks each binding as before reads reported one. The deny path, and
// the refusal to treat an infrastructure failure as a denial, are both asserted here.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WORKER_PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID, workerName: "api-worker" };
const ACCOUNT_PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID };
const ACCOUNT_SUBRESOURCE = `account/${ACCOUNT_ID}`;

// Each case gets its own facet name: a facet is cached per name, so reusing one would silently reuse
// the first case's props.
const hooks = env.TEST_HOOKS.getByName("hooks");

describe("addObserver", () => {
  it("admits a collaborator whose own credentials can read the binding", async () => {
    expect(await hooks.addObserver("admit", WORKER_PROPS, true)).toBeNull();
  });

  it("refuses a collaborator whose own credentials cannot", async () => {
    expect(await hooks.addObserver("deny", WORKER_PROPS, false))
      .toMatch(/does not have access to the bound Workers telemetry/);
  });

  it("refuses rather than admits when the verification itself fails", async () => {
    // The dangerous direction: a 5xx or transport failure must not become "allowed". It surfaces as
    // an error, so sharing fails loudly instead of silently granting access.
    const message = await hooks.addObserver("explode", WORKER_PROPS, "verifier exploded");

    expect(message).not.toBeNull();
    expect(message).toContain("verifier exploded");
  });
});

describe("verifyObserverAccess", () => {
  it("allows only observers whose own credentials can read the account, even on a Worker binding", async () => {
    const { result, asked } = await hooks.verifyObserverAccess("verify",
      WORKER_PROPS, { allowed: true, denied: false }, [ACCOUNT_SUBRESOURCE]);

    expect(result).toEqual(["allowed"]);
    // The account itself is asked about, not the binding's Worker.
    expect(asked).toEqual({ allowed: [ACCOUNT_ID], denied: [ACCOUNT_ID] });
  });

  it("fails the whole call when an observer's access cannot be determined", async () => {
    const { result } = await hooks.verifyObserverAccess("verify-explode",
      ACCOUNT_PROPS, { allowed: true, broken: "verifier exploded" }, [ACCOUNT_SUBRESOURCE]);

    expect(result).toContain("verifier exploded");
  });

  it("refuses an ID it never reports without asking anyone", async () => {
    const { result, asked } = await hooks.verifyObserverAccess("verify-unknown", ACCOUNT_PROPS,
      { observer: true }, [ACCOUNT_SUBRESOURCE, `${ACCOUNT_SUBRESOURCE}/worker/${"a".repeat(32)}`]);

    expect(result).toContain("Not a Cloudflare Workers Observability subresource");
    expect(asked).toEqual({ observer: [] });
  });
});

describe("resource description", () => {
  it("describes a Worker binding with its Worker-scoped dashboard URL", async () => {
    const described = await hooks.describeResource("describe-worker", WORKER_PROPS);

    expect(described.url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api-worker/production/observability`);
    expect(described.title).toBe("api-worker observability");
    expect(described.suggestedBindingName).toBe("WORKER_OBSERVABILITY");
  });

  it("describes an account binding with the account-wide URL", async () => {
    const described = await hooks.describeResource("describe-account", ACCOUNT_PROPS);

    expect(described.url)
      .toBe(`https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages/observability`);
    expect(described.title).toBe("Workers Observability");
    expect(described.suggestedBindingName).toBe("CLOUDFLARE_OBSERVABILITY");
  });
});

describe("read-only enforcement", () => {
  it("refuses to apply an action", async () => {
    expect(await hooks.applyActionMessage("apply", WORKER_PROPS)).toContain("read-only");
  });
});
