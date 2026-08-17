// The collaborator ACL. `addObserver` is the only thing standing between a shared gadget and another
// user's telemetry, and it had no coverage: the deny path, and the refusal to treat an infrastructure
// failure as a denial, are both asserted here.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WORKER_PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID, workerName: "api-worker" };
const ACCOUNT_PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID };

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
