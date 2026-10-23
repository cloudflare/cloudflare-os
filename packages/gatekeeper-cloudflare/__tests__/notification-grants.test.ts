import { expect, it } from "vitest";
import { BILLING_SCOPES, AUTH_SCOPES, persistentScopesForResources } from "../src/oauth.js";
import {
  NOTIFICATIONS_RESOURCE,
  NOTIFICATIONS_SCOPE,
  ACCOUNT_OBSERVABILITY_RESOURCE,
  grantedCloudflareResourcePatterns,
} from "../src/resources.js";
it("does not give billing or sign-in accounts notifications", () => {
  expect(persistentScopesForResources([])).toEqual(BILLING_SCOPES);
  expect(AUTH_SCOPES).not.toContain(NOTIFICATIONS_SCOPE);
  expect(grantedCloudflareResourcePatterns(BILLING_SCOPES)).toEqual([]);
});
it("requests independent resources and accurately describes partial grants", () => {
  // Verified against Cloudflare's live OAuth consent flow; the colon spelling is rejected.
  expect(NOTIFICATIONS_SCOPE).toBe("notifications.write");
  expect(persistentScopesForResources([NOTIFICATIONS_RESOURCE.urlPattern])).toEqual([
    ...BILLING_SCOPES,
    NOTIFICATIONS_SCOPE,
  ]);
  expect(persistentScopesForResources([ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern])).not.toContain(
    NOTIFICATIONS_SCOPE,
  );
  expect(grantedCloudflareResourcePatterns([NOTIFICATIONS_SCOPE])).toEqual([
    NOTIFICATIONS_RESOURCE.urlPattern,
  ]);
  expect(persistentScopesForResources()).toContain(NOTIFICATIONS_SCOPE);
  expect(() => persistentScopesForResources(["https://evil.example/*"])).toThrow();
});
