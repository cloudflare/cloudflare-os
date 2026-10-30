import type {
  CloudflareNotificationPolicySettings,
  CloudflareNotificationSubscription,
} from "./types.js";

// Cloudflare ANS PolicyFilter schema: https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/create/
const FILTER_KEYS = new Set([
  "actions",
  "affected_asns",
  "affected_components",
  "affected_locations",
  "airport_code",
  "alert_trigger_preferences",
  "alert_trigger_preferences_value",
  "enabled",
  "environment",
  "event",
  "event_source",
  "event_type",
  "group_by",
  "health_check_id",
  "incident_impact",
  "input_id",
  "insight_class",
  "limit",
  "logo_tag",
  "megabits_per_second",
  "new_health",
  "new_status",
  "packets_per_second",
  "pool_id",
  "pop_names",
  "product",
  "project_id",
  "protocol",
  "query_tag",
  "requests_per_second",
  "selectors",
  "services",
  "slo",
  "status",
  "target_hostname",
  "target_ip",
  "target_zone_name",
  "token_id",
  "traffic_exclusions",
  "tunnel_id",
  "tunnel_name",
  "type",
  "where",
  "zones",
]);

/** Validate the narrow agent-controlled surface and return a stable, detached representation. */
export function canonicalNotificationPolicy(
  settings?: CloudflareNotificationPolicySettings,
): CloudflareNotificationPolicySettings {
  if (settings === undefined) return {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid notification policy settings.");
  for (const key of Object.keys(settings)) {
    if (key !== "alertInterval" && key !== "filters")
      throw new Error(`Unsupported notification policy setting: ${key}`);
  }
  const result: CloudflareNotificationPolicySettings = {};
  if (settings.alertInterval !== undefined) {
    if (
      typeof settings.alertInterval !== "string" ||
      settings.alertInterval.trim().length === 0 ||
      settings.alertInterval.length > 100
    )
      throw new Error(
        "Use a nonempty ANS re-alert interval (maximum 100 characters), such as 30m.",
      );
    result.alertInterval = settings.alertInterval;
  }
  if (settings.filters !== undefined) {
    if (
      !settings.filters ||
      typeof settings.filters !== "object" ||
      Array.isArray(settings.filters)
    )
      throw new Error("Invalid notification policy filters.");
    const filters: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(settings.filters).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!FILTER_KEYS.has(key)) throw new Error(`Unsupported ANS filter: ${key}`);
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > 100 ||
        values.some(
          (value) => typeof value !== "string" || value.length === 0 || value.length > 1024,
        )
      )
        throw new Error(
          `ANS filter ${key} must contain 1–100 nonempty strings (maximum 1024 characters each).`,
        );
      if (
        key === "incident_impact" &&
        values.some(
          (value) =>
            ![
              "INCIDENT_IMPACT_NONE",
              "INCIDENT_IMPACT_MINOR",
              "INCIDENT_IMPACT_MAJOR",
              "INCIDENT_IMPACT_CRITICAL",
            ].includes(value),
        )
      )
        throw new Error("Invalid incident impact filter.");
      if (key === "traffic_exclusions" && values.some((value) => value !== "security_events"))
        throw new Error("Invalid traffic exclusion filter.");
      // Preserve array order: the provider does not specify that all arrays are sets.
      filters[key] = [...values];
    }
    if (Object.keys(filters).length) result.filters = filters;
  }
  if (JSON.stringify(result).length > 16_384)
    throw new Error("Notification policy settings are too large.");
  return result;
}

/** Deterministic identity, bounded for Durable Object storage keys and provider ownership markers. */
export async function notificationPolicyIdentity(
  alertType: string,
  settings?: CloudflareNotificationPolicySettings,
): Promise<string | undefined> {
  const canonical = canonicalNotificationPolicy(settings);
  if (Object.keys(canonical).length === 0) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([alertType, canonical])),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Keep the historical key for empty settings so old policies and hooks remain owned. */
export async function notificationPolicyKey(
  alertType: string,
  settings?: CloudflareNotificationPolicySettings,
): Promise<string> {
  const identity = await notificationPolicyIdentity(alertType, settings);
  return identity ? `policy:v2:${identity}` : `policy:${alertType}`;
}

/** Runtime validation also rejects authority-bearing extras ignored by structural RPC types. */
export function validateNotificationSubscription(
  subscription: CloudflareNotificationSubscription,
): CloudflareNotificationPolicySettings {
  if (
    !subscription ||
    typeof subscription.alertType !== "string" ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(subscription.alertType)
  )
    throw new Error("Choose one valid Cloudflare alert type for this hook.");
  for (const key of Object.keys(subscription)) {
    if (!["alertType", "createPolicy", "policy"].includes(key))
      throw new Error(`Unsupported notification subscription setting: ${key}`);
  }
  if (subscription.createPolicy !== undefined && typeof subscription.createPolicy !== "boolean")
    throw new Error("Invalid createPolicy setting.");
  if (subscription.createPolicy === false && subscription.policy !== undefined)
    throw new Error("External notification subscriptions cannot configure a policy.");
  return canonicalNotificationPolicy(subscription.policy);
}
