import { describe, expect, it } from "vitest";
import {
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
  accountObservabilityUrl,
  grantedObservabilityResourcePatterns,
  observabilityScopesForResources,
  observabilitySubresourceId,
  parseObservabilityResourceUrl,
  parseObservabilitySubresourceId,
  workerObservabilityUrl,
} from "../src/resources";
import { BILLING_SCOPES, persistentScopesForResources } from "../src/oauth";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WORKER_ID = "fedcba9876543210fedcba9876543210";

describe("Cloudflare observability resources", () => {
  it("round-trips account observability URLs", () => {
    const url = accountObservabilityUrl(ACCOUNT_ID);

    expect(url).toBe(`https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages/observability`);
    expect(parseObservabilityResourceUrl(url)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("round-trips Worker observability URLs", () => {
    const url = workerObservabilityUrl(ACCOUNT_ID, "api/production");

    expect(url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api%2Fproduction/production/observability`,
    );
    expect(parseObservabilityResourceUrl(url)).toEqual({
      accountId: ACCOUNT_ID,
      workerName: "api/production",
    });
  });

  it("accepts harmless dashboard state and a trailing slash", () => {
    expect(parseObservabilityResourceUrl(
      `${accountObservabilityUrl(ACCOUNT_ID)}/?time-window=1h#logs`,
    )).toEqual({ accountId: ACCOUNT_ID });
  });

  it("rejects lookalike dashboard URLs", () => {
    expect(() => parseObservabilityResourceUrl(
      "https://example.com/account-id/workers-and-pages/observability",
    )).toThrow("Unsupported Cloudflare observability URL");
    expect(() => parseObservabilityResourceUrl(
      "https://dash.cloudflare.com/account-id/workers/services/view/api/production/metrics",
    )).toThrow("Unsupported Cloudflare observability URL");
  });

  it("rejects malformed account IDs and URL encoding", () => {
    expect(() => accountObservabilityUrl("account-id")).toThrow("account ID");
    expect(() => parseObservabilityResourceUrl(
      "https://dash.cloudflare.com/%EA/workers-and-pages/observability",
    )).toThrow("Unsupported Cloudflare observability URL");
  });
});

describe("Cloudflare observability subresource IDs", () => {
  it("round-trips an account and a Worker within it", () => {
    const account = observabilitySubresourceId(ACCOUNT_ID);
    const worker = observabilitySubresourceId(ACCOUNT_ID, WORKER_ID);

    expect(account).toBe(`account/${ACCOUNT_ID}`);
    expect(worker).toBe(`account/${ACCOUNT_ID}/worker/${WORKER_ID}`);
    expect(parseObservabilitySubresourceId(account)).toEqual({ accountId: ACCOUNT_ID });
    expect(parseObservabilitySubresourceId(worker)).toEqual({ accountId: ACCOUNT_ID, workerId: WORKER_ID });
  });

  it("names an account by one spelling however its ID was entered", () => {
    // Requirements are deduplicated and indexed by the ID string, so two spellings of one account
    // would be two resources an observer must be granted separately.
    expect(observabilitySubresourceId(ACCOUNT_ID.toUpperCase())).toBe(`account/${ACCOUNT_ID}`);
  });

  it("refuses every ID it would not have made", () => {
    // Read back from an observation, an ID is untrusted input: anything other than the canonical
    // spelling is refused rather than read as some nearby account or Worker.
    for (const id of [
      `account/${ACCOUNT_ID.toUpperCase()}`,
      `observability/account/${ACCOUNT_ID}`,
      `account/${ACCOUNT_ID}/worker/${WORKER_ID}/version/1`,
      `accounts/${ACCOUNT_ID}`,
      `account/${ACCOUNT_ID}/script/${WORKER_ID}`,
      `account/${ACCOUNT_ID}/worker/api-worker`,
      `account/${ACCOUNT_ID}/worker/${WORKER_ID.toUpperCase()}`,
      `%61ccount/${ACCOUNT_ID}`,
    ]) {
      expect(() => parseObservabilitySubresourceId(id), id).toThrow();
    }
  });

  it("refuses to name a Worker by anything but its ID", () => {
    // A name can pass to another Worker; the ID cannot.
    expect(() => observabilitySubresourceId(ACCOUNT_ID, "api-worker")).toThrow("Worker ID");
  });
});

describe("Cloudflare observability OAuth scopes", () => {
  it("keeps billing-only connections free of observability access", () => {
    expect(persistentScopesForResources([])).toEqual(BILLING_SCOPES);
    expect(persistentScopesForResources()).toEqual(expect.arrayContaining([
      ...BILLING_SCOPES, "workers-observability.read", "workers-tail.read",
    ]));
  });

  it("does not request observability for an explicit empty resource list", () => {
    expect(observabilityScopesForResources([])).toEqual([]);
  });

  it("requests Worker metadata only for a Worker binding", () => {
    // `workers-tail.read` also allows tailing live logs, so an account-only connection, which never
    // needs to resolve a Worker, is not asked for it.
    expect(observabilityScopesForResources([ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern]))
      .toEqual(["workers-observability.read"]);
    expect(observabilityScopesForResources([WORKER_OBSERVABILITY_RESOURCE.urlPattern]))
      .toEqual(["workers-observability.read", "workers-tail.read"]);
    expect(observabilityScopesForResources([
      ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern, WORKER_OBSERVABILITY_RESOURCE.urlPattern,
    ])).toEqual(["workers-observability.read", "workers-tail.read"]);
  });

  it("treats an omitted resource list as all supported resources", () => {
    expect(observabilityScopesForResources())
      .toEqual(["workers-observability.read", "workers-tail.read"]);
  });

  it("rejects unknown resource patterns", () => {
    expect(() => observabilityScopesForResources(["https://example.com/*"]))
      .toThrow("Unsupported Cloudflare resource type");
  });

  it("maps granted scopes back to the resource types they allow", () => {
    expect(grantedObservabilityResourcePatterns(["workers-observability.read", "workers-tail.read"]))
      .toEqual([
        ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern,
        WORKER_OBSERVABILITY_RESOURCE.urlPattern,
      ]);
    // A connection granted telemetry before Worker bindings needed Worker metadata: it cannot
    // resolve a Worker, so connecting one must ask for the missing scope rather than short-circuit.
    expect(grantedObservabilityResourcePatterns(["workers-observability.read"]))
      .toEqual([ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern]);
    expect(grantedObservabilityResourcePatterns(["workers-tail.read"])).toEqual([]);
    expect(grantedObservabilityResourcePatterns([])).toEqual([]);
  });
});
