import { expect, it } from "vitest";
import { canonicalNotificationPolicy, notificationPolicyKey, validateNotificationSubscription } from "../src/notification-policy.js";
import type { CloudflareNotificationSubscription, CloudflareNotificationPolicySettings } from "../src/types.js";

it("canonicalizes object keys, preserves filter array semantics, and keeps historical empty identity", async () => {
  expect(await notificationPolicyKey("incident_alert")).toBe("policy:incident_alert");
  expect(await notificationPolicyKey("incident_alert", { filters: {} })).toBe("policy:incident_alert");
  const first = { filters: { zones: ["a", "b"], services: ["workers"] }, alertInterval: "30m" };
  const same = { alertInterval: "30m", filters: { services: ["workers"], zones: ["a", "b"] } };
  expect(await notificationPolicyKey("test_alert", first)).toBe(await notificationPolicyKey("test_alert", same));
  expect(await notificationPolicyKey("other_alert", first)).not.toBe(await notificationPolicyKey("test_alert", first));
  expect(await notificationPolicyKey("test_alert", { ...first, filters: { ...first.filters, zones: ["b", "a"] } })).not.toBe(await notificationPolicyKey("test_alert", first));
  const canonical = canonicalNotificationPolicy(first);
  first.filters.zones.push("later");
  expect(canonical.filters?.zones).toEqual(["a", "b"]);
  expect((await notificationPolicyKey("test_alert", canonical)).length).toBeLessThan(100);
});

it.each([
  { enabled: true }, { mechanisms: { webhooks: [{ id: "other" }] } }, { description: "claimed ownership" },
  { threshold: 10 }, { alertInterval: "" }, { filters: [] }, { filters: { unknown: ["value"] } },
  { filters: { zones: "a" } }, { filters: { zones: [10] } }, { filters: { zones: [] } },
  { filters: { zones: ["x".repeat(1025)] } }, { filters: { incident_impact: ["critical"] } },
  { filters: { traffic_exclusions: ["all"] } },
])("rejects invalid or authority-bearing settings %j", (settings) => {
  expect(() => canonicalNotificationPolicy(settings as unknown as CloudflareNotificationPolicySettings)).toThrow();
});

it("rejects extra subscription authority and accepts unfamiliar syntactically valid alert types", () => {
  expect(() => validateNotificationSubscription({ alertType: "new_provider_alert", credentials: "token" } as unknown as CloudflareNotificationSubscription)).toThrow("Unsupported");
  expect(validateNotificationSubscription({ alertType: "new_provider_alert", policy: { filters: { zones: ["a"] } } })).toEqual({ filters: { zones: ["a"] } });
});
