import { describe, expect, it } from "vitest";
import {
  isWebhookTest,
  parseNotificationWebhook,
  parseNotificationWebhookPath,
} from "../src/notifications-webhook.js";

const accountId = "a".repeat(32);
const payload = {
  account_id: accountId,
  alert_type: "advanced_ddos_attack_l4_alert",
  ts: 1136214245,
  data: { attack_id: "attack-1" },
  policy_id: "b".repeat(32),
  text: "An attack started",
  alert_correlation_id: "correlation",
  alert_event: "ALERT_STATE_EVENT_START",
};

describe("Cloudflare's documented webhook envelope", () => {
  it("accepts generic notifications without event_id and preserves useful metadata", async () => {
    const result = await parseNotificationWebhook(JSON.stringify(payload), accountId);

    expect(result).toMatchObject({
      accountId,
      alertType: payload.alert_type,
      policyId: payload.policy_id,
      correlationId: "correlation",
      event: payload.alert_event,
      text: payload.text,
      data: payload.data,
    });
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deduplicates identical deliveries but keeps start/end and different policies distinct", async () => {
    const parse = (p: unknown) => parseNotificationWebhook(JSON.stringify(p), accountId);
    const first = await parse(payload);

    expect((await parse(payload)).id).toBe(first.id);
    expect((await parse({ ...payload, alert_event: "ALERT_STATE_EVENT_END" })).id).not.toBe(
      first.id,
    );
    expect((await parse({ ...payload, policy_id: "c".repeat(32) })).id).not.toBe(first.id);
  });

  it("accepts future alert types without treating event_id as globally unique", async () => {
    const event = { ...payload, event_id: "delivery-1", alert_type: "future.product/alert:v2" };
    const first = await parseNotificationWebhook(JSON.stringify(event), accountId);

    expect(first.alertType).toBe("future.product/alert:v2");
    expect((await parseNotificationWebhook(JSON.stringify(event), accountId)).id).toBe(first.id);
    expect(
      (
        await parseNotificationWebhook(
          JSON.stringify({ ...event, policy_id: "c".repeat(32) }),
          accountId,
        )
      ).id,
    ).not.toBe(first.id);
    expect(
      (
        await parseNotificationWebhook(
          JSON.stringify({ ...event, alert_event: "ALERT_STATE_EVENT_END" }),
          accountId,
        )
      ).id,
    ).not.toBe(first.id);
  });

  it.each([
    null,
    [],
    {},
    { ...payload, account_id: "b".repeat(32) },
    { ...payload, ts: -1 },
    { ...payload, ts: 1e100 },
    { ...payload, text: 3 },
    { ...payload, alert_type: "" },
  ])("rejects malformed or foreign payload %#", async (value) => {
    await expect(parseNotificationWebhook(JSON.stringify(value), accountId)).rejects.toThrow();
  });

  it("recognizes tests without mistaking a full notification for a test", () => {
    expect(isWebhookTest({ text: "Hello World!" })).toBe(true);
    expect(isWebhookTest({ test: "unrecognized shape" })).toBe(false);
    expect(isWebhookTest(payload)).toBe(false);
    expect(isWebhookTest({ text: "test", account_id: accountId })).toBe(false);
  });

  it("routes only well-formed connection and account identifiers", () => {
    expect(
      parseNotificationWebhookPath(
        `/gatekeeper/cloudflare/webhooks/${"a".repeat(64)}/${accountId}`,
        "/gatekeeper/cloudflare",
      ),
    ).toEqual({ userObjectId: "a".repeat(64), accountId });
    expect(
      parseNotificationWebhookPath(
        "/gatekeeper/cloudflare/webhooks/nope/account",
        "/gatekeeper/cloudflare",
      ),
    ).toBeNull();
  });
});
