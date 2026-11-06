// Event hooks, end to end inside the gatekeeper worker: a binding subscribes as executeCode would,
// TestHooks enables the hook and answers each firing as the overseer would, and PagerDuty's signed
// webhook deliveries arrive through the worker's own fetch handler.

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOrigin } from "../../src/pagerduty-env";
import type { WireIncident } from "../../src/pagerduty-normalize";
import type { PagerDutySubscribeOptions } from "../../src/types";
import {
  ALICE, BOB, DAVE, FakePagerDuty, OTHER_SERVICE, OTHER_TEAM, SERVICE, TEAM, failure, hooks, seedAccount, sub, unwrap,
  type FakeUser,
} from "./fake-pagerduty";
import type { GatekeeperProps, Step } from "./worker";

const WEBHOOK = "http://localhost:8787/gatekeeper/pagerduty/webhook";
const SECRET = "test-webhook-secret";

/** The hooks a test enabled, disabled after it so later tests' events don't reach them. */
const enabled: string[] = [];

afterEach(async () => {
  for (const hook of enabled.splice(0)) await hooks().disableHook(hook);
  vi.unstubAllGlobals();
});

type Binding = { resourceKind: "account" } | { resourceKind: "team" | "service" | "incident"; id: string };

/** Subscribes a hook through `steps` from a binding of `who`'s, and enables it. */
async function subscribe(pd: FakePagerDuty, binding: Binding, { steps = [], options, who = ALICE }:
                         { steps?: Step[]; options?: PagerDutySubscribeOptions; who?: FakeUser } = {}) {
  const { region, subdomain } = who.account;
  const props = { userObjectId: await seedAccount(pd, who), region, subdomain, ...binding } as GatekeeperProps;
  const hook = crypto.randomUUID();
  const description = unwrap(await hooks().subscribeHook(hook, crypto.randomUUID(), props, steps, options));
  unwrap(await hooks().enableHook(hook));
  enabled.push(hook);
  return { description, read: () => hooks().readHook(hook), disable: () => hooks().disableHook(hook) };
}

const reference = (type: string, id: string, summary: string) =>
  ({ id, type: `${type}_reference`, summary, self: `https://api.pagerduty.com/${type}s/${id}`, html_url: `https://acme.pagerduty.com/${type}s/${id}` });

/** A webhook v3 payload for `eventType` on `incident`, caused by `agent`. */
function webhookEvent(eventType: string, incident: WireIncident, { agent = BOB as FakeUser | null, data = {} as object,
                      occurredAt = new Date().toISOString() } = {}) {
  const ref = { id: incident.id, type: "incident_reference", html_url: incident.html_url, self: `https://api.pagerduty.com/incidents/${incident.id}` };
  return {
    event: {
      id: `01${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`, event_type: eventType, resource_type: "incident",
      occurred_at: occurredAt, agent: agent && reference("user", agent.id, agent.name!), client: null,
      data: Object.keys(data).length > 0 ? { ...data, incident: ref } : {
        ...ref, type: "incident", number: incident.incident_number, status: incident.status, title: incident.title,
        service: reference("service", incident.service.id, incident.service.summary!), urgency: incident.urgency,
      },
    },
  };
}

async function hmac(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Delivers `payload` as PagerDuty does, signed with `signature` (by default, the right one). */
async function deliver(payload: unknown, signature?: string | null): Promise<number> {
  const body = JSON.stringify(payload);
  const signed = signature === undefined ? `v1=${await hmac(body)}` : signature;
  const response = await SELF.fetch(WEBHOOK, {
    method: "POST", body,
    headers: { "Content-Type": "application/json", "X-Webhook-Id": crypto.randomUUID(), ...signed === null ? {} : { "X-PagerDuty-Signature": signed } },
  });
  return response.status;
}

const driver = () => env.PAGERDUTY_HOOK_DRIVER.getByName("webhook");

/** Waits until the driver has no delivery due: its own alarm delivers them. */
const settled = () => vi.waitFor(() => runInDurableObject(driver(), (_instance, state) => {
  const due = [...state.storage.kv.list<{ at?: number }>({ prefix: "msg:" })].filter(([, row]) => row.at !== undefined && row.at <= Date.now());
  if (due.length > 0) throw new Error(`${due.length} deliveries due`);
}), { timeout: 10_000, interval: 25 });

/** Runs the driver's alarm `ms` from now, on a faked clock the runtime itself never wakes it for. */
async function after(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  try {
    await runDurableObjectAlarm(driver());
  } finally {
    vi.useRealTimers();
  }
}

describe("PagerDuty event hooks", () => {
  it("delivers a signed event, re-read as the hook's owner, reporting the account, incident and service", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE, { title: "API down" });
    const hook = await subscribe(pd, { resourceKind: "account" }, { options: { events: ["triggered", "acknowledged"] } });
    expect(hook.description).toEqual({
      title: "Watch PagerDuty incidents on acme.pagerduty.com",
      description: "Call this hook with each triggered, acknowledged event on acme.pagerduty.com that the connected " +
        "user can see, letting it read the incident and queue changes to it for approval.",
    });

    const payload = webhookEvent("incident.triggered", incident);
    expect(await deliver(payload)).toBe(204);
    await settled();

    const { received, observations, firings } = await hook.read();
    expect(firings).toBe(1);
    expect(received).toEqual([{
      id: payload.event.id, kind: "triggered", occurredAt: payload.event.occurred_at,
      actor: { id: BOB.id, name: "Bob", isYou: false },
      info: expect.objectContaining({ id: incident.id, title: "API down", status: "triggered", service: expect.objectContaining({ id: SERVICE.id }) }),
    }]);
    expect(observations.map(o => new Set(o.subresources))).toEqual([new Set([sub(), sub("incident", incident.id), sub("service", SERVICE.id)])]);
    expect(pd.matching("GET", new RegExp(`^/incidents/${incident.id}$`), ALICE.id)).toHaveLength(1);
  });

  it("refuses deliveries that aren't signed with the secret, and accepts any of several signatures", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const hook = await subscribe(pd, { resourceKind: "account" });
    const payload = webhookEvent("incident.triggered", incident);
    const body = JSON.stringify(payload);

    expect(await deliver(payload, null)).toBe(401);
    expect(await deliver(payload, `v1=${"0".repeat(64)}`)).toBe(401);
    expect(await deliver(payload, `v1=${await hmac(body, "another-secret")}`)).toBe(401);
    expect(await deliver(payload, await hmac(body))).toBe(401);
    expect(await deliver({ ...payload, tampered: true }, `v1=${await hmac(body)}`)).toBe(401);
    // Beyond what PagerDuty delivers at all.
    expect(await deliver({ ...payload, padding: "x".repeat(256 * 1024) })).toBe(413);
    await settled();
    expect((await hook.read()).firings).toBe(0);

    // As while PagerDuty rotates the secret: one of the signatures is this deployment's.
    expect(await deliver(payload, `v1=${await hmac(body, "old-secret")}, v1=${await hmac(body)}`)).toBe(204);
    await settled();
    expect((await hook.read()).received.map(({ id }) => id)).toEqual([payload.event.id]);
  });

  it("delivers each event once, however often it arrives, ignores replays of old ones, and stops once disabled", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const hook = await subscribe(pd, { resourceKind: "account" });
    const payload = webhookEvent("incident.acknowledged", incident);
    expect(await deliver(payload)).toBe(204);
    expect(await deliver(payload)).toBe(204);
    expect(await deliver(webhookEvent("incident.resolved", incident, { occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }))).toBe(204);
    expect(await deliver({ event: { id: "PING", event_type: "pagey.ping", occurred_at: new Date().toISOString(), data: {} } })).toBe(204);
    await settled();
    expect((await hook.read()).received.map(({ kind }) => kind)).toEqual(["acknowledged"]);

    await hook.disable();
    expect(await deliver(webhookEvent("incident.resolved", incident))).toBe(204);
    await settled();
    expect((await hook.read()).firings).toBe(1);
  });

  it("fires only the hooks whose binding holds the incident", async () => {
    const pd = new FakePagerDuty().install();
    const api = pd.incident(SERVICE);
    const billing = pd.incident(OTHER_SERVICE);
    const account = await subscribe(pd, { resourceKind: "account" });
    const team = await subscribe(pd, { resourceKind: "team", id: TEAM.id });
    const otherTeam = await subscribe(pd, { resourceKind: "account" }, { steps: [["getTeam", OTHER_TEAM.id]] });
    const service = await subscribe(pd, { resourceKind: "service", id: SERVICE.id });
    const incident = await subscribe(pd, { resourceKind: "incident", id: String(api.incident_number) });
    const teamIncident = await subscribe(pd, { resourceKind: "team", id: TEAM.id }, { steps: [["getIncident", api.id]] });

    expect(await deliver(webhookEvent("incident.triggered", api))).toBe(204);
    expect(await deliver(webhookEvent("incident.triggered", billing))).toBe(204);
    await settled();

    const seen = async (hook: typeof account) => (await hook.read()).received.map(({ info }) => info.id);
    expect(await seen(account)).toEqual(expect.arrayContaining([api.id, billing.id]));
    expect(await seen(team)).toEqual([api.id]);
    expect(await seen(otherTeam)).toEqual([billing.id]);
    expect(await seen(service)).toEqual([api.id]);
    expect(await seen(incident)).toEqual([api.id]);
    expect(await seen(teamIncident)).toEqual([api.id]);
    // A team's deliveries report the team, as its reads do.
    expect((await team.read()).observations.map(o => new Set(o.subresources)))
      .toEqual([new Set([sub(), sub("team", TEAM.id), sub("incident", api.id), sub("service", SERVICE.id)])]);
    expect((await incident.read()).observations.map(o => new Set(o.subresources)))
      .toEqual([new Set([sub(), sub("incident", api.id), sub("service", SERVICE.id)])]);
  });

  it("delivers only what the hook's owner can see", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const alice = await subscribe(pd, { resourceKind: "account" });
    const bob = await subscribe(pd, { resourceKind: "account" }, { who: BOB });
    pd.hide(ALICE.id, incident.id, 404);
    expect(await deliver(webhookEvent("incident.triggered", incident, { agent: ALICE }))).toBe(204);
    await settled();
    expect((await alice.read()).received).toEqual([]);
    expect((await bob.read()).received).toEqual([expect.objectContaining({ kind: "triggered", actor: { id: ALICE.id, name: "Alice", isYou: false } })]);
  });

  it("delivers a note or status update only to the hooks whose binding holds its incident", async () => {
    const pd = new FakePagerDuty().install();
    const billing = pd.incident(OTHER_SERVICE);
    const account = await subscribe(pd, { resourceKind: "account" });
    const team = await subscribe(pd, { resourceKind: "team", id: TEAM.id });
    const service = await subscribe(pd, { resourceKind: "service", id: SERVICE.id });
    // Their payloads name no service, so only the re-read can tell.
    expect(await deliver(webhookEvent("incident.annotated", billing, {
      data: { type: "incident_note", id: "PNOTE01", content: "Rolling back.", trimmed: false },
    }))).toBe(204);
    expect(await deliver(webhookEvent("incident.status_update_published", billing, {
      data: { type: "incident_status_update", id: "PSTAT01", message: "Mitigated.", trimmed: false },
    }))).toBe(204);
    await settled();
    expect((await account.read()).received.map(({ kind }) => kind).toSorted()).toEqual(["noteAdded", "statusUpdatePublished"]);
    expect((await team.read()).received).toEqual([]);
    expect((await service.read()).received).toEqual([]);
  });

  it("delivers only the kinds subscribed to, with a note's or status update's text", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const notes = await subscribe(pd, { resourceKind: "service", id: SERVICE.id }, { options: { events: ["noteAdded", "statusUpdatePublished"] } });
    expect(await deliver(webhookEvent("incident.triggered", incident))).toBe(204);
    expect(await deliver(webhookEvent("incident.annotated", incident, {
      agent: ALICE, data: { type: "incident_note", id: "PNOTE01", content: "Rolling back.", trimmed: false },
    }))).toBe(204);
    expect(await deliver(webhookEvent("incident.status_update_published", incident, {
      agent: null, data: { type: "incident_status_update", id: "PSTAT01", message: "Mitigated.", trimmed: false },
    }))).toBe(204);
    await settled();
    const { received } = await notes.read();
    expect(received.toSorted((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      expect.objectContaining({ kind: "noteAdded", note: "Rolling back.", actor: { id: ALICE.id, name: "Alice", isYou: true } }),
      expect.objectContaining({ kind: "statusUpdatePublished", statusUpdate: "Mitigated.", actor: null }),
    ]);

    const other = new FakePagerDuty();
    const props = { userObjectId: await seedAccount(other), region: "us", subdomain: "acme", resourceKind: "account" } as GatekeeperProps;
    expect(failure(await hooks().subscribeHook(crypto.randomUUID(), crypto.randomUUID(), props, [], { events: [] })))
      .toMatch(/^events must name at least one of triggered, /);
  });

  it("reads a note PagerDuty trimmed in full, and leaves out a trimmed status update", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    pd.notes.set(incident.id, [{ id: "PNOTE01", content: "Rolling back the deploy, in full.", created_at: new Date().toISOString() }]);
    const hook = await subscribe(pd, { resourceKind: "account" }, { options: { events: ["noteAdded", "statusUpdatePublished"] } });
    expect(await deliver(webhookEvent("incident.annotated", incident, {
      data: { type: "incident_note", id: "PNOTE01", content: "Rolling back", trimmed: true },
    }))).toBe(204);
    expect(await deliver(webhookEvent("incident.status_update_published", incident, {
      data: { type: "incident_status_update", id: "PSTAT01", message: "Mitigated", trimmed: true },
    }))).toBe(204);
    await settled();
    const [note, statusUpdate] = (await hook.read()).received.toSorted((a, b) => a.kind.localeCompare(b.kind));
    expect(note).toMatchObject({ kind: "noteAdded", note: "Rolling back the deploy, in full." });
    expect(statusUpdate.kind).toBe("statusUpdatePublished");
    expect(statusUpdate).not.toHaveProperty("statusUpdate");
  });

  it("retries an event the hook failed on", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const hook = await subscribe(pd, { resourceKind: "account" });
    await hooks().failHook(enabled.at(-1)!, 1);
    const payload = webhookEvent("incident.triggered", incident);
    expect(await deliver(payload)).toBe(204);
    await settled();
    expect(await hook.read()).toMatchObject({ firings: 1, received: [] });

    // Past the first retry's backoff, a minute.
    await after(60_000);
    expect(await hook.read()).toMatchObject({ firings: 2, received: [expect.objectContaining({ id: payload.event.id })] });
  });

  it("re-reads an EU account's incident on PagerDuty's EU host", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE, { html_url: "https://euro.eu.pagerduty.com/incidents/1" });
    const hook = await subscribe(pd, { resourceKind: "account" }, { who: DAVE });
    expect(await deliver(webhookEvent("incident.triggered", incident))).toBe(204);
    await settled();
    expect((await hook.read()).received.map(({ info }) => info.id)).toEqual([incident.id]);
    expect(pd.matching("GET", new RegExp(`^/incidents/${incident.id}$`), DAVE.id).map(({ url }) => url.origin))
      .toEqual([apiOrigin("eu")]);
  });

  it("hands the hook a live incident, whose changes queue on the firing", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const hook = await subscribe(pd, { resourceKind: "account" });
    const name = enabled.at(-1)!;
    await hooks().replyHook(name, "Triage bot is looking at this.");
    expect(await deliver(webhookEvent("incident.triggered", incident))).toBe(204);
    await settled();
    const { submitted, received } = await hook.read();
    expect(received).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    // Queued for approval, not sent.
    expect(pd.writes()).toEqual([]);
  });

  it("refuses to subscribe while the deployment has no webhook secret, and the webhook route is inert", async () => {
    const pd = new FakePagerDuty().install();
    const incident = pd.incident(SERVICE);
    const props = { userObjectId: await seedAccount(pd), region: "us", subdomain: "acme", resourceKind: "account" } as GatekeeperProps;
    const shared = env as { PAGERDUTY_WEBHOOK_SECRET?: string };
    delete shared.PAGERDUTY_WEBHOOK_SECRET;
    try {
      expect(failure(await hooks().subscribeHook(crypto.randomUUID(), crypto.randomUUID(), props, []))).toBe(
        "PagerDuty hooks are not configured on this deployment.");
      expect(await deliver(webhookEvent("incident.triggered", incident))).toBe(404);
    } finally {
      shared.PAGERDUTY_WEBHOOK_SECRET = SECRET;
    }
  });
});
